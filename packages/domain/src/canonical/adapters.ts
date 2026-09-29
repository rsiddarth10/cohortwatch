import { KESTREL_EVENT_CODES } from '../formats/kestrel.js';
import { EVENT_TYPES, eventId, type CanonicalEvent, type SourceFormat } from './event.js';

/**
 * OEM adapters (S2): raw payload text → canonical event (before validation).
 * The shape is detected from the payload itself (a marker-key fingerprint), never from the
 * x-source-format header, so a mislabelled or switched feed (Aurex v1 → v2 at T0+12 h) still decodes.
 */

export type DecodeErrorCode = 'MALFORMED_JSON' | 'UNKNOWN_SHAPE' | 'SCHEMA_INVALID';

export class DecodeError extends Error {
  constructor(
    readonly code: DecodeErrorCode,
    detail: string,
  ) {
    super(detail);
    this.name = 'DecodeError';
  }
}

/** Keys that identify each format. A payload belongs to the format with the most markers present (≥ 60%). */
const MARKERS: Record<SourceFormat, readonly string[]> = {
  'aurex.v1': ['vehicle', 't', 'n', 'evt', 'pos', 'spd', 'odo', 'eng', 'batt', 'elec', 'amb', 'sw', 'ign', 'chg'],
  'aurex.v2': [
    'vehicle',
    'time',
    'seqNo',
    'event',
    'position',
    'speedKmh',
    'odometerKm',
    'engine',
    'battery',
    'electrical',
    'ambientC',
    'software',
    'ignition',
    'charging',
  ],
  'kestrel.v1': ['id', 'ts', 'sq', 'e', 'g', 's', 'o', 'v', 'a', 'dtc', 'fw', 'ig', 'ch', 'hb', 'ha', 'idl'],
};
const MIN_MARKER_SHARE = 0.6;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

const MARKER_LIST = Object.entries(MARKERS) as [SourceFormat, readonly string[]][];

export function detectShape(body: unknown): SourceFormat {
  if (!isObj(body)) throw new DecodeError('UNKNOWN_SHAPE', 'payload is not a JSON object');
  let best: SourceFormat | null = null;
  let bestShare = 0;
  for (const [fmt, keys] of MARKER_LIST) {
    let hits = 0;
    for (const k of keys) if (k in body) hits++;
    const share = hits / keys.length;
    if (share > bestShare) [best, bestShare] = [fmt, share];
  }
  if (!best || bestShare < MIN_MARKER_SHARE) {
    throw new DecodeError('UNKNOWN_SHAPE', `no format matches keys [${Object.keys(body).slice(0, 12).join(',')}]`);
  }
  return best;
}

// Field readers: throw SCHEMA_INVALID naming the path, so the DLQ reason is specific.
// Paths are split once and cached: these run ~20 times per event on the normaliser's hot path.
const PATHS = new Map<string, string[]>();
function get(o: Obj, path: string): unknown {
  let parts = PATHS.get(path);
  if (!parts) PATHS.set(path, (parts = path.split('.')));
  let cur: unknown = o;
  for (const p of parts) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}
const bad = (path: string, want: string) => new DecodeError('SCHEMA_INVALID', `${path}: expected ${want}`);
function reqNum(o: Obj, path: string): number {
  const v = get(o, path);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(path, 'number');
  return v;
}
function optNum(o: Obj, path: string): number | null {
  const v = get(o, path);
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(path, 'number or null');
  return v;
}
function reqStr(o: Obj, path: string): string {
  const v = get(o, path);
  if (typeof v !== 'string') throw bad(path, 'string');
  return v;
}
function reqBool(o: Obj, path: string): boolean {
  const v = get(o, path);
  if (typeof v !== 'boolean') throw bad(path, 'boolean');
  return v;
}
function reqFlag01(o: Obj, path: string): boolean {
  const v = get(o, path);
  if (v !== 0 && v !== 1) throw bad(path, '0 or 1');
  return v === 1;
}
function reqSeq(o: Obj, path: string): number {
  const v = reqNum(o, path);
  if (!Number.isInteger(v) || v < 0) throw bad(path, 'non-negative integer');
  return v;
}
function reqCodes(o: Obj, path: string): string[] {
  const v = get(o, path);
  if (!Array.isArray(v) || !v.every((c) => typeof c === 'string')) throw bad(path, 'array of strings');
  return v as string[];
}
function isoTime(o: Obj, path: string): string {
  const s = reqStr(o, path);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw bad(path, 'ISO 8601 time');
  return new Date(ms).toISOString();
}
function eventType(v: string, path: string): CanonicalEvent['evt'] {
  if (!(EVENT_TYPES as readonly string[]).includes(v)) throw bad(path, 'known event type');
  return v as CanonicalEvent['evt'];
}

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
const fToC = (f: number | null) => (f === null ? null : round(((f - 32) * 5) / 9, 2));
const KESTREL_EVT = new Map(Object.entries(KESTREL_EVENT_CODES).map(([k, v]) => [v, k]));

type Draft = Omit<CanonicalEvent, 'event_id' | 'fault_families' | 'quality_flags'>;

