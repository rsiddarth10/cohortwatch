import { fileURLToPath } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { buildVin, type CanonicalEvent } from '@cw/domain';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { startStateProcessor, type RunningStateProcessor } from './main.js';

/**
 * S3 integration test: real Redpanda, Redis and TimescaleDB (same pinned images as compose), all migrations.
 * Crafted canonical events for one sick and one healthy van → exactly one incident (with clues) for the sick van,
 * none for the healthy one, and no clone after a crash mid-stream (the restart replays from the last commit).
 */
const REDPANDA_IMAGE = 'docker.redpanda.com/redpandadata/redpanda:v24.2.7';
const REDIS_IMAGE = 'redis/redis-stack-server:7.4.0-v1';
const PG_IMAGE = 'timescale/timescaledb-ha:pg16.15-ts2.30.1';
const IN = 'telemetry.canonical.v1';
const INC = 'incidents.v1';

const SICK = buildVin('7KS', 'HM1D8', 2024, 'K', 200001);
const WELL = buildVin('7KS', 'HM1D8', 2024, 'K', 200002);
const T0 = Date.parse('2026-09-28T04:00:00Z');
const HOUR = 3_600_000;
const READINGS = 97; // 48 sim-hours, every 30 sim-minutes

let redpanda: StartedRedpandaContainer;
let redis: StartedTestContainer;
let postgres: StartedTestContainer;
let pool: pg.Pool;
let kafka: KafkaJS.Kafka;
let running: RunningStateProcessor | null = null;
let dbUrl = '';

function reading(vin: string, i: number): CanonicalEvent {
  const h = i / 2;
  const drift = vin === SICK ? Math.min(Math.max(0, h - 6) * 0.4, 12) : 0;
  return {
    event_id: `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`,
    vin,
    seq: i + 1,
    event_ts: new Date(T0 + h * HOUR).toISOString(),
    evt: 'PERIODIC',
    lat: null,
    lon: null,
    speed_kmh: 42,
    odo_km: null,
    ambient_c: 30,
    coolant_c: 90 + drift + Math.sin(i * 1.7) * 0.4,
    rpm: null,
    batt_temp_c: null,
    soc_pct: null,
    fuel_pct: 50,
    lv_batt_v: 14.1,
    ignition: true,
    charging: false,
    harsh_brake: null,
    harsh_accel: null,
    idle_s: null,
    dtc: [],
    fault_families: [],
    firmware: '4.2.1',
    source_format: 'kestrel.v1',
    quality_flags: [],
  };
}

async function produce(from: number, to: number): Promise<void> {
  const producer = kafka.producer({ kafkaJS: { acks: -1 } });
  await producer.connect();
  const messages: KafkaJS.Message[] = [];
  for (let i = from; i < to; i++) {
    for (const vin of [SICK, WELL]) {
      messages.push({ key: vin, value: JSON.stringify(reading(vin, i)), headers: { 'x-sent-at': String(Date.now()) } });
    }
  }
  await producer.send({ topic: IN, messages });
  await producer.disconnect();
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const start = () =>
  startStateProcessor(
    loadConfig({
      KAFKA_BROKERS: redpanda.getBootstrapServers(),
      REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      DATABASE_URL: dbUrl,
      ENCODING: 'json',
      CHECKPOINT_MS: '600000', // no checkpoint before the crash: the restart replays everything
      REGISTRY_REFRESH_MS: '600000',
      TELEMETRY_FLUSH_MS: '500',
      METRICS_PORT: '0',
      LOG_LEVEL: 'warn',
    }),
    { onFatal: (err) => console.error('fatal', err) },
  );

const count = async (sql: string, args: unknown[] = []) => Number((await pool.query(sql, args)).rows[0].n);

beforeAll(async () => {
  [redpanda, redis, postgres] = await Promise.all([
    new RedpandaContainer(REDPANDA_IMAGE).start(),
    new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start(),
    new GenericContainer(PG_IMAGE)
      .withEnvironment({ POSTGRES_PASSWORD: 'pw' })
      .withExposedPorts(5432)
      .withCopyDirectoriesToContainer([
        { source: fileURLToPath(new URL('../../../infra/db', import.meta.url)), target: '/cw-db' },
      ])
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start(),
  ]);
  const mig = await postgres.exec(['sh', '/cw-db/migrate.sh'], {
    env: {
      PGHOST: 'localhost',
      PGUSER: 'postgres',
      PGPASSWORD: 'pw',
      CW_SIM_PASSWORD: 'sim',
      CW_APP_PASSWORD: 'app',
      MIGRATIONS_DIR: '/cw-db/migrations',
    },
  });
  if (mig.exitCode !== 0) throw new Error(`migrations failed: ${mig.output}`);
  const host = `${postgres.getHost()}:${postgres.getMappedPort(5432)}`;
  dbUrl = `postgres://cw_app:app@${host}/cohortwatch`;
  pool = new pg.Pool({ connectionString: `postgres://postgres:pw@${host}/cohortwatch`, max: 2 });
  await pool.query(`
    INSERT INTO core.tenant VALUES (1, 'T1', 'Tenant one');
    INSERT INTO core.fleet VALUES (1, 1, 'Fleet one');
    INSERT INTO core.region VALUES (3, 'R3', 'Coral Coast', 'HOT_HUMID', 30, 4);
    INSERT INTO core.depot VALUES (10, 'D010', 1, 3, 22, 74, 't9abc', 'L');
    INSERT INTO core.oem VALUES (2, 'KES', 'Kestrel', '7KS', 'kestrel.v1');
    INSERT INTO core.vehicle_model VALUES (6, 2, 'HM1D8', 'Hauler', 'DIESEL');
    INSERT INTO core.duty_type VALUES (1, 'URBAN', 'Urban', 10, 0.8);
    INSERT INTO core.vehicle (vin, tenant_id, fleet_id, model_id, duty_type_id, model_year, registered_at)
      VALUES ('${SICK}', 1, 1, 6, 1, 2024, now()), ('${WELL}', 1, 1, 6, 1, 2024, now());
    INSERT INTO core.vehicle_depot_assignment VALUES ('${SICK}', 10, tstzrange(NULL, NULL)), ('${WELL}', 10, tstzrange(NULL, NULL));
    INSERT INTO core.baseline_run (id, source_hash, rows_scanned, vins, seconds, engine) VALUES (1, 'itest', 0, 2, 0, 'itest');
    INSERT INTO core.vehicle_baseline VALUES
      ('${SICK}', 'coolant_c', 90, 0.3, 0, 0.05, 14, 200, 1), ('${WELL}', 'coolant_c', 90, 0.3, 0, 0.05, 14, 200, 1);
  `);
  kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [redpanda.getBootstrapServers()], clientId: 'itest', logLevel: KafkaJS.logLevel.ERROR },
  });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [
      { topic: IN, numPartitions: 2, replicationFactor: 1 },
      { topic: INC, numPartitions: 2, replicationFactor: 1 },
    ],
  });
  await admin.disconnect();
});

