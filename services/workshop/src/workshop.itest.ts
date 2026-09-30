import { fileURLToPath } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { buildVin, type IncidentMessage } from '@cw/domain';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { startWorkshop, type RunningWorkshop } from './main.js';

/**
 * S4 + S6 integration test: real Redpanda and TimescaleDB, all migrations. Upstream rows (incidents, a campaign,
 * hourly telemetry) are written as S3/S5 would, and their events are published.
 * Queue order; a critical incident → top of its depot within seconds + a card; a good repair → FIXED; a bad repair →
 * NOT_FIXED and back in the queue; outcomes on workshop.outcomes.v1; replays and a crash → no duplicates.
 * (All members FIXED → campaign CLOSED is covered by the campaign-engine integration test.)
 */
const REDPANDA_IMAGE = 'docker.redpanda.com/redpandadata/redpanda:v24.2.7';
const PG_IMAGE = 'timescale/timescaledb-ha:pg16.15-ts2.30.1';
const T0 = Date.parse('2026-09-28T04:00:00Z');
const HOUR = 3_600_000;
const van = (i: number) => buildVin('7KS', 'HM1D8', 2024, 'K', 500000 + i);
const [WORSE, LOUD, MEMBER, RUN, BADFIX] = [van(1), van(2), van(3), van(4), van(5)];
const CAMPAIGN = '5b0e4c2a-8f1d-4d6e-9a37-000000000001';

let redpanda: StartedRedpandaContainer;
let postgres: StartedTestContainer;
let pool: pg.Pool;
let kafka: KafkaJS.Kafka;
let running: RunningWorkshop | null = null;
let dbUrl = '';
let n = 0;

function incident(vin: string, over: Partial<IncidentMessage> = {}): IncidentMessage {
  n++;
  return {
    incident_id: `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`,
    action: 'OPEN', vin, fault_family: 'COOLING', family_key: 'COOLING|6|1|10', window_bucket: 0,
    event_ts: new Date(T0 + 20 * HOUR + n * 60_000).toISOString(), seq: n, trigger: 'SIGNAL', metric: 'coolant_c',
    severity: 'HIGH', runaway: false, hours_to_limit: null, depot_id: 10, model_id: 6, duty_type_id: 1, region_id: 3,
    firmware: null, baseline_source: 'VAN',
    numbers: { level: 97, baseline_median: 90, deviation: 7, peer_adj: 0, z_level: 6, z_slope: 3, slope_per_h: 0.3, dtc_count_24h: 0, dtc_usual_per_day: 0 },
    clues: [], ...over,
  }; // prettier-ignore
}

/** Write the incident row as S3 does, then publish it (with S3's headers). */
async function raise(m: IncidentMessage): Promise<void> {
  await pool.query(
    `INSERT INTO core.incident (id, vin, fault_family, window_bucket, family_key, trigger, metric, status, severity, runaway,
       opened_ts, opened_seq, hours_to_limit, depot_id, model_id, duty_type_id, region_id, deviation, z_slope, slope_per_h)
     VALUES ($1, $2, $3, 0, $4, $5, $6, 'OPEN', $7, $8, $9, $10, $11, 10, 6, 1, 3, $12, $13, $14)
     ON CONFLICT (id) DO UPDATE SET severity = EXCLUDED.severity, runaway = EXCLUDED.runaway, hours_to_limit = EXCLUDED.hours_to_limit`,
    [m.incident_id, m.vin, m.fault_family, m.family_key, m.trigger, m.metric, m.severity, m.runaway, m.event_ts, m.seq,
     m.hours_to_limit, m.numbers.deviation, m.numbers.z_slope, m.numbers.slope_per_h],
  ); // prettier-ignore
  await send('incidents.v1', m.family_key, m, { 'x-incident-at': String(Date.now()) });
}