function fromAurexV1(b: Obj): Draft {
  return {
    vin: reqStr(b, 'vehicle.vin'),
    seq: reqSeq(b, 'n'),
    event_ts: isoTime(b, 't'),
    evt: eventType(reqStr(b, 'evt'), 'evt'),
    lat: optNum(b, 'pos.la'),
    lon: optNum(b, 'pos.lo'),
    speed_kmh: optNum(b, 'spd'),
    odo_km: optNum(b, 'odo'),
    ambient_c: fToC(optNum(b, 'amb')),
    coolant_c: fToC(optNum(b, 'eng.coolantTempF')),
    rpm: optNum(b, 'eng.rpm'),
    batt_temp_c: fToC(optNum(b, 'batt.tempF')),
    soc_pct: optNum(b, 'batt.soc'),
    fuel_pct: optNum(b, 'fuel.pct'),
    lv_batt_v: optNum(b, 'elec.v12'),
    ignition: reqBool(b, 'ign'),
    charging: reqBool(b, 'chg'),
    harsh_brake: null,
    harsh_accel: null,
    idle_s: optNum(b, 'idle'),
    dtc: reqCodes(b, 'codes'),
    firmware: reqStr(b, 'sw'),
    source_format: 'aurex.v1',
  };
}

function fromAurexV2(b: Obj): Draft {
  return {
    vin: reqStr(b, 'vehicle.vin'),
    seq: reqSeq(b, 'seqNo'),
    event_ts: isoTime(b, 'time'),
    evt: eventType(reqStr(b, 'event'), 'event'),
    lat: optNum(b, 'position.lat'),
    lon: optNum(b, 'position.lon'),
    speed_kmh: optNum(b, 'speedKmh'),
    odo_km: optNum(b, 'odometerKm'),
    ambient_c: optNum(b, 'ambientC'),
    coolant_c: optNum(b, 'engine.coolant.tempC'),
    rpm: optNum(b, 'engine.rpm'),
    batt_temp_c: optNum(b, 'battery.tempC'),
    soc_pct: optNum(b, 'battery.socPct'),
    fuel_pct: optNum(b, 'fuel.pct'),
    lv_batt_v: optNum(b, 'electrical.v12'),
    ignition: reqBool(b, 'ignition'),
    charging: reqBool(b, 'charging'),
    harsh_brake: null,
    harsh_accel: null,
    idle_s: optNum(b, 'idleS'),
    dtc: reqCodes(b, 'codes'),
    firmware: reqStr(b, 'software'),
    source_format: 'aurex.v2',
  };
}

function fromKestrel(b: Obj): Draft {
  const ts = reqNum(b, 'ts');
  if (!Number.isInteger(ts) || !Number.isFinite(new Date(ts).getTime())) throw bad('ts', 'epoch milliseconds');
  const g = get(b, 'g');
  const [lat, lon] = Array.isArray(g) && g.length === 2 && g.every((x) => typeof x === 'number') ? g : [null, null];
  if (g !== undefined && lat === null) throw bad('g', '[lat, lon]');
  const code = reqStr(b, 'e');
  const evt = KESTREL_EVT.get(code);
  if (!evt) throw bad('e', 'known event code');
  const dtc = reqStr(b, 'dtc');
  const soc = optNum(b, 'soc');
  const count = (path: string) => {
    const v = optNum(b, path);
    return v === null || !Number.isInteger(v) || v < 0 ? null : v;
  };
  return {
    vin: reqStr(b, 'id'),
    seq: reqSeq(b, 'sq'),
    event_ts: new Date(ts).toISOString(),
    evt: evt as CanonicalEvent['evt'],
    lat: lat as number | null,
    lon: lon as number | null,
    speed_kmh: optNum(b, 's'),
    odo_km: optNum(b, 'o'),
    ambient_c: optNum(b, 'a'),
    coolant_c: optNum(b, 'ct'),
    rpm: null,
    batt_temp_c: optNum(b, 'bt'),
    soc_pct: soc === null ? null : round(soc * 100, 2),
    fuel_pct: optNum(b, 'fl'),
    lv_batt_v: optNum(b, 'v'),
    ignition: reqFlag01(b, 'ig'),
    charging: reqFlag01(b, 'ch'),
    harsh_brake: count('hb'),
    harsh_accel: count('ha'),
    idle_s: optNum(b, 'idl'),
    dtc: dtc === '' ? [] : dtc.split('|'),
    firmware: reqStr(b, 'fw'),
    source_format: 'kestrel.v1',
  };
}

const ADAPTERS: Record<SourceFormat, (b: Obj) => Draft> = {
  'aurex.v1': fromAurexV1,
  'aurex.v2': fromAurexV2,
  'kestrel.v1': fromKestrel,
};

/** Decode one raw payload into an (unvalidated) canonical event. Throws DecodeError. */
export function decodeRaw(text: string): CanonicalEvent {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new DecodeError('MALFORMED_JSON', err instanceof Error ? err.message : 'unparseable JSON');
  }
  const fmt = detectShape(body);
  const d = ADAPTERS[fmt](body as Obj);
  return { event_id: eventId(d.vin, d.seq), ...d, fault_families: [], quality_flags: [] };
}
