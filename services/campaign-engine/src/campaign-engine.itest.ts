import { fileURLToPath } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { buildVin, type IncidentMessage } from '@cw/domain';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { startCampaignEngine, type RunningEngine } from './main.js';

/**
 * S5 integration test: real Redpanda and TimescaleDB (+ pgvector), all migrations, crafted incidents.
 * 6 sisters → one campaign; a 7th → GREW, not a second campaign; the same incident replayed → no new member;
 * 5 scattered incidents at 5 depots → no campaign; a crash mid-stream → no duplicates; the outbox publishes each
 * change once (one row per change, the same event id on Kafka).
 */
const REDPANDA_IMAGE = 'docker.redpanda.com/redpandadata/redpanda:v24.2.7';
const PG_IMAGE = 'timescale/timescaledb-ha:pg16.15-ts2.30.1';
const IN = 'incidents.v1';
const OUT = 'campaign.events.v1';
const T0 = Date.parse('2026-09-28T04:00:00Z');
const HOUR = 3_600_000;

const sister = (i: number) => buildVin('7KS', 'HM1D8', 2024, 'K', 300000 + i);
const decoy = (i: number) => buildVin('7KS', 'HM1D8', 2024, 'K', 400000 + i);

let redpanda: StartedRedpandaContainer;
let postgres: StartedTestContainer;
let pool: pg.Pool;
let kafka: KafkaJS.Kafka;
let running: RunningEngine | null = null;
let dbUrl = '';
let n = 0;

function incident(vin: string, depot: number, h: number, id?: string): IncidentMessage {
  n++;
  return {
    incident_id: id ?? `00000000-0000-5000-a000-${String(n).padStart(12, '0')}`,
    action: 'OPEN',
    vin,
    fault_family: 'COOLING',
    family_key: `COOLING|6|1|${depot}`,
    window_bucket: 0,
    event_ts: new Date(T0 + h * HOUR).toISOString(),
    seq: 100 + n,
    trigger: 'SIGNAL',
    metric: 'coolant_c',
    severity: 'WARN',
    runaway: false,
    hours_to_limit: null,
    depot_id: depot,
    model_id: 6,
    duty_type_id: 1,
    region_id: 3,
    firmware: '4.2.1',
    baseline_source: 'VAN',
    last_code: 'P0217',
    numbers: {
      level: 99,
      baseline_median: 90,
      deviation: 9,
      peer_adj: 0,
      z_level: 7,
      z_slope: 1,
      slope_per_h: 0.3,
      dtc_count_24h: 0,
      dtc_usual_per_day: 0,
    },
    clues: [],
  };
}

async function produce(msgs: IncidentMessage[]): Promise<void> {
  const producer = kafka.producer({ kafkaJS: { acks: -1 } });
  await producer.connect();
  await producer.send({
    topic: IN,
    messages: msgs.map((m) => ({
      key: m.family_key,
      value: JSON.stringify(m),
      headers: { 'x-sent-at': String(Date.now()), 'x-incident-at': String(Date.now()) },
    })),
  });
  await producer.disconnect();
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

const count = async (sql: string, args: unknown[] = []) => Number((await pool.query(sql, args)).rows[0].n);

const start = () =>
  startCampaignEngine(
    loadConfig({
      KAFKA_BROKERS: redpanda.getBootstrapServers(),
      DATABASE_URL: dbUrl,
      OUTBOX_POLL_MS: '100',
      AT_RISK_POLL_MS: '600000',
      METRICS_PORT: '0',
      LOG_LEVEL: 'warn',
    }),
    { onFatal: (err) => console.error('fatal', err) },
  );

beforeAll(async () => {
  [redpanda, postgres] = await Promise.all([
    new RedpandaContainer(REDPANDA_IMAGE).start(),
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
  const vans = [
    ...Array.from({ length: 60 }, (_, i) => [sister(i), 10]),
    ...Array.from({ length: 5 }, (_, i) => [decoy(i), 20 + i]),
  ] as [string, number][];
  await pool.query(
    `
    INSERT INTO core.tenant VALUES (1, 'T1', 'Tenant one');
    INSERT INTO core.fleet VALUES (1, 1, 'Fleet one');
    INSERT INTO core.region VALUES (3, 'R3', 'Coral Coast', 'HOT_HUMID', 30, 4);
    INSERT INTO core.depot SELECT d, 'D' || d, 1, 3, 22, 74, 't9abc', 'L' FROM unnest(ARRAY[10, 20, 21, 22, 23, 24]) d;
    INSERT INTO core.oem VALUES (2, 'KES', 'Kestrel', '7KS', 'kestrel.v1');
    INSERT INTO core.vehicle_model VALUES (6, 2, 'KS-D1', 'Haulmark', 'DIESEL');
    INSERT INTO core.duty_type VALUES (1, 'URBAN', 'Urban', 10, 0.8);
    INSERT INTO core.vehicle (vin, tenant_id, fleet_id, model_id, duty_type_id, model_year, registered_at)
      SELECT v, 1, 1, 6, 1, 2024, now() FROM unnest($1::text[]) v;
    INSERT INTO core.vehicle_depot_assignment SELECT v, d, tstzrange(NULL, NULL) FROM unnest($1::text[], $2::int[]) AS t(v, d);
  `
      .replace(/\$1::text\[\]/g, `ARRAY[${vans.map(([v]) => `'${v}'`).join(',')}]::text[]`)
      .replace(/\$2::int\[\]/g, `ARRAY[${vans.map(([, d]) => d).join(',')}]::int[]`),
  );
  kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [redpanda.getBootstrapServers()], clientId: 'itest', logLevel: KafkaJS.logLevel.ERROR },
  });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [
      { topic: IN, numPartitions: 3, replicationFactor: 1 },
      { topic: OUT, numPartitions: 3, replicationFactor: 1 },
    ],
  });
  await admin.disconnect();
});

