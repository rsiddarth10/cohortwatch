import { resolve } from 'node:path';
import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

/**
 * Consumer contract (S9): what the web app (apps/web) needs from the API for the depot board and the campaign page.
 * Type matchers only for the fields the UI reads, so the API may add fields freely. The pact file is committed
 * (pacts/) and verified against the real API in services/api/src/pact.itest.ts (CI integration job).
 */
const { like, eachLike, integer, string, decimal, boolean, uuid, regex } = MatchersV3;
const C1 = '11111111-1111-5111-8111-111111111111';
const AUTH = regex(/^Bearer [A-Za-z0-9._-]+$/, 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig');

const provider = new PactV3({
  consumer: 'cohortwatch-web',
  provider: 'cohortwatch-api',
  dir: resolve(__dirname, '../../pacts'),
  logLevel: 'warn',
});

/** The same request shape as apps/web/src/api.ts: bearer token, JSON back. */
const get = async (base: string, path: string) => {
  const r = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig' } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('web → API contract', () => {
  it('depot board: GET /depots/:id/queue', async () => {
    provider
      .given('depot 10 has a queue')
      .uponReceiving('the depot board for depot 10')
      .withRequest({ method: 'GET', path: '/depots/10/queue', headers: { authorization: AUTH } })
      .willRespondWith({
        status: 200,
        body: {
          depot: like({ id: 10, code: 'D-010', region: 'Coral Coast', geohash5: 't9abc' }),
          version: integer(3),
          bays: integer(1),
          today: eachLike({
            rank: integer(1),
            slot: string('TODAY'),
            vin: string('7KSHM1D84KK600001'),
            score: decimal(0.6),
            pinned: boolean(false),
            reasons: eachLike({
              type: string('CAMPAIGN'),
              text: string('member of COOLING campaign at D-010 (18 vans)'),
            }),
            cost_inr: integer(5100),
            cost_text: string('waiting 1 day ≈ ₹5,100'),
          }),
          tomorrow: like([]),
          waiting: like([]),
          cards: like([]),
          watching: like([]),
        },
      });
    await provider.executeTest(async (server) => {
      const r = await get(server.url, '/depots/10/queue');
      expect(r.status).toBe(200);
      expect((r.body.today as unknown[]).length).toBeGreaterThan(0);
    });
  });

  it('campaign page: GET /campaigns/:id', async () => {
    provider
      .given('campaign C1 is open at depot 10')
      .uponReceiving('the campaign page for C1')
      .withRequest({ method: 'GET', path: `/campaigns/${C1}`, headers: { authorization: AUTH } })
      .willRespondWith({
        status: 200,
        headers: { etag: regex(/^"\d+"$/, '"4"') },
        body: {
          campaign: like({
            id: uuid(C1),
            fault_family: 'COOLING',
            status: 'OPEN',
            member_count: 18,
            at_risk_count: 0,
            depot_id: 10,
            depot: 'D-010',
            model: 'KS-D1',
            duty: 'URBAN',
            version: 4,
          }),
          members: like([]),
          at_risk: like([]),
          clues: like([]),
          similar: like([]),
          overrides: like([]),
          history: like([]),
          notes: like([]),
          proposals: like([]),
        },
      });
    await provider.executeTest(async (server) => {
      const r = await get(server.url, `/campaigns/${C1}`);
      expect(r.status).toBe(200);
      expect((r.body.campaign as { id: string }).id).toBe(C1);
    });
  });
});
