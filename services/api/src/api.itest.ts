import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildVin } from '@cw/domain';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { createApp, type LiveEvent } from './app.js';
import { jwtVerifier, type Role } from './auth.js';

/**
 * S7 API integration test against real TimescaleDB with every migration (RLS, cw_api role). Tokens are signed with a
 * local test key; the verifier is the production one pointed at that key's JWKS.
 */
const PG_IMAGE = 'timescale/timescaledb-ha:pg16.15-ts2.30.1';
const ISS = 'http://issuer.test';
const AUD = 'urn:cohortwatch:api';
const V1 = buildVin('7KS', 'HM1D8', 2024, 'K', 600001); // tenant 1, depot 10
const V2 = buildVin('7KS', 'HM1D8', 2024, 'K', 600002); // tenant 2, depot 20
const C1 = '11111111-1111-5111-8111-111111111111';
const C1b = '11111111-1111-5111-8111-111111111112';
const C1c = '11111111-1111-5111-8111-111111111113';
const C2 = '22222222-2222-5222-8222-222222222222';
const P1 = '33333333-3333-5333-8333-333333333333';

let postgres: StartedTestContainer;
let admin: pg.Pool;
let pool: pg.Pool;
let key: CryptoKey;
let verify: ReturnType<typeof jwtVerifier>;
const published: { topic: string; key: string; value: unknown }[] = [];
const bus = new EventEmitter();

const token = (sub: string, role: Role, tenant = 1) =>
  new SignJWT({ role, tenant_id: tenant, name: sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

const app = (rateLimitPerMin = 1000) =>
  createApp({
    pool,
    verify,
    publisher: { publish: async (topic, k, value) => void published.push({ topic, key: k, value }) },
    bus,
    topics: { audit: 'audit.v1', repairs: 'workshop.repairs.v1', proposals: 'agent.proposals.v1' },
    rateLimitPerMin,
  });

const count = async (sql: string, args: unknown[] = []) => Number((await admin.query(sql, args)).rows[0].n);

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
  pool = new pg.Pool({ connectionString: `postgres://cw_api:api@${host}/cohortwatch`, max: 5 });
  await admin.query(`
    INSERT INTO core.tenant VALUES (1, 'T1', 'Tenant one'), (2, 'T2', 'Tenant two');
    INSERT INTO core.fleet VALUES (1, 1, 'Fleet one'), (5, 2, 'Fleet five');
    INSERT INTO core.region VALUES (3, 'R3', 'Coral Coast', 'HOT_HUMID', 30, 4);
    INSERT INTO core.depot VALUES (10, 'D-010', 1, 3, 22.5, 74.25, 't9abc', 'L'), (20, 'D-020', 5, 3, 21.1, 73.9, 't9xyz', 'L');
    INSERT INTO core.workshop_bay (id, depot_id, bay_no, capability) VALUES (1, 10, 1, 'ANY');
    INSERT INTO core.oem VALUES (2, 'KES', 'Kestrel', '7KS', 'kestrel.v1');
    INSERT INTO core.vehicle_model VALUES (6, 2, 'KS-D1', 'Haulmark', 'DIESEL');
    INSERT INTO core.duty_type VALUES (1, 'URBAN', 'Urban', 10, 0.8);
    INSERT INTO core.vehicle (vin, tenant_id, fleet_id, model_id, duty_type_id, model_year, registered_at)
      VALUES ('${V1}', 1, 1, 6, 1, 2024, now()), ('${V2}', 2, 5, 6, 1, 2024, now());
    INSERT INTO core.vehicle_depot_assignment VALUES ('${V1}', 10, tstzrange(NULL, NULL)), ('${V2}', 20, tstzrange(NULL, NULL));
    INSERT INTO core.driver VALUES (100, 1, 'drv-lark-17'), (200, 5, 'drv-owl-3');
    INSERT INTO core.driver_assignment VALUES (100, '${V1}', tstzrange(now() - interval '1 day', NULL)), (200, '${V2}', tstzrange(now() - interval '1 day', NULL));
    INSERT INTO core.campaign (id, family_key, fault_family, model_id, duty_type_id, depot_id, region_id, status, first_bucket, last_bucket, first_ts, last_ts, opened_ts, member_count, version)
      VALUES ('${C1}', 'COOLING|6|1|10', 'COOLING', 6, 1, 10, 3, 'OPEN', 0, 0, now() - interval '3 hours', now(), now() - interval '3 hours', 18, 4),
             ('${C1b}', 'EXHAUST|6|1|10', 'EXHAUST', 6, 1, 10, 3, 'OPEN', 0, 0, now() - interval '2 hours', now(), now() - interval '2 hours', 5, 1),
             ('${C1c}', 'LV_ELECTRICAL|6|1|10', 'LV_ELECTRICAL', 6, 1, 10, 3, 'OPEN', 0, 0, now() - interval '1 hours', now(), now() - interval '1 hours', 6, 1),
             ('${C2}', 'COOLING|6|1|20', 'COOLING', 6, 1, 20, 3, 'OPEN', 0, 0, now(), now(), now(), 7, 1);
    INSERT INTO core.queue_item (depot_id, vin, rank, slot, score, pinned, parts, reasons, cost_inr, cost_text, version)
      VALUES (10, '${V1}', 1, 'TODAY', 0.6, false, '{}', '[{"type":"CAMPAIGN","text":"member of COOLING campaign at D-010 (18 vans)"}]', 5100, 'waiting 1 day ≈ ₹5,100', 3);
    INSERT INTO core.proposal (id, tenant_id, depot_id, campaign_id, trigger, action_type, title, body, evidence, diff, payload)
      VALUES ('${P1}', 1, 10, '${C1}', 'test', 'BOOK_AT_RISK', 'Book 1 at-risk sister', 'b', '[]', '{}', '[{"vin":"${V1}","slot":"TOMORROW"}]');
  `);
  const kp = await generateKeyPair('RS256', { extractable: true });
  key = kp.privateKey;
  verify = jwtVerifier(
    createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'test', alg: 'RS256' }] }),
    ISS,
    AUD,
  );
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await postgres?.stop();
});

