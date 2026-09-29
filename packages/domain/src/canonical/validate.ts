import { FAULT_CODES, type FaultFamily } from '../catalog.js';
import { isValidVin } from '../vin.js';
import { flag, type CanonicalEvent } from './event.js';

/**
 * Validation (S2). Rules of thumb:
 * - An invalid VIN rejects the event (it cannot be attributed to a vehicle) → DLQ INVALID_VIN.
 * - Everything else keeps the event: a bad field is nulled and flagged, a bad code is dropped and flagged.
 * Detection (S3) decides what flagged readings mean; the normaliser never guesses a value.
 */

// ---- DTC → fault family ---------------------------------------------------------------------------

/** OBD-II style: system letter, 0-3, three hex digits (upper case). */
export const DTC_REGEX = /^[PCBU][0-3][0-9A-F]{3}$/;

const FAMILY_BY_CODE = new Map<string, FaultFamily>(
  (Object.entries(FAULT_CODES) as [FaultFamily, readonly string[]][]).flatMap(([fam, codes]) =>
    codes.map((c) => [c, fam] as [string, FaultFamily]),
  ),
);

/** Family for a valid code: exact table first; any other valid code is OTHER (never guessed from a prefix). */
export function faultFamilyOf(code: string): FaultFamily | 'OTHER' {
  return FAMILY_BY_CODE.get(code) ?? 'OTHER';
}

// ---- Physical ranges ------------------------------------------------------------------------------

type RangedField =
  | 'lat'
  | 'lon'
  | 'speed_kmh'
  | 'odo_km'
  | 'ambient_c'
  | 'coolant_c'
  | 'rpm'
  | 'batt_temp_c'
  | 'soc_pct'
  | 'fuel_pct'
  | 'lv_batt_v'
  | 'idle_s';

export interface ValidationConfig {
  /** Inclusive physical limits; outside → field nulled + OUT_OF_RANGE:<field>. */
  ranges: Record<RangedField, readonly [number, number]>;
}

export const DEFAULT_VALIDATION: ValidationConfig = {
  ranges: {
    lat: [-90, 90],
    lon: [-180, 180],
    speed_kmh: [0, 200],
    odo_km: [0, 2_000_000],
    ambient_c: [-50, 60],
    coolant_c: [-40, 150],
    rpm: [0, 8000],
    batt_temp_c: [-40, 90],
    soc_pct: [0, 100],
    fuel_pct: [0, 100],
    lv_batt_v: [6, 18],
    idle_s: [0, 86_400],
  },
};

export type ValidationResult = { ok: true; event: CanonicalEvent } | { ok: false; code: 'INVALID_VIN'; detail: string };

/** Stateless checks: VIN, ranges, DTCs. Returns a new event; the input is not modified. */
export function validateEvent(ev: CanonicalEvent, cfg: ValidationConfig = DEFAULT_VALIDATION): ValidationResult {
  if (!isValidVin(ev.vin)) return { ok: false, code: 'INVALID_VIN', detail: `invalid VIN "${ev.vin}"` };
  const out: CanonicalEvent = { ...ev, quality_flags: [...ev.quality_flags] };
  for (const [field, [lo, hi]] of Object.entries(cfg.ranges) as [RangedField, readonly [number, number]][]) {
    const v = out[field];
    if (v !== null && (v < lo || v > hi)) {
      out[field] = null;
      out.quality_flags.push(flag('OUT_OF_RANGE', field));
    }
  }
  const dtc: string[] = [];
  const families: CanonicalEvent['fault_families'] = [];
  for (const code of ev.dtc) {
    if (DTC_REGEX.test(code)) {
      dtc.push(code);
      families.push(faultFamilyOf(code));
    } else {
      out.quality_flags.push(flag('INVALID_DTC'));
    }
  }
  out.dtc = dtc;
  out.fault_families = families;
  return { ok: true, event: out };
}

// ---- Impossible jumps (needs the previous reading of the same VIN) ---------------------------------

/** The newest accepted reading of a VIN: what jump checks compare against. */
export interface LastReading {
  seq: number;
  odoKm: number | null;
  socPct: number | null;
  /** Whether that reading was taken while driving (ignition on, moving, not charging). */
  driving: boolean;
}

