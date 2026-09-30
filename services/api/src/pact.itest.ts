import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Verifier } from '@pact-foundation/pact';
import { buildVin } from '@cw/domain';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createApp } from './app.js';
import { jwtVerifier } from './auth.js';

/**
 * Provider verification (S9): the real API (RLS as cw_api, real migrations) answers the web app's committed
 * contract (pacts/cohortwatch-web-cohortwatch-api.json, written by tests/contract). Requests carry a token signed
 * by a local test key; the verifier is the production one.
 */
const PG_IMAGE = 'timescale/timescaledb-ha:pg16.15-ts2.30.1';
const ISS = 'http://issuer.test';
const AUD = 'urn:cohortwatch:api';
const V1 = buildVin('7KS', 'HM1D8', 2024, 'K', 600001);
const C1 = '11111111-1111-5111-8111-111111111111';
const PACT = fileURLToPath(new URL('../../../pacts/cohortwatch-web-cohortwatch-api.json', import.meta.url));

let postgres: StartedTestContainer;
let admin: pg.Pool;
let pool: pg.Pool;
let server: Server;
let key: CryptoKey;

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
    INSERT INTO core.tenant VALUES (1, 'T1', 'Tenant one');
    INSERT INTO core.fleet VALUES (1, 1, 'Fleet one');
    INSERT INTO core.region VALUES (3, 'R3', 'Coral Coast', 'HOT_HUMID', 30, 4);
    INSERT INTO core.depot VALUES (10, 'D-010', 1, 3, 22.5, 74.25, 't9abc', 'L');
    INSERT INTO core.workshop_bay (id, depot_id, bay_no, capability) VALUES (1, 10, 1, 'ANY');
    INSERT INTO core.oem VALUES (2, 'KES', 'Kestrel', '7KS', 'kestrel.v1');
    INSERT INTO core.vehicle_model VALUES (6, 2, 'KS-D1', 'Haulmark', 'DIESEL');
    INSERT INTO core.duty_type VALUES (1, 'URBAN', 'Urban', 10, 0.8);
    INSERT INTO core.vehicle (vin, tenant_id, fleet_id, model_id, duty_type_id, model_year, registered_at)
      VALUES ('${V1}', 1, 1, 6, 1, 2024, now());
    INSERT INTO core.vehicle_depot_assignment VALUES ('${V1}', 10, tstzrange(NULL, NULL));
    INSERT INTO core.campaign (id, family_key, fault_family, model_id, duty_type_id, depot_id, region_id, status, first_bucket, last_bucket, first_ts, last_ts, opened_ts, member_count, version)
      VALUES ('${C1}', 'COOLING|6|1|10', 'COOLING', 6, 1, 10, 3, 'OPEN', 0, 0, now() - interval '3 hours', now(), now() - interval '3 hours', 18, 4);
    INSERT INTO core.queue_version (depot_id, version, as_of_ts) VALUES (10, 3, now());
    INSERT INTO core.queue_item (depot_id, vin, rank, slot, score, pinned, parts, reasons, cost_inr, cost_text, version)
      VALUES (10, '${V1}', 1, 'TODAY', 0.6, false, '{}', '[{"type":"CAMPAIGN","text":"member of COOLING campaign at D-010 (18 vans)"}]', 5100, 'waiting 1 day ≈ ₹5,100', 3);
  `);
  const kp = await generateKeyPair('RS256', { extractable: true });
  key = kp.privateKey;
  const verify = jwtVerifier(
    createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'test', alg: 'RS256' }] }),
    ISS,
    AUD,
  );
  const app = createApp({
    pool,
    verify,
    publisher: { publish: async () => undefined },
    bus: new EventEmitter(),
    topics: { audit: 'audit.v1', repairs: 'workshop.repairs.v1', proposals: 'agent.proposals.v1' },
    rateLimitPerMin: 10_000,
  });
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, () => res(s));
  });
});

afterAll(async () => {
  server?.close();
  await pool?.end();
  await admin?.end();
  await postgres?.stop();
});

describe('API honours the web contract (Pact provider verification)', () => {
  it('verifies pacts/cohortwatch-web-cohortwatch-api.json', async () => {
    const token = await new SignJWT({ role: 'lead', tenant_id: 1, name: 'pact' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setSubject('pact')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    await new Verifier({
      provider: 'cohortwatch-api',
      providerBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      pactUrls: [PACT],
      // the seed above is the state for both interactions
      stateHandlers: {
        'depot 10 has a queue': async () => undefined,
        'campaign C1 is open at depot 10': async () => undefined,
      },
      requestFilter: (req, _res, next) => {
        req.headers.authorization = `Bearer ${token}`;
        next();
      },
      logLevel: 'warn',
    }).verifyProvider();
  });
});