describe('API security and behaviour (real Postgres, RLS as cw_api)', () => {
  it('rejects missing, forged and wrong-audience tokens without leaking internals', async () => {
    await request(app()).get('/depots').expect(401);
    const forged = (await token('lead', 'lead')).slice(0, -4) + 'AAAA';
    await request(app()).get('/depots').set('Authorization', `Bearer ${forged}`).expect(401);
    const wrongAud = await new SignJWT({ role: 'lead', tenant_id: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISS)
      .setAudience('other')
      .setSubject('x')
      .setExpirationTime('1h')
      .sign(key);
    await request(app()).get('/depots').set('Authorization', `Bearer ${wrongAud}`).expect(401);
    const r = await request(app())
      .get('/campaigns?limit=0')
      .set('Authorization', `Bearer ${await token('lead', 'lead')}`)
      .expect(400);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js|stack/i);
    expect((await request(app()).get('/openapi.json')).body.paths['/depots/{id}/queue']).toBeDefined();
  });

  it('role matrix: viewer cannot dismiss, repair or approve; planner repairs but cannot approve', async () => {
    const viewer = `Bearer ${await token('viewer', 'viewer')}`;
    const planner = `Bearer ${await token('planner', 'planner')}`;
    await request(app())
      .post(`/campaigns/${C1}/dismiss`)
      .set('Authorization', viewer)
      .set('If-Match', '"4"')
      .send({ reason: 'no' })
      .expect(403);
    await request(app()).post(`/vehicles/${V1}/repair`).set('Authorization', viewer).send({}).expect(403);
    await request(app())
      .post(`/proposals/${P1}/approve`)
      .set('Authorization', viewer)
      .set('If-Match', '"1"')
      .expect(403);
    await request(app())
      .post(`/proposals/${P1}/approve`)
      .set('Authorization', planner)
      .set('If-Match', '"1"')
      .expect(403);
    await request(app()).get('/audit').set('Authorization', planner).expect(403);
    const r = await request(app())
      .post(`/vehicles/${V1}/repair`)
      .set('Authorization', planner)
      .send({ repaired_at: '2026-09-29T10:00:00.000Z' })
      .expect(202);
    expect(r.body).toEqual({ vin: V1, repaired_at: '2026-09-29T10:00:00.000Z' });
    expect(published.at(-1)).toMatchObject({ topic: 'workshop.repairs.v1', key: V1 });
  });

  it('row-level security: a tenant never sees another tenant rows', async () => {
    const lead1 = `Bearer ${await token('lead', 'lead', 1)}`;
    const lead2 = `Bearer ${await token('lead2', 'lead', 2)}`;
    const l1 = await request(app()).get('/campaigns').set('Authorization', lead1).expect(200);
    expect(l1.body.items.map((c: { id: string }) => c.id).sort()).toEqual([C1, C1b, C1c].sort());
    await request(app()).get(`/campaigns/${C2}`).set('Authorization', lead1).expect(404);
    await request(app()).get(`/vehicles/${V2}`).set('Authorization', lead1).expect(404);
    await request(app()).get('/depots/20/queue').set('Authorization', lead1).expect(404);
    const l2 = await request(app()).get('/campaigns').set('Authorization', lead2).expect(200);
    expect(l2.body.items.map((c: { id: string }) => c.id)).toEqual([C2]);
    // the database itself enforces it: cw_api with no tenant set sees nothing
    expect(Number((await pool.query('SELECT count(*) AS n FROM core.campaign')).rows[0].n)).toBe(0);
  });

  it('viewer masking: no driver, no precise location; lead sees both', async () => {
    const v = await request(app())
      .get(`/vehicles/${V1}`)
      .set('Authorization', `Bearer ${await token('viewer', 'viewer')}`)
      .expect(200);
    expect(v.body.driver).toBeNull();
    expect(v.body.depot).toEqual({ id: 10, code: 'D-010', region: 'Coral Coast', geohash5: 't9abc' });
    expect(JSON.stringify(v.body)).not.toMatch(/drv-|"lat"|"lon"/);
    const l = await request(app())
      .get(`/vehicles/${V1}`)
      .set('Authorization', `Bearer ${await token('lead', 'lead')}`)
      .expect(200);
    expect(l.body.driver).toEqual({ id: 100, pseudonym: 'drv-lark-17' });
    expect(l.body.depot.lat).toBe(22.5);
    const d = await request(app())
      .get('/depots')
      .set('Authorization', `Bearer ${await token('viewer', 'viewer')}`)
      .expect(200);
    expect(d.body.items[0].lat).toBeUndefined();
  });

  it('every view is audited (core.audit + an audit.v1 outbox row in the same transaction)', async () => {
    const before = await count('SELECT count(*) AS n FROM core.audit');
    const outbox = await count(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'audit.v1'`);
    const t = `Bearer ${await token('viewer', 'viewer')}`;
    await request(app()).get('/depots/10/queue').set('Authorization', t).expect(200);
    await request(app()).get(`/campaigns/${C1}`).set('Authorization', t).expect(200);
    await request(app()).get(`/vehicles/${V1}/normal`).set('Authorization', t).expect(200);
    expect(await count('SELECT count(*) AS n FROM core.audit')).toBe(before + 3);
    expect(await count(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'audit.v1'`)).toBe(outbox + 3);
    const last = (
      await admin.query(`SELECT actor, role, action, resource, resource_id FROM core.audit ORDER BY id DESC LIMIT 1`)
    ).rows[0];
    expect(last).toEqual({
      actor: 'viewer',
      role: 'viewer',
      action: 'VIEW',
      resource: 'vehicle_normal',
      resource_id: V1,
    });
  });

  it('keyset pagination: pages do not overlap and end with next = null', async () => {
    const t = `Bearer ${await token('lead', 'lead')}`;
    const p1 = await request(app()).get('/campaigns?limit=2').set('Authorization', t).expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.next).toBeTruthy();
    const p2 = await request(app()).get(`/campaigns?limit=2&after=${p1.body.next}`).set('Authorization', t).expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.next).toBeNull();
    const ids = [...p1.body.items, ...p2.body.items].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(3);
    await request(app()).get('/campaigns?after=@@@').set('Authorization', t).expect(400);
  });

  it('concurrency: If-Match is required; of two simultaneous approvals one wins and the other gets 409', async () => {
    const t = `Bearer ${await token('lead', 'lead')}`;
    await request(app())
      .post(`/campaigns/${C1b}/dismiss`)
      .set('Authorization', t)
      .send({ reason: 'known issue' })
      .expect(428);
    await request(app())
      .post(`/campaigns/${C1b}/dismiss`)
      .set('Authorization', t)
      .set('If-Match', '"7"')
      .send({ reason: 'known issue' })
      .expect(409);
    const ok = await request(app())
      .post(`/campaigns/${C1b}/dismiss`)
      .set('Authorization', t)
      .set('If-Match', '"1"')
      .send({ reason: 'known issue' })
      .expect(200);
    expect(ok.body).toEqual({ id: C1b, status: 'DISMISSED', version: 2 });
    expect(
      await count(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'campaign.events.v1' AND key = $1`, [C1b]),
    ).toBe(1);
    const [a, b] = await Promise.all([
      request(app()).post(`/proposals/${P1}/approve`).set('Authorization', t).set('If-Match', '"1"'),
      request(app()).post(`/proposals/${P1}/approve`).set('Authorization', t).set('If-Match', '"1"'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await count(`SELECT count(*) AS n FROM core.queue_booking WHERE vin = $1 AND slot = 'TOMORROW'`, [V1])).toBe(
      1,
    );
    expect(await count(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'agent.proposals.v1'`)).toBe(1);
  });

  it('the agent never approves its own proposals (database check)', async () => {
    await expect(
      admin.query(`UPDATE core.proposal SET status = 'APPROVED', decided_by = 'agent' WHERE id = $1`, [P1]),
    ).rejects.toThrow(/check constraint/);
  });

  it('right to erasure: pseudonymised, assignments removed, audited; lead only', async () => {
    await request(app())
      .delete('/drivers/100/personal-data')
      .set('Authorization', `Bearer ${await token('planner', 'planner')}`)
      .expect(403);
    const r = await request(app())
      .delete('/drivers/100/personal-data')
      .set('Authorization', `Bearer ${await token('lead', 'lead')}`)
      .expect(200);
    expect(r.body).toEqual({ id: 100, erased: true, assignments_removed: 1 });
    expect(
      (await admin.query('SELECT pseudonym, erased_at IS NOT NULL AS erased FROM core.driver WHERE id = 100')).rows[0],
    ).toEqual({ pseudonym: 'erased-100', erased: true });
    expect(await count('SELECT count(*) AS n FROM core.driver_assignment WHERE driver_id = 100')).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM core.audit WHERE action = 'ERASE' AND resource_id = '100'`)).toBe(1);
    await request(app())
      .delete('/drivers/200/personal-data')
      .set('Authorization', `Bearer ${await token('lead', 'lead')}`)
      .expect(404); // other tenant
  });

  it('rate limit: 429 after the configured requests per minute', async () => {
    const a = app(3);
    const t = `Bearer ${await token('ratey', 'viewer')}`;
    for (let i = 0; i < 3; i++) await request(a).get('/me').set('Authorization', t).expect(200);
    await request(a).get('/me').set('Authorization', t).expect(429);
  });

  it('SSE delivers a change to its own tenant only', async () => {
    const server = app().listen(0);
    const port = (server.address() as AddressInfo).port;
    const tok = await token('lead', 'lead', 1);
    const res = await fetch(`http://127.0.0.1:${port}/events?access_token=${tok}`);
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 200));
    bus.emit('event', { tenantId: 2, type: 'queue', data: { depot_id: 20, secret: true } } satisfies LiveEvent);
    bus.emit('event', { tenantId: 1, type: 'queue', data: { depot_id: 10, version: 5 } } satisfies LiveEvent);
    let text = '';
    const deadline = Date.now() + 5000;
    while (!text.includes('depot_id') && Date.now() < deadline)
      text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    server.close();
    expect(text).toContain('event: queue\ndata: {"depot_id":10,"version":5}');
    expect(text).not.toContain('secret');
  });
});

