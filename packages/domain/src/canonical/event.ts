import { z } from 'zod';
import { sha1 } from './sha1.js';

/**
 * The canonical telemetry event (brief §5.2/§5.3): one format for both OEMs, SI units and °C,
 * ISO 8601 UTC event time. Produced by the normaliser (S2) to `telemetry.canonical.v1`.
 * Signals a vehicle does not have, or that failed validation, are null (never guessed).
 */

export const EVENT_TYPES = [
  'IGNITION_ON',
  'TRIP_START',
  'PERIODIC',
  'HARSH_BRAKE',
  'HARSH_ACCEL',
  'DTC',
  'TRIP_END',
  'IGNITION_OFF',
  'HEARTBEAT',
] as const;

export const SOURCE_FORMATS = ['aurex.v1', 'aurex.v2', 'kestrel.v1'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export const CANONICAL_FAULT_FAMILIES = [
  'COOLING',
  'HV_BATTERY_THERMAL',
  'LV_ELECTRICAL',
  'EXHAUST',
  'BRAKE_SENSOR',
  'OTHER',
] as const;

/** Quality flag types; a flag is "TYPE" or "TYPE:field" (e.g. "OUT_OF_RANGE:soc_pct"). */
export const QUALITY_FLAG_TYPES = [
  'OUT_OF_RANGE',
  'INVALID_DTC',
  'ODOMETER_BACKWARDS',
  'SOC_RISING_WHILE_DRIVING',
  'CLOCK_SKEW',
  'OUT_OF_ORDER',
  'LATE',
  'SEQ_RESET',
] as const;
export type QualityFlagType = (typeof QUALITY_FLAG_TYPES)[number];

export const flag = (type: QualityFlagType, field?: string): string => (field ? `${type}:${field}` : type);
export const flagType = (f: string): QualityFlagType => f.split(':')[0] as QualityFlagType;

const num = z.number().finite();
const nnum = num.nullable();

export const CanonicalEventSchema = z.object({
  event_id: z.uuid(),
  vin: z.string().length(17),
  seq: z.number().int().nonnegative(),
  event_ts: z.iso.datetime({ offset: false, precision: 3 }),
  evt: z.enum(EVENT_TYPES),
  lat: nnum,
  lon: nnum,
  speed_kmh: nnum,
  odo_km: nnum,
  ambient_c: nnum,
  coolant_c: nnum,
  rpm: nnum,
  batt_temp_c: nnum,
  soc_pct: nnum,
  fuel_pct: nnum,
  lv_batt_v: nnum,
  ignition: z.boolean(),
  charging: z.boolean(),
  /** Kestrel only (Aurex does not report counts). */
  harsh_brake: z.number().int().nonnegative().nullable(),
  harsh_accel: z.number().int().nonnegative().nullable(),
  idle_s: nnum,
  /** Valid DTCs only; invalid codes are dropped and flagged INVALID_DTC. */
  dtc: z.array(z.string()),
  /** One family per entry of `dtc` (same order); a valid but unknown code maps to OTHER. */
  fault_families: z.array(z.enum(CANONICAL_FAULT_FAMILIES)),
  firmware: z.string(),
  source_format: z.enum(SOURCE_FORMATS),
  quality_flags: z.array(z.string()),
});

export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;

/** Fixed namespace for event ids (a random v4 UUID, generated once for CohortWatch). */
export const EVENT_ID_NAMESPACE = '6f1c2a4e-3b7d-4e8a-9c51-2d0f8b7a6e13';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** RFC 9562 UUIDv5 (SHA-1, name-based) of `name` in `namespace`. */
export function uuidV5(namespace: string, name: string): string {
  const ns = namespace.replace(/-/g, '');
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const h = sha1(input);
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC variant
  const x = hex(h.subarray(0, 16));
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Event id = uuid5(`${vin}:${seq}`): the same reading always gets the same id, whichever OEM format,
 * replica or redelivery produced it, so downstream consumers can dedupe on it.
 */
export const eventId = (vin: string, seq: number): string => uuidV5(EVENT_ID_NAMESPACE, `${vin}:${seq}`);
