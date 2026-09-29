import {
  CanonicalEventSchema,
  DEFAULT_VALIDATION,
  IngestClock,
  buildVin,
  toAurexV1,
  toAurexV2,
  toKestrel,
  type SimEvent,
  type VinState,
} from '@cw/domain';
import { describe, expect, it } from 'vitest';
import { CANONICAL_AVRO_SCHEMA, decodeCanonical, encodeCanonical } from './avro.js';
import { classifyBatch, decodeBatch, vinsOf, type RawRecord } from './pipeline.js';

const VIN_A = buildVin('7AX', 'VE1C4', 2023, 'A', 100001); // Aurex
const VIN_K = buildVin('7KS', 'HM1D8', 2024, 'K', 100002); // Kestrel
const T = Date.parse('2026-09-28T10:00:00Z');

function sim(vin: string, oemId: number, seq: number, over: Partial<SimEvent> = {}): SimEvent {
  return {
    vin,
    oemId,
    seq,
    eventTs: T + seq * 60_000,
    evt: 'PERIODIC',
    lat: 14.1,
    lon: 74.6,
    speedKmh: 40,
    odoKm: 1000 + seq,
    ambientC: 30,
    coolantC: 90,
    rpm: oemId === 1 ? 1800 : null,
    battTempC: null,
    socPct: null,
    fuelPct: 50,
    lvBattV: 14.1,
    ignition: true,
    charging: false,
    harshBrake: 0,
    harshAccel: 0,
    idleS: 0,
    dtc: [],
    firmware: '4.2.1',
    ...over,
  };
}

let offset = 0;
function rec(value: string, topic = 'raw.oem-b.v1'): RawRecord {
  return {
    topic,
    partition: 3,
    offset: String(offset++),
    timestampMs: 0,
    key: null,
    value: Buffer.from(value),
    headers: { 'x-sent-at': '1790000000000' },
  };
}
const k = (seq: number, over: Partial<SimEvent> = {}) => rec(JSON.stringify(toKestrel(sim(VIN_K, 2, seq, over))));
const a1 = (seq: number) => rec(JSON.stringify(toAurexV1(sim(VIN_A, 1, seq))), 'raw.oem-a.v1');
const a2 = (seq: number) => rec(JSON.stringify(toAurexV2(sim(VIN_A, 1, seq))), 'raw.oem-a.v1');
const now = () => new Date('2026-09-29T00:00:00Z');

function run(records: RawRecord[], states = new Map<string, VinState | undefined>()) {
  const decoded = decodeBatch(records, DEFAULT_VALIDATION, now);
  return classifyBatch(decoded, states, new IngestClock(), { skewMs: 120_000 });
}

describe('normaliseBatch: the crafted mixed batch', () => {
  const invalidVin = JSON.stringify({ ...toKestrel(sim(VIN_K, 2, 50)), id: VIN_K.slice(0, 8) + 'X' + VIN_K.slice(9) });
  const batch = [
    a1(1), // aurex v1
    a2(2), // aurex v2 (format switch mid-stream)
    k(1),
    k(3),
    k(3), // exact duplicate
    k(2), // out of order, unseen
    rec('{"id":"7KSHM1D8', 'raw.oem-b.v1'), // malformed JSON
    rec(invalidVin),
    k(4, { socPct: 140 }), // impossible value
    rec('{"hello":"world"}'), // unknown shape
  ];
  const res = run(batch);

  it('forwards each reading once, in both OEM formats, and drops the duplicate', () => {
    expect(res.canonical.map((c) => `${c.event.vin === VIN_A ? 'A' : 'K'}${c.event.seq}`)).toEqual([
      'A1', 'A2', 'K1', 'K3', 'K2', 'K4',
    ]); // prettier-ignore
    expect(res.counts.replay).toEqual({ NEW: 5, DUPLICATE: 1, LATE_NEW: 1, TOO_OLD: 0, SEQ_RESET: 0 });
    expect(res.canonical.map((c) => c.event.source_format)).toEqual([
      'aurex.v1', 'aurex.v2', 'kestrel.v1', 'kestrel.v1', 'kestrel.v1', 'kestrel.v1',
    ]); // prettier-ignore
  });

  it('flags the out-of-order reading and the impossible value, keeping both events', () => {
    const bySeq = new Map(res.canonical.filter((c) => c.event.vin === VIN_K).map((c) => [c.event.seq, c.event]));
    expect(bySeq.get(2)!.quality_flags).toEqual(['OUT_OF_ORDER']);
    expect(bySeq.get(4)!.soc_pct).toBeNull();
    expect(bySeq.get(4)!.quality_flags).toEqual(['OUT_OF_RANGE:soc_pct']);
    expect(bySeq.get(1)!.quality_flags).toEqual([]);
    expect(res.counts.flags).toEqual({ OUT_OF_ORDER: 1, OUT_OF_RANGE: 1 });
  });

  it('sends malformed, invalid-VIN and unknown-shape records to the DLQ with their reason and payload', () => {
    expect(res.dlq.map((d) => d.envelope.error_code)).toEqual(['MALFORMED_JSON', 'INVALID_VIN', 'UNKNOWN_SHAPE']);
    const d = res.dlq[1]!.envelope;
    expect(Buffer.from(d.raw_payload_b64, 'base64').toString()).toBe(invalidVin);
    expect(d.source_topic).toBe('raw.oem-b.v1');
    expect(d.first_seen).toBe('2026-09-29T00:00:00.000Z');
    expect(res.counts.dlq).toEqual({ MALFORMED_JSON: 1, INVALID_VIN: 1, UNKNOWN_SHAPE: 1 });
  });

  it('balances: in = out + dlq + duplicates', () => {
    const dlq = Object.values(res.counts.dlq).reduce((x, y) => x + y, 0);
    expect(res.counts.in).toBe(batch.length);
    expect(res.counts.out + dlq + res.counts.replay.DUPLICATE).toBe(res.counts.in);
  });

  it('every canonical event satisfies the zod contract and round-trips through Avro', () => {
    for (const c of res.canonical) {
      expect(CanonicalEventSchema.safeParse(c.event).success).toBe(true);
      const { schemaId, event } = decodeCanonical(encodeCanonical(42, c.event));
      expect(schemaId).toBe(42);
      expect(event).toEqual(c.event);
    }
  });

  it('only valid events contribute VIN state keys', () => {
    expect(vinsOf(decodeBatch(batch, DEFAULT_VALIDATION, now))).toEqual([VIN_A, VIN_K]);
  });
});