// ---- BDD: brief §1.7 item 10 (tests/bdd/api.feature), same container and seed as above ----
const feature = await loadFeature('tests/bdd/api.feature');

describeFeature(feature, ({ Scenario }) => {
  Scenario('A viewer cannot see precise locations or drivers', ({ Given, When, Then, And }) => {
    let body: { depot: Record<string, unknown>; driver: unknown } = { depot: {}, driver: null };
    Given('a van at depot D-010 with a driver assigned', async () => {
      // the erasure test above removed driver 100's assignment: assign a fresh driver
      await admin.query(`INSERT INTO core.driver VALUES (101, 1, 'drv-wren-5')`);
      await admin.query(
        `INSERT INTO core.driver_assignment VALUES (101, $1, tstzrange(now() - interval '1 hour', NULL))`,
        [V1],
      );
    });
    When('a viewer opens the van', async () => {
      const t = `Bearer ${await token('viewer', 'viewer')}`;
      body = (await request(app()).get(`/vehicles/${V1}`).set('Authorization', t).expect(200)).body;
    });
    Then('the depot shows only its code, region and a coarse geohash', () => {
      expect(Object.keys(body.depot).sort()).toEqual(['code', 'geohash5', 'id', 'region']);
    });
    And('no driver is shown', () => expect(body.driver).toBeNull());
    When('a lead opens the same van', async () => {
      const t = `Bearer ${await token('lead', 'lead')}`;
      body = (await request(app()).get(`/vehicles/${V1}`).set('Authorization', t).expect(200)).body;
    });
    Then('the lead sees the depot coordinates and the driver pseudonym', () => {
      expect(body.depot.lat).toBe(22.5);
      expect(body.driver).toEqual({ id: 101, pseudonym: 'drv-wren-5' });
    });
  });

  Scenario('Every view is audited', ({ Given, When, Then, And }) => {
    let t = '';
    let audits = 0;
    let outbox = 0;
    Given('a viewer is logged in', async () => {
      t = `Bearer ${await token('viewer-bdd', 'viewer')}`;
      audits = await count(`SELECT count(*) AS n FROM core.audit`);
      outbox = await count(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'audit.v1'`);
    });
    When('the viewer opens the depot queue, a campaign and a vehicle chart', async () => {
      await request(app()).get('/depots/10/queue').set('Authorization', t).expect(200);
      await request(app()).get(`/campaigns/${C1}`).set('Authorization', t).expect(200);
      await request(app()).get(`/vehicles/${V1}/normal`).set('Authorization', t).expect(200);
    });
    Then('3 audit rows are written with who, role and what was viewed', async () => {
      expect(await count(`SELECT count(*) AS n FROM core.audit`)).toBe(audits + 3);
      const rows = await admin.query(
        `SELECT actor, role, resource FROM core.audit WHERE actor = 'viewer-bdd' ORDER BY id`,
      );
      expect(rows.rows.map((r) => `${r.actor}/${r.role}/${r.resource}`)).toEqual([
        'viewer-bdd/viewer/depot_queue',
        'viewer-bdd/viewer/campaign',
        'viewer-bdd/viewer/vehicle_normal',
      ]);
    });
    And('3 audit events wait in the outbox for audit.v1', async () => {
      expect(await count(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'audit.v1'`)).toBe(outbox + 3);
    });
  });
});
