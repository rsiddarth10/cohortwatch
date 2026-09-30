import { fileURLToPath } from 'node:url';
import { buildVin } from '@cw/domain';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from './main.js';

/** S8 agent against real TimescaleDB with every migration, as cw_app: notes, proposal, outbox, idempotency. */
const PG_IMAGE = 'timescale/timescaledb-ha:pg16.15-ts2.30.1';
const C1 = '11111111-1111-5111-8111-111111111111';
const vin = (n: number) => buildVin('7KS', 'HM1D8', 2024, 'K', 600000 + n);
const [RUN, A, S1, S2] = [vin(1), vin(2), vin(3), vin(4)];

let postgres: StartedTestContainer;
let admin: pg.Pool;
let pool: pg.Pool;
const n = async (sql: string) => Number((await admin.query(sql)).rows[0].n);

beforeAll(async () => {
  postgres = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_PASSWORD: 'pw' })
    .withExposedPorts(5432)
    .withCopyDirectoriesToContainer([
      { source: fileURLToPath(new URL('../../../infra/db', import.meta.url)), target: '/cw-db' },
    ])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const mig = await postgres.exec(['sh', '/cw-db/migrate.sh'], {
    env: {
      PGHOST: 'localhost',
      PGUSER: 'postgres',
      PGPASSWORD: 'pw',
      CW_SIM_PASSWORD: 'sim',
      CW_APP_PASSWORD: 'app',
      CW_API_PASSWORD: 'api',
      MIGRATIONS_DIR: '/cw-db/migrations',
    },
  });
  if (mig.exitCode !== 0) throw new Error(`migrations failed: ${mig.output}`);
  const host = `${postgres.getHost()}:${postgres.getMappedPort(5432)}`;
  admin = new pg.Pool({ connectionString: `postgres://postgres:pw@${host}/cohortwatch`, max: 2 });
  pool = new pg.Pool({ connectionString: `postgres://cw_app:app@${host}/cohortwatch`, max: 3 });
  const q = (v: string, rank: number, slot: string, pinned: boolean, score: number) =>
    `(10, '${v}', ${rank}, '${slot}', ${score}, ${pinned}, '{}', '[{"type":"${pinned ? 'RUNAWAY' : 'TREND'}","text":"${pinned ? 'runaway: ≈ 6 h to 110 °C' : 'getting worse'}"}]', 0, '', 1)`;
  await admin.query(`
    INSERT INTO core.tenant VALUES (1, 'T1', 'Tenant one');
    INSERT INTO core.fleet VALUES (1, 1, 'Fleet one');
    INSERT INTO core.region VALUES (3, 'R3', 'Coral Coast', 'HOT_HUMID', 30, 4);
    INSERT INTO core.depot VALUES (10, 'D-010', 1, 3, 22.5, 74.25, 't9abc', 'L');
    INSERT INTO core.workshop_bay (id, depot_id, bay_no, capability) VALUES (1, 10, 1, 'ANY');
    INSERT INTO core.oem VALUES (2, 'KES', 'Kestrel', '7KS', 'kestrel.v1');
    INSERT INTO core.vehicle_model VALUES (6, 2, 'KS-D1', 'Haulmark', 'DIESEL');
    INSERT INTO core.duty_type VALUES (1, 'URBAN', 'Urban', 10, 0.8);
    INSERT INTO core.vehicle (vin, tenant_id, fleet_id, model_id, duty_type_id, model_year, registered_at)
      SELECT v, 1, 1, 6, 1, 2024, now() FROM unnest(ARRAY['${RUN}', '${A}', '${S1}', '${S2}']) v;
    INSERT INTO core.vehicle_depot_assignment SELECT v, 10, tstzrange(NULL, NULL) FROM unnest(ARRAY['${RUN}', '${A}', '${S1}', '${S2}']) v;
    INSERT INTO core.campaign (id, family_key, fault_family, model_id, duty_type_id, depot_id, region_id, status, first_bucket, last_bucket, first_ts, last_ts, opened_ts, member_count, version)
      VALUES ('${C1}', 'COOLING|6|1|10', 'COOLING', 6, 1, 10, 3, 'OPEN', 0, 0, now(), now(), now(), 14, 1);
    INSERT INTO core.campaign_clue VALUES ('${C1}', 0, 'PLACE', '14 KS-D1 vans on urban duty at D-010', 14, 'vans'),
      ('${C1}', 1, 'TREND', 'typical member 4.1 °C above its own normal', 4.1, '°C');
    INSERT INTO core.campaign_at_risk VALUES ('${C1}', '${S1}', true, now(), now(), 'above its own normal in 3 of the last 4 hours'),
      ('${C1}', '${S2}', true, now(), now(), 'rising faster than its usual rate');
    INSERT INTO core.queue_item (depot_id, vin, rank, slot, score, pinned, parts, reasons, cost_inr, cost_text, version) VALUES
      ${q(A, 1, 'TODAY', false, 0.7)}, ${q(RUN, 2, 'TOMORROW', true, 1)}, ${q(S1, 3, 'WAITING', false, 0.2)}, ${q(S2, 4, 'WAITING', false, 0.1)};
  `);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await postgres?.stop();
});