afterAll(async () => {
  await running?.stop();
  await pool?.end();
  await Promise.all([redpanda?.stop(), redis?.stop(), postgres?.stop()]);
});

describe('state processor against real Redpanda + Redis + TimescaleDB', () => {
  it('one incident with clues for the sick van, none for the healthy van, no clone after a crash', async () => {
    await produce(0, 70); // 35 sim-hours: the sick van is well past its confirmation
    running = await start();
    await waitFor(() => running!.stats.applied >= 140);
    await waitFor(async () => (await count('SELECT count(*) AS n FROM core.incident')) > 0);
    const first = (await pool.query('SELECT id FROM core.incident')).rows.map((r: { id: string }) => r.id);

    await running.kill(); // crash: no checkpoint, no commit
    running = await start(); // replays from offset 0: re-derives the same incident
    await produce(70, READINGS);
    // the fresh instance replays from offset 0 (nothing was committed) and applies everything again
    await waitFor(() => running!.stats.applied >= 2 * READINGS);
    expect(running.stats.skipped).toBe(0);

    const rows = (await pool.query('SELECT id, vin, fault_family, status, severity FROM core.incident')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first[0], vin: SICK, fault_family: 'COOLING', status: 'OPEN' });
    const clues = (await pool.query('SELECT clue_type, text FROM core.incident_clue ORDER BY ord')).rows;
    expect(clues[0].text).toMatch(/^coolant \d+\.\d °C above its own normal \(90\.0 °C\)$/);

    // Kafka: at-least-once, so the replay may re-send, but always under the same incident_id and family key
    const consumer = kafka.consumer({ kafkaJS: { groupId: 'itest-inc', fromBeginning: true } });
    await consumer.connect();
    await consumer.subscribe({ topics: [INC] });
    const seen: { id: string; key: string; action: string }[] = [];
    void consumer.run({
      eachMessage: async ({ message }) => {
        const m = JSON.parse(message.value!.toString()) as { incident_id: string; action: string };
        seen.push({ id: m.incident_id, key: message.key!.toString(), action: m.action });
      },
    });
    await waitFor(() => seen.length >= 1, 30_000);
    await new Promise((r) => setTimeout(r, 2000));
    await consumer.disconnect();
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(first));
    expect(new Set(seen.map((s) => s.key))).toEqual(new Set(['COOLING|6|1|10']));

    // telemetry: hourly rows for both vans; the "vs own normal" aggregate is queryable
    await running.stop();
    running = null;
    expect(await count('SELECT count(DISTINCT vin) AS n FROM core.telemetry')).toBe(2);
    expect(await count('SELECT count(*) AS n FROM core.telemetry_hourly WHERE vin = $1', [SICK])).toBeGreaterThan(40);
  });
});
