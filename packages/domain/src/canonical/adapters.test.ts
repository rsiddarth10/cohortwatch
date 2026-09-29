import { describe, expect, it } from 'vitest';
import { oemById } from '../catalog.js';
import { toAurexV1, toAurexV2, toKestrel } from '../formats/index.js';
import { DEFAULT_MESS, messUp, type MessContext } from '../mess.js';
import { DEFAULT_PARAMS } from '../params.js';
import { generateRegistry } from '../registry.js';
import { FleetStream, makeWorldContext, type SimEvent } from '../simulate.js';
import { HOUR_MS } from '../time.js';
import { DecodeError, decodeRaw, detectShape } from './adapters.js';
import { CanonicalEventSchema, eventId, type CanonicalEvent } from './event.js';
import { validateEvent } from './validate.js';

const T0 = Date.parse('2026-09-28T04:00:00Z');
const reg = generateRegistry('adapter-test', 500, T0, DEFAULT_PARAMS);
// Real simulator output: every event type, EV/diesel/hybrid, parked and driving.
const events: SimEvent[] = new FleetStream(reg.vehicles, makeWorldContext(reg, DEFAULT_PARAMS), T0).drainUntil(
  T0 + 24 * HOUR_MS,
);
const isAurex = (e: SimEvent) => oemById(e.oemId).code === 'AUREX';

/** The canonical event must carry the simulator's values, allowing only each format's rounding. */
function expectMatches(c: CanonicalEvent, e: SimEvent, tolC: number): void {
  expect(c.vin).toBe(e.vin);
  expect(c.seq).toBe(e.seq);
  expect(c.event_ts).toBe(new Date(e.eventTs).toISOString());
  expect(c.evt).toBe(e.evt);
  expect(c.event_id).toBe(eventId(e.vin, e.seq));
  expect(c.lat).toBeCloseTo(e.lat, 4);
  expect(c.lon).toBeCloseTo(e.lon, 4);
  expect(Math.abs(c.speed_kmh! - e.speedKmh)).toBeLessThanOrEqual(0.051);
  expect(Math.abs(c.odo_km! - e.odoKm)).toBeLessThanOrEqual(0.0006);
  expect(Math.abs(c.ambient_c! - e.ambientC)).toBeLessThanOrEqual(tolC);
  const near = (a: number | null, b: number | null, tol: number) => {
    if (b === null) expect(a).toBeNull();
    else expect(Math.abs(a! - b)).toBeLessThanOrEqual(tol);
  };
  near(c.coolant_c, e.coolantC, tolC);
  near(c.batt_temp_c, e.battTempC, tolC);
  near(c.soc_pct, e.socPct, 0.051);
  near(c.fuel_pct, e.fuelPct, 0.051);
  expect(Math.abs(c.lv_batt_v! - e.lvBattV)).toBeLessThanOrEqual(0.0051);
  expect(c.ignition).toBe(e.ignition);
  expect(c.charging).toBe(e.charging);
  expect(c.idle_s).toBe(e.idleS);
  expect(c.dtc).toEqual(e.dtc);
  expect(c.firmware).toBe(e.firmware);
}

describe('OEM adapters: round trip through the simulator encoders', { timeout: 30_000 }, () => {
  it('has a realistic mix to test', () => {
    expect(events.length).toBeGreaterThan(8_000);
    expect(new Set(events.map((e) => e.evt)).size).toBe(9);
    expect(events.some((e) => e.socPct !== null) && events.some((e) => e.coolantC !== null)).toBe(true);
    expect(events.some((e) => e.dtc.length > 0)).toBe(true);
    expect(events.filter(isAurex).length).toBeGreaterThan(2000);
    expect(events.filter((e) => !isAurex(e)).length).toBeGreaterThan(2000);
  });

  it('aurex.v1 (°F) decodes to the same values in °C', () => {
    for (const e of events.filter(isAurex)) {
      const c = decodeRaw(JSON.stringify(toAurexV1(e)));
      expect(c.source_format).toBe('aurex.v1');
      // v1 rounds °F to 0.1, i.e. at most 0.028 °C, plus the canonical 0.01 °C rounding
      expectMatches(c, e, 0.04);
      expect(c.rpm).toBe(e.rpm);
      expect(c.harsh_brake).toBeNull();
    }
  });

  it('aurex.v2 (°C, renamed fields) decodes to the same values', () => {
    for (const e of events.filter(isAurex)) {
      const c = decodeRaw(JSON.stringify(toAurexV2(e)));
      expect(c.source_format).toBe('aurex.v2');
      expectMatches(c, e, 0.051);
    }
  });

  it('aurex v1 and v2 of the same reading are translated identically (up to °F rounding)', () => {
    for (const e of events.filter(isAurex).slice(0, 2000)) {
      const a = decodeRaw(JSON.stringify(toAurexV1(e)));
      const b = decodeRaw(JSON.stringify(toAurexV2(e)));
      expect({ ...a, source_format: '', coolant_c: 0, batt_temp_c: 0, ambient_c: 0 }).toEqual({
        ...b,
        source_format: '',
        coolant_c: 0,
        batt_temp_c: 0,
        ambient_c: 0,
      });
      if (b.coolant_c !== null) expect(Math.abs(a.coolant_c! - b.coolant_c)).toBeLessThanOrEqual(0.1);
    }
  });

  it('kestrel (epoch ms, SoC 0–1, pipe-joined codes, absent keys) decodes to the same values', () => {
    for (const e of events.filter((x) => !isAurex(x))) {
      const c = decodeRaw(JSON.stringify(toKestrel(e)));
      expect(c.source_format).toBe('kestrel.v1');
      expectMatches(c, e, 0.051);
      expect(c.rpm).toBeNull(); // Kestrel does not report rpm
      expect(c.harsh_brake).toBe(e.harshBrake);
      expect(c.harsh_accel).toBe(e.harshAccel);
    }
  });

  it('every decoded clean event satisfies the canonical schema after validation', () => {
    for (const e of events.slice(0, 5000)) {
      const raw = isAurex(e) ? toAurexV2(e) : toKestrel(e);
      const v = validateEvent(decodeRaw(JSON.stringify(raw)));
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(CanonicalEventSchema.safeParse(v.event).success).toBe(true);
        expect(v.event.quality_flags).toEqual([]);
      }
    }
  });
});

