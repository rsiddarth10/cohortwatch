import { KafkaJS } from '@confluentinc/kafka-javascript';
import { buildVin, eventId, toAurexV1, toAurexV2, toKestrel, type SimEvent } from '@cw/domain';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCanonical } from './avro.js';
import { NormaliserConfigSchema } from './config.js';
import { startNormaliser, type RunningNormaliser } from './main.js';
import type { DlqEnvelope } from './pipeline.js';

/**
 * S2 integration test: real Redpanda (Kafka API + schema registry) and Redis, same pinned images as compose.
 * Feeds a crafted mixed batch through the running normaliser and asserts the exact canonical and DLQ output,
 * then crashes an instance before its offset commit and checks a restart creates no extra canonical events.
 */

const REDPANDA_IMAGE = 'docker.redpanda.com/redpandadata/redpanda:v24.2.7';
const REDIS_IMAGE = 'redis/redis-stack-server:7.4.0-v1';
const RAW_A = 'raw.oem-a.v1';
const RAW_B = 'raw.oem-b.v1';
const OUT = 'telemetry.canonical.v1';
const DLQ = 'telemetry.dlq.v1';

const VIN_A = buildVin('7AX', 'VE1C4', 2023, 'A', 100001);
const VIN_K = buildVin('7KS', 'HM1D8', 2024, 'K', 100002);
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
const kestrel = (seq: number, over: Partial<SimEvent> = {}) => JSON.stringify(toKestrel(sim(VIN_K, 2, seq, over)));

let redpanda: StartedRedpandaContainer;
let redis: StartedTestContainer;
let kafka: KafkaJS.Kafka;
let running: RunningNormaliser | undefined;

async function produce(topic: string, values: string[]): Promise<void> {
  const p = kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
  await p.connect();
  await p.send({
    topic,
    messages: values.map((value) => ({ key: 'k', value, partition: 0, headers: { 'x-sent-at': String(Date.now()) } })),
  });
  await p.disconnect();
}

/** Read a whole topic (fresh group), returning each record's value and headers. */
async function readAll(topic: string, expected: number): Promise<{ value: Buffer; headers: Record<string, string> }[]> {
  const c = kafka.consumer({ kafkaJS: { groupId: `itest-${topic}-${Date.now()}`, fromBeginning: true } });
  const out: { value: Buffer; headers: Record<string, string> }[] = [];
  await c.connect();
  await c.subscribe({ topics: [topic] });
  await c.run({
    eachMessage: async ({ message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {})) headers[k] = String(Array.isArray(v) ? v[0] : v);
      out.push({ value: message.value!, headers });
    },
  });
  const deadline = Date.now() + 30_000;
  while (out.length < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 2000)); // anything extra would arrive now
  await c.disconnect();
  return out;
}

const config = (over: Record<string, string> = {}) =>
  NormaliserConfigSchema.parse({
    KAFKA_BROKERS: redpanda.getBootstrapServers(),
    SCHEMA_REGISTRY_URL: redpanda.getSchemaRegistryAddress(),
    REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    METRICS_PORT: '0',
    BATCH_SIZE: '50',
    LOG_LEVEL: 'warn',
    ...over,
  });

async function waitFor(cond: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  [redpanda, redis] = await Promise.all([
    new RedpandaContainer(REDPANDA_IMAGE).start(),
    new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
  ]);
  kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [redpanda.getBootstrapServers()], clientId: 'itest', logLevel: KafkaJS.logLevel.ERROR },
  });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [RAW_A, RAW_B, OUT, DLQ].map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })),
  });
  await admin.disconnect();
});

afterAll(async () => {
  await running?.stop();
  await Promise.all([redpanda?.stop(), redis?.stop()]);
});