async function send(topic: string, key: string, value: unknown, headers: Record<string, string> = {}): Promise<void> {
  const producer = kafka.producer({ kafkaJS: { acks: -1 } });
  await producer.connect();
  await producer.send({ topic, messages: [{ key, value: JSON.stringify(value), headers }] });
  await producer.disconnect();
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const count = async (sql: string, args: unknown[] = []) => Number((await pool.query(sql, args)).rows[0].n);
const queue = async () =>
  (await pool.query<{ vin: string; rank: number; slot: string }>('SELECT vin::text AS vin, rank, slot FROM core.queue_item WHERE depot_id = 10 ORDER BY rank')).rows; // prettier-ignore

const start = () =>
  startWorkshop(
    loadConfig({
      KAFKA_BROKERS: redpanda.getBootstrapServers(),
      DATABASE_URL: dbUrl,
      OUTBOX_POLL_MS: '100',
      TICK_POLL_MS: '600000', // the test runs the hourly tick itself
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
  const vins = Array.from({ length: 10 }, (_, i) => `'${van(i + 1)}'`).join(',');
  await pool.query(`
    INSERT INTO core.tenant VALUES (1, 'T1', 'Tenant one');
    INSERT INTO core.fleet VALUES (1, 1, 'Fleet one');
    INSERT INTO core.region VALUES (3, 'R3', 'Coral Coast', 'HOT_HUMID', 30, 4);
    INSERT INTO core.depot VALUES (10, 'D-010', 1, 3, 22, 74, 't9abc', 'L');
    INSERT INTO core.workshop_bay (id, depot_id, bay_no, capability) VALUES (1, 10, 1, 'ANY'), (2, 10, 2, 'ANY');
    INSERT INTO core.oem VALUES (2, 'KES', 'Kestrel', '7KS', 'kestrel.v1');
    INSERT INTO core.vehicle_model VALUES (6, 2, 'KS-D1', 'Haulmark', 'DIESEL');
    INSERT INTO core.duty_type VALUES (1, 'URBAN', 'Urban', 10, 0.8);
    INSERT INTO core.vehicle (vin, tenant_id, fleet_id, model_id, duty_type_id, model_year, registered_at)
      SELECT v, 1, 1, 6, 1, 2024, now() FROM unnest(ARRAY[${vins}]) v;
    INSERT INTO core.vehicle_depot_assignment SELECT v, 10, tstzrange(NULL, NULL) FROM unnest(ARRAY[${vins}]) v;
    INSERT INTO core.campaign (id, family_key, fault_family, model_id, duty_type_id, depot_id, region_id, status, first_bucket,
      last_bucket, first_ts, last_ts, opened_ts, member_count)
      VALUES ('${CAMPAIGN}', 'COOLING|6|1|10', 'COOLING', 6, 1, 10, 3, 'OPEN', 0, 0, now(), now(), now(), 18);
    INSERT INTO core.campaign_member (campaign_id, vin, fault_family, first_incident_id, joined_ts)
      VALUES ('${CAMPAIGN}', '${MEMBER}', 'COOLING', gen_random_uuid(), now()), ('${CAMPAIGN}', '${BADFIX}', 'COOLING', gen_random_uuid(), now());
  `); // prettier-ignore
  kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: [redpanda.getBootstrapServers()], clientId: 'itest', logLevel: KafkaJS.logLevel.ERROR },
  });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [
      'incidents.v1',
      'campaign.events.v1',
      'workshop.repairs.v1',
      'queue.events.v1',
      'workshop.outcomes.v1',
    ].map((topic) => ({ topic, numPartitions: 2, replicationFactor: 1 })),
  });
  await admin.disconnect();
});

afterAll(async () => {
  await running?.stop();
  await pool?.end();
  await Promise.all([redpanda?.stop(), postgres?.stop()]);
});