/** SoC must rise by more than this (percentage points) while driving to count as impossible. */
export const SOC_RISE_TOLERANCE_PCT = 0.5;
/** Odometer rounding tolerance (km). */
export const ODO_TOLERANCE_KM = 0.01;

/**
 * Compare a reading with the VIN's newest earlier reading. Only readings newer than `prev` are compared
 * (a late reading is older than prev, so a lower odometer is expected). A flagged value is nulled and
 * NOT carried into the next state, so one glitch does not make the following good reading look wrong.
 *
 * SoC rising is only impossible between two consecutive driving readings of a van without a running engine
 * (no coolant signal): a hybrid's engine recharges its battery, and an EV charges while parked between trips.
 */
export function checkJumps(
  prev: LastReading | undefined,
  ev: CanonicalEvent,
): { event: CanonicalEvent; next: LastReading | undefined } {
  if (prev && ev.seq <= prev.seq) return { event: ev, next: prev };
  const out: CanonicalEvent = { ...ev, quality_flags: [...ev.quality_flags] };
  if (prev?.odoKm != null && out.odo_km !== null && out.odo_km < prev.odoKm - ODO_TOLERANCE_KM) {
    out.odo_km = null;
    out.quality_flags.push(flag('ODOMETER_BACKWARDS'));
  }
  const driving = out.ignition && !out.charging && (out.speed_kmh ?? 0) > 0;
  const noEngine = out.coolant_c === null;
  if (
    driving &&
    noEngine &&
    prev?.driving &&
    prev.socPct !== null &&
    out.soc_pct !== null &&
    out.soc_pct > prev.socPct + SOC_RISE_TOLERANCE_PCT
  ) {
    out.soc_pct = null;
    out.quality_flags.push(flag('SOC_RISING_WHILE_DRIVING'));
  }
  const next: LastReading = {
    seq: out.seq,
    odoKm: out.odo_km ?? prev?.odoKm ?? null,
    socPct: out.soc_pct ?? prev?.socPct ?? null,
    driving,
  };
  return { event: out, next };
}

// ---- Clock skew -----------------------------------------------------------------------------------

/** A reading more than this far ahead of the time implied by its ingest time is flagged CLOCK_SKEW. */
export const DEFAULT_SKEW_MS = 2 * 60_000;

/**
 * Maps ingest time (the Kafka record timestamp, wall clock) into event time, so a reading's event time can be
 * compared with "now" without mixing the two clocks: expected event time = offset + speed × ingest, where
 * `speed` is configured (1 in production; the simulator's speed, e.g. 360, in demo) and `offset` is the median
 * of (event_ts − speed × ingest) over recent readings. The median ignores the few skewed vans and the
 * late/out-of-order readings, and needs no knowledge of how dense the stream is.
 */
export class IngestClock {
  private readonly offsets: number[] = [];
  private next = 0;
  private sincePush = 0;
  private cached: number | null = null;

  constructor(
    readonly speed = 1,
    private readonly size = 512,
    private readonly every = 64,
  ) {}

  push(eventTsMs: number, ingestMs: number): void {
    const d = eventTsMs - this.speed * ingestMs;
    if (this.offsets.length < this.size) this.offsets.push(d);
    else this.offsets[this.next] = d;
    this.next = (this.next + 1) % this.size;
    if (++this.sincePush >= this.every) {
      const s = [...this.offsets].sort((x, y) => x - y);
      this.cached = s[Math.floor(s.length / 2)]!;
      this.sincePush = 0;
    }
  }

  /** Event time a reading ingested at `ingestMs` should carry, or null until `every` readings were seen. */
  expected(ingestMs: number): number | null {
    return this.cached === null ? null : this.cached + this.speed * ingestMs;
  }

  /** True when the reading is more than `thresholdMs` ahead of the time its ingest implies. */
  isAhead(eventTsMs: number, ingestMs: number, thresholdMs = DEFAULT_SKEW_MS): boolean {
    const e = this.expected(ingestMs);
    return e !== null && eventTsMs - e > thresholdMs;
  }
}