describe('normaliser against real Redpanda + Redis', () => {
  const invalidVin = { ...toKestrel(sim(VIN_K, 2, 50)), id: VIN_K.slice(0, 8) + 'X' + VIN_K.slice(9) };

  it('turns a crafted mixed batch into exactly the expected canonical events and DLQ entries', async () => {
    await produce(RAW_A, [
      JSON.stringify(toAurexV1(sim(VIN_A, 1, 1))), // aurex v1 (°F)
      JSON.stringify(toAurexV2(sim(VIN_A, 1, 2))), // aurex v2 (°C) after the format switch
      '{"vehicle":{"vin":"', // malformed JSON
    ]);
    await produce(RAW_B, [
      kestrel(1),
      kestrel(3),
      kestrel(3), // exact duplicate
      kestrel(2), // out of order
      JSON.stringify(invalidVin), // invalid VIN
      kestrel(4, { socPct: 140 }), // impossible value (SoC 140 %)
    ]);
    running = await startNormaliser(config());
    await waitFor(() => running!.ledger.in === 9);

    const canonical = (await readAll(OUT, 6)).map((r) => ({ ...decodeCanonical(r.value).event, h: r.headers }));
    const byKey = new Map(canonical.map((e) => [`${e.vin === VIN_A ? 'A' : 'K'}${e.seq}`, e]));
    expect(canonical).toHaveLength(6);
    expect([...byKey.keys()].sort()).toEqual(['A1', 'A2', 'K1', 'K2', 'K3', 'K4']);
    expect(byKey.get('A1')!.source_format).toBe('aurex.v1');
    expect(byKey.get('A2')!.source_format).toBe('aurex.v2');
    expect(byKey.get('A1')!.coolant_c).toBeCloseTo(90, 1); // °F → °C
    expect(byKey.get('A2')!.coolant_c).toBe(90);
    expect(byKey.get('K2')!.quality_flags).toEqual(['OUT_OF_ORDER']);
    expect(byKey.get('K4')!.soc_pct).toBeNull();
    expect(byKey.get('K4')!.quality_flags).toEqual(['OUT_OF_RANGE:soc_pct']);
    expect(byKey.get('K1')!.event_id).toBe(eventId(VIN_K, 1));
    for (const e of canonical) {
      expect(e.h['x-sent-at']).toMatch(/^\d+$/);
      expect(Number(e.h['x-normalised-at'])).toBeGreaterThanOrEqual(Number(e.h['x-sent-at']));
      expect(e.h['x-src-topic']).toMatch(/^raw\.oem-[ab]\.v1$/);
    }

    const dlq = (await readAll(DLQ, 2)).map((r) => JSON.parse(r.value.toString()) as DlqEnvelope);
    expect(dlq.map((d) => d.error_code).sort()).toEqual(['INVALID_VIN', 'MALFORMED_JSON']);
    const bad = dlq.find((d) => d.error_code === 'INVALID_VIN')!;
    expect(JSON.parse(Buffer.from(bad.raw_payload_b64, 'base64').toString())).toEqual(invalidVin);
    expect(bad.source_topic).toBe(RAW_B);
    expect(running.ledger).toMatchObject({ in: 9, out: 6, dlq: 2, duplicates: 1 });
  });

  it('a crash after producing but before committing creates no extra canonical events on restart', async () => {
    await running!.stop();
    // instance A: processes the next batch, produces it, writes state, then "crashes" before the commit
    let crashes = 0;
    const a = await startNormaliser(config(), {
      beforeCommit: () => {
        crashes++;
        throw new Error('simulated crash before offset commit');
      },
    });
    await produce(
      RAW_B,
      [5, 6, 7, 8, 9].map((s) => kestrel(s)),
    );
    await waitFor(() => crashes > 0);
    await a.stop();
    // The client may hand the 5 records over in several batches; at least the first was produced before the
    // crash, and none were committed.
    const producedBeforeCrash = (await readAll(OUT, 7)).length - 6;
    expect(producedBeforeCrash).toBeGreaterThanOrEqual(1);
    expect(a.ledger.committed[RAW_B]?.['0'] ?? '6').toBe('6');

    // instance B: same group, re-reads the uncommitted records; the anti-replay state drops what was produced
    running = await startNormaliser(config());
    await waitFor(() => (running!.ledger.committed[RAW_B]?.['0'] ?? '0') === '11');
    expect(running.ledger.duplicates).toBe(producedBeforeCrash);
    const after = (await readAll(OUT, 11)).map((r) => decodeCanonical(r.value).event);
    expect(after).toHaveLength(11); // no extra events
    expect(new Set(after.map((e) => e.event_id)).size).toBe(11);
  });
});