describe('workshop against real Redpanda + TimescaleDB', () => {
  it('ranks, pins a runaway within seconds, confirms repairs, returns a bad repair, never duplicates', async () => {
    running = await start();
    // a worsening van, a loud-but-stable van (code-rate incident, flat) and two campaign members
    const worse = incident(WORSE);
    await raise(worse);
    await raise(
      incident(LOUD, {
        trigger: 'DTC_RATE',
        severity: 'WARN',
        metric: null,
        numbers: { ...worse.numbers, deviation: null, z_slope: null, slope_per_h: null },
      }),
    );
    await raise(incident(MEMBER, { severity: 'WARN' }));
    await raise(incident(BADFIX, { severity: 'WARN' }));
    await waitFor(async () => (await queue()).length === 4);
    let q = await queue();
    expect(q.findIndex((x) => x.vin === LOUD)).toBe(3); // below every van that is getting worse
    expect(q.find((x) => x.vin === LOUD)!.slot).toBe('WAITING');

    // critical → top of the queue within seconds, with one card
    const t = Date.now();
    await raise(incident(RUN, { severity: 'CRITICAL', runaway: true, hours_to_limit: 7, action: 'ESCALATE' }));
    await waitFor(async () => (await queue())[0]?.vin === RUN, 10_000);
    const seconds = (Date.now() - t) / 1000;
    expect(seconds).toBeLessThan(5);
    await waitFor(
      async () =>
        (await count(
          `SELECT count(*) AS n FROM core.alert_card WHERE card_type = 'RUNAWAY' AND queue_top_at IS NOT NULL`,
        )) === 1,
    );

    // repairs: WORSE is fixed (clean post-repair hours), BADFIX keeps drifting
    const repairedAt = new Date(T0 + 30 * HOUR + 17 * 60_000).toISOString();
    for (const vin of [WORSE, BADFIX]) await send('workshop.repairs.v1', vin, { vin, repaired_at: repairedAt });
    await waitFor(async () => (await count(`SELECT count(*) AS n FROM core.repair`)) === 2);
    expect((await queue()).map((x) => x.vin)).not.toContain(WORSE); // in the workshop's hands now
    await pool.query(
      `INSERT INTO core.telemetry (vin, ts, readings, coolant_z)
       SELECT $1, $3::timestamptz + make_interval(hours => h), 2, 0.4 FROM generate_series(1, 14) h
       UNION ALL SELECT $2, $3::timestamptz + make_interval(hours => h), 2, 4.5 FROM generate_series(1, 26) h`,
      [WORSE, BADFIX, new Date(T0 + 30 * HOUR).toISOString()],
    );
    await running.tick(T0 + 60 * HOUR);
    const outcomes = (
      await pool.query<{ vin: string; outcome: string }>(
        'SELECT vin::text AS vin, outcome FROM core.repair_outcome ORDER BY vin',
      )
    ).rows;
    expect(Object.fromEntries(outcomes.map((o) => [o.vin, o.outcome]))).toEqual({
      [WORSE]: 'FIXED',
      [BADFIX]: 'NOT_FIXED',
    });
    q = await queue();
    const back = (
      await pool.query<{ reasons: { type: string; text: string }[] }>(
        'SELECT reasons FROM core.queue_item WHERE vin = $1',
        [BADFIX],
      )
    ).rows[0]!;
    expect(back.reasons.map((r) => r.text)).toContain('repair on 2026-09-29 did not hold');
    expect(q.map((x) => x.vin)).not.toContain(WORSE);

    // outcomes leave on workshop.outcomes.v1 (key = VIN), once each
    await waitFor(async () => (await count(`SELECT count(*) AS n FROM core.outbox WHERE published_at IS NULL`)) === 0);
    const consumer = kafka.consumer({ kafkaJS: { groupId: 'itest-outcomes', fromBeginning: true } });
    await consumer.connect();
    await consumer.subscribe({ topics: ['workshop.outcomes.v1'] });
    const seen: string[] = [];
    void consumer.run({
      eachMessage: async ({ message }) => void seen.push(JSON.parse(message.value!.toString()).outcome),
    });
    await waitFor(() => seen.length >= 2, 30_000);
    await new Promise((r) => setTimeout(r, 1000));
    await consumer.disconnect();
    expect(seen.sort()).toEqual(['FIXED', 'NOT_FIXED']);

    // replays + a crash: no duplicate queue items, outcomes, cards or repairs
    const versions = await count('SELECT version AS n FROM core.queue_version WHERE depot_id = 10');
    await running.kill();
    running = await start();
    await send('incidents.v1', worse.family_key, worse);
    await send('workshop.repairs.v1', WORSE, { vin: WORSE, repaired_at: repairedAt });
    await new Promise((r) => setTimeout(r, 3000));
    await running.tick(T0 + 61 * HOUR);
    expect(await count('SELECT count(*) AS n FROM core.repair')).toBe(2);
    expect(await count('SELECT count(*) AS n FROM core.repair_outcome')).toBe(2);
    expect(await count(`SELECT count(*) AS n FROM core.alert_card`)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM core.queue_item WHERE depot_id = 10')).toBe((await queue()).length);
    expect(await count(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'workshop.outcomes.v1'`)).toBe(2);
    expect(await count('SELECT version AS n FROM core.queue_version WHERE depot_id = 10')).toBe(versions); // nothing changed
  });
});
