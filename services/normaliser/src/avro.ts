import { COMPATIBILITY, SchemaRegistry, SchemaType } from '@kafkajs/confluent-schema-registry';
import { CANONICAL_FAULT_FAMILIES, EVENT_TYPES, SOURCE_FORMATS, type CanonicalEvent } from '@cw/domain';
import avro from 'avsc';

/**
 * Avro contract for telemetry.canonical.v1 (subject telemetry.canonical.v1-value, compatibility BACKWARD).
 * Mirrors CanonicalEventSchema (zod) in packages/domain; a unit test keeps the two in step.
 * Evolution rule: only add fields with a default, so readers on the new schema can read old data.
 */
const nullable = (name: string, type: string, doc: string) => ({ name, type: ['null', type], default: null, doc });

export const CANONICAL_AVRO_SCHEMA = {
  type: 'record',
  name: 'CanonicalTelemetry',
  namespace: 'io.cohortwatch.telemetry.v1',
  doc: 'One vehicle reading in canonical units (SI, °C), normalised from any OEM format.',
  fields: [
    { name: 'event_id', type: 'string', doc: 'uuid5(vin:seq); stable across formats and redeliveries' },
    { name: 'vin', type: 'string' },
    { name: 'seq', type: 'long', doc: 'per-vehicle monotonic sequence number' },
    { name: 'event_ts', type: 'string', doc: 'event (simulated) time, ISO 8601 UTC with ms' },
    { name: 'evt', type: { type: 'enum', name: 'EventType', symbols: [...EVENT_TYPES] } },
    nullable('lat', 'double', 'degrees'),
    nullable('lon', 'double', 'degrees'),
    nullable('speed_kmh', 'double', 'mean speed over the interval'),
    nullable('odo_km', 'double', 'odometer'),
    nullable('ambient_c', 'double', '°C'),
    nullable('coolant_c', 'double', '°C; null when parked or no engine'),
    nullable('rpm', 'double', 'Aurex only'),
    nullable('batt_temp_c', 'double', '°C; EV/hybrid'),
    nullable('soc_pct', 'double', '0-100; EV/hybrid'),
    nullable('fuel_pct', 'double', '0-100; diesel'),
    nullable('lv_batt_v', 'double', '12 V system'),
    { name: 'ignition', type: 'boolean' },
    { name: 'charging', type: 'boolean' },
    nullable('harsh_brake', 'int', 'Kestrel only'),
    nullable('harsh_accel', 'int', 'Kestrel only'),
    nullable('idle_s', 'double', 'seconds idling in the interval'),
    { name: 'dtc', type: { type: 'array', items: 'string' }, doc: 'valid fault codes only' },
    {
      name: 'fault_families',
      type: { type: 'array', items: { type: 'enum', name: 'FaultFamily', symbols: [...CANONICAL_FAULT_FAMILIES] } },
      doc: 'one per dtc entry, same order',
    },
    { name: 'firmware', type: 'string' },
    // a string, not an enum: Avro enum symbols cannot contain '.', and new OEM formats must not break readers
    { name: 'source_format', type: 'string', doc: `one of ${SOURCE_FORMATS.join(', ')} (more may be added)` },
    { name: 'quality_flags', type: { type: 'array', items: 'string' }, doc: 'TYPE or TYPE:field' },
  ],
} as const;

export const CANONICAL_SUBJECT = 'telemetry.canonical.v1-value';

const type = avro.Type.forSchema(CANONICAL_AVRO_SCHEMA as unknown as avro.Schema);

/** Confluent wire format: magic byte 0, 4-byte big-endian schema id, Avro binary body. Synchronous. */
export function encodeCanonical(schemaId: number, ev: CanonicalEvent): Buffer {
  const body = type.toBuffer(ev);
  const out = Buffer.allocUnsafe(5 + body.length);
  out[0] = 0;
  out.writeInt32BE(schemaId, 1);
  body.copy(out, 5);
  return out;
}

export function decodeCanonical(buf: Buffer): { schemaId: number; event: CanonicalEvent } {
  if (buf[0] !== 0) throw new Error('not Confluent wire format');
  return { schemaId: buf.readInt32BE(1), event: type.fromBuffer(buf.subarray(5)) as CanonicalEvent };
}

/** Register (or find) the schema under BACKWARD compatibility; returns its registry id. */
export async function registerCanonicalSchema(registryUrl: string): Promise<number> {
  const registry = new SchemaRegistry({ host: registryUrl });
  const { id } = await registry.register(
    { type: SchemaType.AVRO, schema: JSON.stringify(CANONICAL_AVRO_SCHEMA) },
    { subject: CANONICAL_SUBJECT, compatibility: COMPATIBILITY.BACKWARD },
  );
  return id;
}