describe('state across batches (what Redis carries between batches and replicas)', () => {
  it('a redelivered batch is entirely duplicates once its state was written', () => {
    const first = run([k(10), k(11), k(12)]);
    const again = run([k(10), k(11), k(12)], first.states);
    expect(again.canonical).toHaveLength(0);
    expect(again.counts.replay.DUPLICATE).toBe(3);
  });

  it('a redelivered batch whose state write was lost is re-produced with the same event ids (no loss)', () => {
    const first = run([k(20), k(21)]);
    const again = run([k(20), k(21)]); // state never written back (crash before the Lua CAS)
    expect(again.canonical.map((c) => c.event.event_id)).toEqual(first.canonical.map((c) => c.event.event_id));
  });

  it('jump checks use the previous batch: odometer going backwards is flagged', () => {
    const first = run([k(30)]);
    const next = run([k(31, { odoKm: 5 })], first.states);
    expect(next.canonical[0]!.event.quality_flags).toContain('ODOMETER_BACKWARDS');
    expect(next.canonical[0]!.event.odo_km).toBeNull();
  });

  it('a counter reset is forwarded, flagged, and starts a fresh window', () => {
    const first = run([k(5000)]);
    const reset = run([k(3, { eventTs: T + 6000 * 60_000 })], first.states);
    expect(reset.counts.replay.SEQ_RESET).toBe(1);
    expect(reset.canonical[0]!.event.quality_flags).toContain('SEQ_RESET');
    expect(reset.states.get(VIN_K)!.window.maxSeq).toBe(3);
  });

  it('a reading far ahead of the time its ingest implies is flagged CLOCK_SKEW; ordinary readings are not', () => {
    const clock = new IngestClock(1, 64, 16);
    // ingest (Kafka timestamp) = event time at 1×, then one van stamps +10 min
    const on = (seq: number, eventTs: number) => ({ ...k(seq, { eventTs }), timestampMs: T + seq * 60_000 });
    const records = [...Array.from({ length: 64 }, (_, i) => on(100 + i, T + (100 + i) * 60_000))];
    records.push(on(164, T + 164 * 60_000 + 10 * 60_000));
    const res = classifyBatch(decodeBatch(records, DEFAULT_VALIDATION, now), new Map(), clock, { skewMs: 120_000 });
    expect(res.counts.flags.CLOCK_SKEW).toBe(1);
    expect(res.canonical.at(-1)!.event.quality_flags).toContain('CLOCK_SKEW');
  });
});

describe('Avro contract', () => {
  it('has the same fields as the zod contract', () => {
    expect(CANONICAL_AVRO_SCHEMA.fields.map((f) => f.name).sort()).toEqual(
      Object.keys(CanonicalEventSchema.shape).sort(),
    );
  });

  it('every optional field has a null default (BACKWARD-compatible evolution)', () => {
    for (const f of CANONICAL_AVRO_SCHEMA.fields) {
      if (Array.isArray(f.type)) expect((f as { default?: unknown }).default).toBeNull();
    }
  });
});