afterAll(async () => {
  await running?.stop();
  await pool?.end();
  await Promise.all([redpanda?.stop(), postgres?.stop()]);
});

describe('campaign engine against real Redpanda + TimescaleDB', () => {
  it('opens once, grows, ignores replays and decoys, survives a crash, publishes each change once', async () => {
    running = await start();
    const first6 = Array.from({ length: 6 }, (_, i) => incident(sister(i), 10, 8 + i));
    await produce(first6);
    await waitFor(async () => (await count(`SELECT count(*) AS n FROM core.campaign_member WHERE active`)) === 6);
    expect(await count(`SELECT count(*) AS n FROM core.campaign WHERE status = 'OPEN'`)).toBe(1);

    const seventh = incident(sister(6), 10, 20);
    await produce([seventh, { ...seventh }]); // the same incident twice (a replay)
    for (let d = 0; d < 5; d++) await produce([incident(decoy(d), 20 + d, 10 + d)]); // scattered: 5 depots
    await waitFor(async () => (await count(`SELECT count(*) AS n FROM core.processed_incident_action`)) === 12);
    expect(await count(`SELECT count(*) AS n FROM core.campaign WHERE status = 'OPEN'`)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM core.campaign_member WHERE active`)).toBe(12); // 7 sisters + 5 watching decoys
    expect(await count(`SELECT member_count AS n FROM core.campaign WHERE status = 'OPEN'`)).toBe(7);

    // crash mid-stream: nothing committed after the kill; the restart re-reads and applies each incident once
    await running.kill();
    await produce([8, 9, 10].map((i) => incident(sister(i), 10, 20 + i)));
    running = await start();
    await waitFor(
      async () => (await count(`SELECT member_count AS n FROM core.campaign WHERE status = 'OPEN'`)) === 10,
    );
    expect(await count(`SELECT count(*) AS n FROM core.campaign_member WHERE active`)).toBe(
      await count(`SELECT count(DISTINCT (vin, fault_family)) AS n FROM core.campaign_member WHERE active`),
    );

    // outbox: one row per change (OPENED + 5 GREW), all published; Kafka carries each event id
    await waitFor(async () => (await count(`SELECT count(*) AS n FROM core.outbox WHERE published_at IS NULL`)) === 0);
    const rows = (
      await pool.query<{ id: string; type: string }>(`SELECT id, payload->>'type' AS type FROM core.outbox`)
    ).rows;
    expect(rows.map((r) => r.type).sort()).toEqual(['GREW', 'GREW', 'GREW', 'GREW', 'GREW', 'OPENED']);
    const consumer = kafka.consumer({ kafkaJS: { groupId: 'itest-out', fromBeginning: true } });
    await consumer.connect();
    await consumer.subscribe({ topics: [OUT] });
    const seen: string[] = [];
    void consumer.run({
      eachMessage: async ({ message }) => {
        seen.push(String(message.headers?.['x-event-id']));
      },
    });
    await waitFor(() => seen.length >= rows.length, 30_000);
    await new Promise((r) => setTimeout(r, 1500));
    await consumer.disconnect();
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.id)));
    expect(seen).toHaveLength(rows.length);

    // clues + similar past campaigns on the open campaign; a dismissal is recorded with its outbox row
    const clues = (await pool.query<{ text: string }>(`SELECT text FROM core.campaign_clue ORDER BY ord`)).rows.map(
      (r) => r.text,
    );
    expect(clues.some((t) => t.startsWith('10 KS-D1 vans on urban duty at depot D10'))).toBe(true);
    expect(clues.some((t) => t.startsWith('cost if not fixed ≈ ₹'))).toBe(true);
    expect(await count(`SELECT count(*) AS n FROM core.campaign_similar`)).toBe(3);
    const id = (await pool.query<{ id: string }>(`SELECT id FROM core.campaign WHERE status = 'OPEN'`)).rows[0]!.id;
    const ev = await running.engine.dismiss(id, 'lead', 'known thermostat batch');
    expect(ev.map((e) => e.type)).toEqual(['DISMISSED']);
    expect(await count(`SELECT count(*) AS n FROM core.campaign_override`)).toBe(1);
  });
});