describe('template agent service (real Postgres as cw_app)', () => {
  it('campaign event → polite notes applied, one PENDING proposal + outbox row; a repeat does nothing', async () => {
    const agent = new Agent(pool, 'agent.proposals.v1');
    const e = { type: 'OPENED', campaignId: C1, eventId: 'ev-1' };
    expect(await agent.onCampaignEvent(e)).toEqual({ notes: 3, proposal: 'CREATED' });
    expect(await agent.onCampaignEvent(e)).toBeNull(); // same event id
    expect(await agent.onCampaignEvent({ ...e, type: 'GREW', eventId: 'ev-2' })).toEqual({ notes: 3, proposal: null });
    expect(await n(`SELECT count(*) AS n FROM core.agent_note`)).toBe(3);
    const p = (await admin.query(`SELECT action_type, status, created_by, tenant_id, payload, diff FROM core.proposal`))
      .rows;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ action_type: 'BOOK_AT_RISK', status: 'PENDING', created_by: 'agent', tenant_id: 1 });
    expect(p[0].payload).toEqual([
      { vin: S1, slot: 'TOMORROW' },
      { vin: S2, slot: 'TOMORROW' },
    ]);
    expect(p[0].diff.summary).toMatch(/1 van moves into tomorrow's bays/);
    expect(await n(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'agent.proposals.v1'`)).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM core.queue_booking`)).toBe(0); // disruptive: never applied by itself
  });

  it('one live proposal per campaign: updated in place when the sisters change, withdrawn when none are left', async () => {
    const agent = new Agent(pool, 'agent.proposals.v1');
    await admin.query(`UPDATE core.campaign_at_risk SET active = false WHERE vin = $1`, [S2]);
    expect((await agent.onCampaignEvent({ type: 'AT_RISK_CHANGED', campaignId: C1, eventId: 'ev-3' }))!.proposal).toBe(
      'UPDATED',
    );
    const live = (
      await admin.query(`SELECT status, version, payload FROM core.proposal WHERE action_type = 'BOOK_AT_RISK'`)
    ).rows;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'PENDING', version: 2, payload: [{ vin: S1, slot: 'TOMORROW' }] });
    await admin.query(`UPDATE core.campaign_at_risk SET active = false`);
    expect((await agent.onCampaignEvent({ type: 'AT_RISK_CHANGED', campaignId: C1, eventId: 'ev-4' }))!.proposal).toBe(
      'WITHDRAWN',
    );
    await admin.query(`UPDATE core.campaign_at_risk SET active = true`);
    // the original set returns: the withdrawn proposal with that id comes back to life
    expect((await agent.onCampaignEvent({ type: 'AT_RISK_CHANGED', campaignId: C1, eventId: 'ev-5' }))!.proposal).toBe(
      'CREATED',
    );
    const all = (
      await admin.query(`SELECT status, payload FROM core.proposal WHERE action_type = 'BOOK_AT_RISK' ORDER BY status`)
    ).rows;
    expect(all.map((r) => r.status)).toEqual(['PENDING']);
    expect(all[0].payload).toHaveLength(2);
    expect(await n(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'agent.proposals.v1'`)).toBe(4);
  });

  it('a runaway outside today → a MOVE_RUNAWAY proposal; the same queue version again does nothing', async () => {
    const agent = new Agent(pool, 'agent.proposals.v1');
    const e = { depot_id: 10, version: 1, items: [{ vin: RUN, slot: 'TOMORROW', pinned: true }] };
    expect(await agent.onQueueEvent(e)).toBe(true);
    expect(await agent.onQueueEvent(e)).toBe(false);
    const p = (await admin.query(`SELECT body FROM core.proposal WHERE action_type = 'MOVE_RUNAWAY'`)).rows;
    expect(p[0].body).toMatch(/^runaway: ≈ 6 h to 110 °C\. It is booked for tomorrow now\./);
  });
});