describe('shape detection and typed errors', { timeout: 30_000 }, () => {
  const e = events.find(isAurex)!;

  it('detects each format from its keys, not from any header', () => {
    expect(detectShape(toAurexV1(e))).toBe('aurex.v1');
    expect(detectShape(toAurexV2(e))).toBe('aurex.v2');
    expect(detectShape(toKestrel(e))).toBe('kestrel.v1');
  });

  const code = (text: string) => {
    try {
      decodeRaw(text);
      return 'OK';
    } catch (err) {
      expect(err).toBeInstanceOf(DecodeError);
      return (err as DecodeError).code;
    }
  };

  it('malformed JSON → MALFORMED_JSON', () => {
    expect(code('{"id":"7KSHM1D84RK1')).toBe('MALFORMED_JSON');
    expect(code('')).toBe('MALFORMED_JSON');
  });

  it('an unrecognised object, array or scalar → UNKNOWN_SHAPE', () => {
    expect(code('{"hello":"world","temp":20}')).toBe('UNKNOWN_SHAPE');
    expect(code('[1,2,3]')).toBe('UNKNOWN_SHAPE');
    expect(code('42')).toBe('UNKNOWN_SHAPE');
    expect(code('null')).toBe('UNKNOWN_SHAPE');
  });

  it('a known shape with a missing or mistyped required field → SCHEMA_INVALID, naming the field', () => {
    const k = toKestrel(e) as unknown as Record<string, unknown>;
    const missing = { ...k };
    delete missing.sq;
    expect(code(JSON.stringify(missing))).toBe('SCHEMA_INVALID');
    expect(() => decodeRaw(JSON.stringify(missing))).toThrow(/sq/);
    expect(code(JSON.stringify({ ...k, ts: 'yesterday' }))).toBe('SCHEMA_INVALID');
    expect(code(JSON.stringify({ ...k, e: 'ZZ' }))).toBe('SCHEMA_INVALID');
    expect(code(JSON.stringify({ ...k, ig: true }))).toBe('SCHEMA_INVALID');
    expect(code(JSON.stringify({ ...k, g: [1] }))).toBe('SCHEMA_INVALID');
    const v1 = toAurexV1(e) as unknown as Record<string, unknown>;
    expect(code(JSON.stringify({ ...v1, t: 'not a time' }))).toBe('SCHEMA_INVALID');
    expect(code(JSON.stringify({ ...v1, evt: 'TELEPORT' }))).toBe('SCHEMA_INVALID');
    expect(code(JSON.stringify({ ...v1, codes: 'P0217' }))).toBe('SCHEMA_INVALID');
    const v2 = toAurexV2(e) as unknown as Record<string, unknown>;
    const noVehicle = { ...v2 };
    delete noVehicle.vehicle;
    expect(code(JSON.stringify(noVehicle))).toBe('SCHEMA_INVALID');
  });

  it('every message the mess injector produces either decodes or fails with a DecodeError (never crashes)', () => {
    const ctx: MessContext = {
      seed: reg.seed,
      epochMs: reg.epochMs,
      cfg: { ...DEFAULT_MESS, malformedRate: 0.2, invalidVinRate: 0.05, unknownDtcRate: 0.05, impossibleRate: 0.05 },
      enabled: true,
      aurexV2FromMs: T0 + 12 * HOUR_MS,
    };
    const counts: Record<string, number> = {};
    for (const m of events.slice(0, 8_000).flatMap((x) => messUp(x, ctx))) {
      const c = code(m.value);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    expect(counts.OK).toBeGreaterThan(5_000);
    expect(counts.MALFORMED_JSON).toBeGreaterThan(0);
    expect(counts.SCHEMA_INVALID).toBeGreaterThan(0);
    expect(counts.UNKNOWN_SHAPE ?? 0).toBe(0); // the mess keeps the OEM shape
  });
});
