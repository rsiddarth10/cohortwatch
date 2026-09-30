import { EventEmitter } from 'node:events';
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { CAMPAIGN_EVENT_NAMESPACE, uuidV5 } from '@cw/domain';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type pg from 'pg';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import { z } from 'zod';
import { authenticate, requireRole, type User, type Verifier } from './auth.js';
import { audit, maskDepot, maskDriver, withTenant, type Q } from './db.js';

extendZodWithOpenApi(z);

/**
 * The CohortWatch API (S7). Every request: OIDC JWT → role + tenant → one transaction as cw_api with the tenant set
 * (row-level security) → an audit row (every view is audited) → a masked response for viewers.
 */
export interface Publisher {
  publish(topic: string, key: string, value: unknown): Promise<void>;
}

/** Live changes for SSE: `{ tenantId, type, data }`, emitted by the Kafka/card feeds in main.ts (or a test). */
export interface LiveEvent {
  tenantId: number;
  type: string;
  data: unknown;
}

export interface AppDeps {
  pool: pg.Pool;
  verify: Verifier;
  publisher: Publisher;
  bus: EventEmitter;
  topics: { audit: string; repairs: string; proposals: string };
  rateLimitPerMin: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const HOUR = 3_600_000;

// ---- validation + OpenAPI --------------------------------------------------------------------------
const registry = new OpenAPIRegistry();
const bearer = registry.registerComponent('securitySchemes', 'oidc', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});
const Vin = z
  .string()
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/)
  .openapi({ example: '7KSHM1D80RK100052' });
const Uuid = z.uuid();
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().max(200).optional(),
});
const CampaignList = Page.extend({ status: z.enum(['OPEN', 'DISMISSED', 'CLOSED', 'WATCHING']).optional() });
const DismissBody = z.object({ reason: z.string().min(3).max(500) });
const RepairBody = z.object({ repaired_at: z.iso.datetime().optional() });
const NormalQuery = z.object({ metric: z.enum(['coolant_c', 'batt_temp_c', 'lv_batt_v']).optional() });
const ProposalList = Page.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() });
const DepotId = z.object({ id: z.coerce.number().int().positive() });

function doc(
  method: 'get' | 'post' | 'delete',
  path: string,
  summary: string,
  extra: Record<string, unknown> = {},
): void {
  registry.registerPath({
    method,
    path,
    summary,
    security: [{ [bearer.name]: [] }],
    responses: {
      200: { description: 'OK' },
      401: { description: 'no/invalid token' },
      403: { description: 'role not allowed' },
    },
    ...extra,
  });
}
doc('get', '/me', 'The signed-in user (role, tenant)');
doc('get', '/depots', "The tenant's depots (viewers: no precise location)");
doc(
  'get',
  '/depots/{id}/queue',
  "A depot's queue: today / tomorrow / waiting, reasons, cost of waiting, bays, cards, watching",
  { request: { params: DepotId } },
);
doc('get', '/campaigns', 'Campaigns (keyset pagination: opened_ts desc, id)', { request: { query: CampaignList } });
doc(
  'get',
  '/campaigns/{id}',
  'A campaign: members, at-risk sisters, clues, similar past campaigns, history (ETag = version)',
  { request: { params: z.object({ id: Uuid }) } },
);
doc('post', '/campaigns/{id}/dismiss', '"Not an outbreak" (lead; sticky; If-Match: version)', {
  request: { params: z.object({ id: Uuid }), body: { content: { 'application/json': { schema: DismissBody } } } },
});
doc('get', '/vehicles/{vin}', 'A van: registry, depot, incidents, repairs, queue position (viewers: masked)', {
  request: { params: z.object({ vin: Vin }) },
});
doc('get', '/vehicles/{vin}/normal', 'Hourly values vs its own normal band, incident and repair markers', {
  request: { params: z.object({ vin: Vin }), query: NormalQuery },
});
doc('post', '/vehicles/{vin}/repair', 'Mark repaired (planner, lead): publishes workshop.repairs.v1', {
  request: { params: z.object({ vin: Vin }), body: { content: { 'application/json': { schema: RepairBody } } } },
});
doc('get', '/cards', 'Cards: runaways and new/growing campaigns', { request: { query: Page } });
doc('get', '/proposals', 'Agent proposals with evidence and dry-run diff', { request: { query: ProposalList } });
doc('post', '/proposals/{id}/approve', 'Approve (lead; If-Match: version)', {
  request: { params: z.object({ id: Uuid }) },
});
doc('post', '/proposals/{id}/reject', 'Reject (lead; If-Match: version)', {
  request: { params: z.object({ id: Uuid }) },
});
doc('get', '/audit', 'Audit log (lead; keyset: id desc)', { request: { query: Page } });
doc(
  'delete',
  '/drivers/{id}/personal-data',
  'Right to erasure (lead): pseudonymise the driver, drop assignments, keep aggregates',
  { request: { params: DepotId } },
);
doc('get', '/events', 'Server-sent events: queue, campaign, card and proposal changes (token as access_token query)');

export function openApiDocument(): unknown {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'CohortWatch API',
      version: '1.0.0',
      description: 'Roles: lead, planner, viewer (OIDC). Every call is audited; viewers get masked data.',
    },
    servers: [{ url: '/api' }],
  });
}

// ---- helpers -----------------------------------------------------------------------------------------
const cursor = {
  encode: (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url'),
  decode: <T>(s: string | undefined): T | null => {
    if (!s) return null;
    try {
      return JSON.parse(Buffer.from(s, 'base64url').toString()) as T;
    } catch {
      throw new HttpError(400, 'bad cursor');
    }
  },
};

/** If-Match: `"7"` / `7` / `W/"7"`. Missing → 428; the current version is compared in SQL (409 when stale). */
function ifMatch(req: Request): number {
  const h = req.header('if-match');
  if (!h) throw new HttpError(428, 'If-Match (the version you read) is required');
  const n = Number(h.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n)) throw new HttpError(400, 'bad If-Match');
  return n;
}

const band = (median: number, mad: number, floor: number) => {
  const w = 3 * 1.4826 * Math.max(mad, floor);
  return { median, lo: median - w, hi: median + w };
};

export function createApp(d: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': ["'self'", 'https://unpkg.com'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        },
      },
    }),
  );
  app.use(express.json({ limit: '32kb' }));

  const metrics = new Registry();
  collectDefaultMetrics({ register: metrics, prefix: 'cw_api_' });
  const http = new Histogram({
    name: 'cw_api_http_seconds',
    help: 'HTTP request time by route',
    labelNames: ['route', 'method', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [metrics],
  });
  app.use((req, res, next) => {
    const end = http.startTimer();
    res.on('finish', () =>
      end({ route: (req.route?.path as string) ?? 'other', method: req.method, status: String(res.statusCode) }),
    );
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/metrics', (_req, res, next) => {
    metrics.metrics().then((b) => res.type(metrics.contentType).send(b), next);
  });
  app.get('/openapi.json', (_req, res) => res.json(openApiDocument()));
  app.get('/docs', (_req, res) =>
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>CohortWatch API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script src="/api/docs-init.js"></script></body></html>`),
  );
  app.get('/docs-init.js', (_req, res) =>
    res.type('js').send(`SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#ui' });`),
  );

  app.use(authenticate(d.verify));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: d.rateLimitPerMin,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => req.user?.sub ?? 'anonymous',
      message: { error: 'rate limit exceeded' },
    }),
  );

  const h =
    (fn: (req: Request, res: Response, user: User) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req, res, req.user!).catch(next);
    };
  const tx = <T>(user: User, fn: (c: pg.PoolClient) => Promise<T>) => withTenant(d.pool, user, fn);
  const view = (c: Q, user: User, resource: string, resourceId?: string | null, details?: Record<string, unknown>) =>
    audit(c, user, { action: 'VIEW', resource, resourceId: resourceId ?? null, details }, d.topics.audit);

  app.get(
    '/me',
    h(async (_req, res, user) => void res.json(user)),
  );

  app.get(
    '/depots',
    h(async (_req, res, user) => {
      const out = await tx(user, async (c) => {
        const r = await c.query<{ id: number; code: string; region: string; lat: number; lon: number; geohash5: string; bays: number; today: number; queued: number; open_campaigns: number }>(
          `SELECT d.id, d.code, r.name AS region, d.lat, d.lon, d.geohash5,
             (SELECT count(*)::int FROM core.workshop_bay b WHERE b.depot_id = d.id) AS bays,
             (SELECT count(*)::int FROM core.queue_item q WHERE q.depot_id = d.id AND q.slot = 'TODAY') AS today,
             (SELECT count(*)::int FROM core.queue_item q WHERE q.depot_id = d.id) AS queued,
             (SELECT count(*)::int FROM core.campaign g WHERE g.depot_id = d.id AND g.status = 'OPEN') AS open_campaigns
           FROM core.depot d JOIN core.region r ON r.id = d.region_id ORDER BY open_campaigns DESC, queued DESC, d.id`,
        ); // prettier-ignore
        await view(c, user, 'depots');
        return r.rows.map((x) => ({
          ...maskDepot(x, user.role),
          bays: x.bays,
          today: x.today,
          queued: x.queued,
          open_campaigns: x.open_campaigns,
        }));
      });
      res.json({ items: out });
    }),
  );

  app.get(
    '/depots/:id/queue',
    h(async (req, res, user) => {
      const { id } = DepotId.parse(req.params);
      const out = await tx(user, async (c) => {
        const dep = await c.query<{
          id: number;
          code: string;
          region: string;
          lat: number;
          lon: number;
          geohash5: string;
        }>(
          'SELECT d.id, d.code, r.name AS region, d.lat, d.lon, d.geohash5 FROM core.depot d JOIN core.region r ON r.id = d.region_id WHERE d.id = $1',
          [id],
        );
        if (!dep.rows[0]) throw new HttpError(404, 'depot not found');
        const [items, ver, bays, cards, watching, bookings] = [
          await c.query(`SELECT rank, slot, vin::text AS vin, round(score::numeric, 3)::float8 AS score, pinned, reasons, cost_inr, cost_text, version
                         FROM core.queue_item WHERE depot_id = $1 ORDER BY rank`, [id]),
          await c.query<{ version: number; as_of_ts: Date; updated_at: Date }>('SELECT version, as_of_ts, updated_at FROM core.queue_version WHERE depot_id = $1', [id]),
          await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.workshop_bay WHERE depot_id = $1', [id]),
          await c.query(`SELECT id, card_type, vin::text AS vin, campaign_id, title, event_ts, created_at, status, version FROM core.alert_card
                         WHERE depot_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
          await c.query(`SELECT id, fault_family, member_count, p_value, first_ts, last_ts FROM core.campaign
                         WHERE depot_id = $1 AND status = 'WATCHING' AND member_count >= 2 ORDER BY member_count DESC LIMIT 10`, [id]),
          await c.query(`SELECT vin::text AS vin, slot, proposal_id, booked_by FROM core.queue_booking WHERE depot_id = $1`, [id]),
        ]; // prettier-ignore
        await view(c, user, 'depot_queue', String(id));
        const bySlot = (s: string) => items.rows.filter((x: { slot: string }) => x.slot === s);
        return {
          depot: maskDepot(dep.rows[0], user.role),
          version: ver.rows[0]?.version ?? 0,
          as_of_ts: ver.rows[0]?.as_of_ts ?? null,
          updated_at: ver.rows[0]?.updated_at ?? null,
          bays: bays.rows[0]!.n,
          today: bySlot('TODAY'),
          tomorrow: bySlot('TOMORROW'),
          waiting: bySlot('WAITING'),
          cards: cards.rows,
          watching: watching.rows,
          bookings: bookings.rows,
        };
      });
      res.json(out);
    }),
  );

  app.get(
    '/campaigns',
    h(async (req, res, user) => {
      const q = CampaignList.parse(req.query);
      const after = cursor.decode<{ t: string; id: string }>(q.after);
      const out = await tx(user, async (c) => {
        const r = await c.query<{ id: string; opened_ts: Date | null; first_ts: Date }>(
          `SELECT c.id, c.family_key, c.fault_family, c.status, c.member_count, c.at_risk_count, c.opened_ts, c.first_ts,
                  c.p_value, c.cost_inr, c.version, d.code AS depot, m.code AS model, dt.code AS duty
           FROM core.campaign c JOIN core.depot d ON d.id = c.depot_id JOIN core.vehicle_model m ON m.id = c.model_id
           JOIN core.duty_type dt ON dt.id = c.duty_type_id
           WHERE c.status = coalesce($1, c.status) AND c.status <> 'MERGED' AND ($1 IS NOT NULL OR c.status <> 'WATCHING')
             AND ($2::timestamptz IS NULL OR (coalesce(c.opened_ts, c.first_ts), c.id) < ($2::timestamptz, $3::uuid))
           ORDER BY coalesce(c.opened_ts, c.first_ts) DESC, c.id DESC LIMIT $4`,
          [q.status ?? null, after?.t ?? null, after?.id ?? null, q.limit],
        ); // prettier-ignore
        await view(c, user, 'campaigns', null, { status: q.status ?? null });
        return r.rows;
      });
      const last = out.length === q.limit ? out[out.length - 1]! : null;
      const lastTs = last ? (last.opened_ts ?? last.first_ts) : null;
      res.json({
        items: out,
        next: last && lastTs ? cursor.encode({ t: new Date(lastTs).toISOString(), id: last.id }) : null,
      });
    }),
  );

  app.get(
    '/campaigns/:id',
    h(async (req, res, user) => {
      const id = Uuid.parse(req.params.id);
      const out = await tx(user, async (c) => {
        const g = await c.query<{ version: number; depot_id: number }>(
          `SELECT c.*, d.code AS depot, m.code AS model, dt.code AS duty FROM core.campaign c JOIN core.depot d ON d.id = c.depot_id
           JOIN core.vehicle_model m ON m.id = c.model_id JOIN core.duty_type dt ON dt.id = c.duty_type_id WHERE c.id = $1`,
          [id],
        );
        if (!g.rows[0]) throw new HttpError(404, 'campaign not found');
        const [members, atRisk, clues, similar, overrides, history, notes, proposals] = [
          await c.query(`SELECT vin::text AS vin, joined_ts, runaway, fixed, deviation, slope_per_h, last_code, firmware
                         FROM core.campaign_member WHERE campaign_id = $1 AND active ORDER BY joined_ts`, [id]),
          await c.query(`SELECT vin::text AS vin, first_ts, last_ts, reason FROM core.campaign_at_risk WHERE campaign_id = $1 AND active ORDER BY first_ts`, [id]),
          await c.query(`SELECT ord, clue_type, text, value, unit FROM core.campaign_clue WHERE campaign_id = $1 ORDER BY ord`, [id]),
          await c.query(`SELECT s.rank, s.similarity, p.code, p.fault_family, p.members, p.root_cause, p.resolution
                         FROM core.campaign_similar s JOIN core.past_campaign p ON p.id = s.past_campaign_id WHERE s.campaign_id = $1 ORDER BY s.rank`, [id]),
          await c.query(`SELECT action, by_user, reason, members_at, created_at FROM core.campaign_override WHERE campaign_id = $1 ORDER BY id`, [id]),
          await c.query(`SELECT payload->>'type' AS type, (payload->>'members')::int AS members, payload->>'ts' AS ts, created_at
                         FROM core.outbox WHERE topic = 'campaign.events.v1' AND key = $1 ORDER BY created_at`, [id]),
          await c.query(`SELECT kind, vin::text AS vin, text, evidence, created_at FROM core.agent_note WHERE campaign_id = $1 ORDER BY id`, [id]),
          await c.query(`SELECT id, action_type, title, status, version, created_at FROM core.proposal WHERE campaign_id = $1 ORDER BY created_at DESC`, [id]),
        ]; // prettier-ignore
        await view(c, user, 'campaign', id);
        return {
          campaign: g.rows[0],
          members: members.rows,
          at_risk: atRisk.rows,
          clues: clues.rows,
          similar: similar.rows,
          overrides: overrides.rows,
          history: history.rows,
          notes: notes.rows,
          proposals: proposals.rows,
        };
      });
      res.setHeader('ETag', `"${out.campaign.version}"`);
      res.json(out);
    }),
  );

  app.post(
    '/campaigns/:id/dismiss',
    requireRole('lead'),
    h(async (req, res, user) => {
      const id = Uuid.parse(req.params.id);
      const { reason } = DismissBody.parse(req.body);
      const expected = ifMatch(req);
      const out = await tx(user, async (c) => {
        const r = await c.query<{
          version: number;
          status: string;
          member_count: number;
          family_key: string;
          last_ts: Date;
        }>(
          `UPDATE core.campaign SET status = 'DISMISSED', version = version + 1, updated_at = now(),
             dismissal = jsonb_build_object('atMembers', member_count, 'by', $3::text, 'reason', $4::text,
               'ts', (extract(epoch FROM last_ts) * 1000)::bigint, 'runawaySince', false)
           WHERE id = $1 AND version = $2 AND status IN ('OPEN', 'WATCHING')
           RETURNING version, status, member_count, family_key, last_ts`,
          [id, expected, user.sub, reason],
        );
        if (!r.rows[0]) {
          const cur = await c.query<{ version: number; status: string }>(
            'SELECT version, status FROM core.campaign WHERE id = $1',
            [id],
          );
          if (!cur.rows[0]) throw new HttpError(404, 'campaign not found');
          throw new HttpError(
            409,
            `campaign changed (version ${cur.rows[0].version}, ${cur.rows[0].status}); re-read and retry`,
          );
        }
        const g = r.rows[0];
        await c.query(
          'INSERT INTO core.campaign_override (campaign_id, action, by_user, reason, members_at) VALUES ($1, $2, $3, $4, $5)',
          [id, 'DISMISS', user.sub, reason, g.member_count],
        );
        const eventId = uuidV5(CAMPAIGN_EVENT_NAMESPACE, `${id}|DISMISSED|${g.version}`);
        await c.query('INSERT INTO core.outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [
          eventId,
          'campaign.events.v1',
          id,
          JSON.stringify({ type: 'DISMISSED', campaignId: id, version: g.version, familyKey: g.family_key, status: 'DISMISSED', members: g.member_count, ts: g.last_ts.toISOString(), eventId, detail: { by: user.sub, reason } }),
        ]); // prettier-ignore
        await audit(
          c,
          user,
          { action: 'DISMISS', resource: 'campaign', resourceId: id, details: { reason } },
          d.topics.audit,
        );
        return g;
      });
      res.setHeader('ETag', `"${out.version}"`);
      res.json({ id, status: out.status, version: out.version });
    }),
  );

  app.get(
    '/vehicles/:vin',
    h(async (req, res, user) => {
      const vin = Vin.parse(req.params.vin);
      const out = await tx(user, async (c) => {
        const v = await c.query(
          `SELECT v.vin::text AS vin, v.model_year, v.status, v.in_service, m.code AS model, m.powertrain, dt.code AS duty,
                  d.id AS depot_id, d.code AS depot_code, r.name AS region, d.lat, d.lon, d.geohash5
           FROM core.vehicle v JOIN core.vehicle_model m ON m.id = v.model_id JOIN core.duty_type dt ON dt.id = v.duty_type_id
           JOIN core.vehicle_depot_assignment a ON a.vin = v.vin AND upper_inf(a.valid) JOIN core.depot d ON d.id = a.depot_id
           JOIN core.region r ON r.id = d.region_id WHERE v.vin = $1`,
          [vin],
        ); // prettier-ignore
        const row = v.rows[0] as Record<string, unknown> | undefined;
        if (!row) throw new HttpError(404, 'vehicle not found');
        const [driver, incidents, repairs, queue, campaigns] = [
          await c.query<{ id: number; pseudonym: string }>(
            `SELECT dr.id, dr.pseudonym FROM core.driver_assignment da JOIN core.driver dr ON dr.id = da.driver_id
             WHERE da.vin = $1 AND upper_inf(da.valid) LIMIT 1`, [vin]),
          await c.query(`SELECT i.id, i.fault_family, i.metric, i.status, i.severity, i.runaway, i.opened_ts, i.closed_ts, i.hours_to_limit,
                           (SELECT json_agg(json_build_object('type', k.clue_type, 'text', k.text) ORDER BY k.ord) FROM core.incident_clue k WHERE k.incident_id = i.id) AS clues
                         FROM core.incident i WHERE i.vin = $1 ORDER BY i.opened_ts DESC LIMIT 20`, [vin]),
          await c.query(`SELECT id, repaired_ts, status, driven_hours, text FROM core.repair WHERE vin = $1 ORDER BY repaired_ts DESC`, [vin]),
          await c.query(`SELECT depot_id, rank, slot, reasons, cost_text FROM core.queue_item WHERE vin = $1`, [vin]),
          await c.query(`SELECT c.id, c.fault_family, c.status, m.fixed FROM core.campaign_member m JOIN core.campaign c ON c.id = m.campaign_id
                         WHERE m.vin = $1 AND m.active`, [vin]),
        ]; // prettier-ignore
        await view(c, user, 'vehicle', vin);
        const depot = maskDepot({ id: row.depot_id as number, code: row.depot_code as string, region: row.region as string, lat: row.lat as number, lon: row.lon as number, geohash5: row.geohash5 as string }, user.role); // prettier-ignore
        return {
          vin,
          model: row.model,
          powertrain: row.powertrain,
          duty: row.duty,
          model_year: row.model_year,
          status: row.status,
          depot,
          driver: maskDriver(driver.rows[0] ?? null, user.role),
          incidents: incidents.rows,
          repairs: repairs.rows,
          fix_status: (repairs.rows[0] as { status?: string } | undefined)?.status ?? null,
          queue: queue.rows[0] ?? null,
          campaigns: campaigns.rows,
        };
      });
      res.json(out);
    }),
  );

  app.get(
    '/vehicles/:vin/normal',
    h(async (req, res, user) => {
      const vin = Vin.parse(req.params.vin);
      const q = NormalQuery.parse(req.query);
      const out = await tx(user, async (c) => {
        const v = await c.query<{ powertrain: string; model_id: number; duty_type_id: number }>(
          'SELECT m.powertrain, v.model_id, v.duty_type_id FROM core.vehicle v JOIN core.vehicle_model m ON m.id = v.model_id WHERE v.vin = $1',
          [vin],
        );
        if (!v.rows[0]) throw new HttpError(404, 'vehicle not found');
        const metric = q.metric ?? (v.rows[0].powertrain === 'EV' ? 'batt_temp_c' : 'coolant_c');
        const col = metric === 'coolant_c' ? 'coolant_c' : metric === 'batt_temp_c' ? 'batt_temp_c' : 'lv_batt_min_v';
        const series = await c.query<{ hour: Date; value: number | null; readings: number }>(
          `SELECT hour, ${col} AS value, readings FROM core.telemetry_hourly WHERE vin = $1 AND ${col} IS NOT NULL ORDER BY hour`,
          [vin],
        );
        const b = await c.query<{ median: number; mad: number; source: string }>(
          `SELECT median, mad, 'VAN' AS source FROM core.vehicle_baseline WHERE vin = $1 AND metric = $2
           UNION ALL SELECT median, mad, 'COHORT' FROM core.cohort_baseline WHERE model_id = $3 AND duty_type_id = $4 AND metric = $2 AND region_id = 0
           LIMIT 1`,
          [vin, metric, v.rows[0].model_id, v.rows[0].duty_type_id],
        );
        const incidents = await c.query(
          `SELECT id, fault_family, severity, runaway, opened_ts, closed_ts, critical_ts FROM core.incident WHERE vin = $1 ORDER BY opened_ts`,
          [vin],
        );
        const repairs = await c.query(
          `SELECT repaired_ts, status, text FROM core.repair WHERE vin = $1 ORDER BY repaired_ts`,
          [vin],
        );
        await view(c, user, 'vehicle_normal', vin, { metric });
        const floor = metric === 'lv_batt_v' ? 0.05 : metric === 'batt_temp_c' ? 1 : 0.5;
        return {
          vin,
          metric,
          unit: metric === 'lv_batt_v' ? 'V' : '°C',
          band: b.rows[0] ? { ...band(b.rows[0].median, b.rows[0].mad, floor), source: b.rows[0].source } : null,
          series: series.rows.map((s) => ({ t: s.hour, value: s.value, readings: s.readings })),
          incidents: incidents.rows,
          repairs: repairs.rows,
        };
      });
      res.json(out);
    }),
  );

  app.post(
    '/vehicles/:vin/repair',
    requireRole('planner', 'lead'),
    h(async (req, res, user) => {
      const vin = Vin.parse(req.params.vin);
      const body = RepairBody.parse(req.body ?? {});
      const out = await tx(user, async (c) => {
        const v = await c.query('SELECT 1 FROM core.vehicle WHERE vin = $1', [vin]);
        if (!v.rowCount) throw new HttpError(404, 'vehicle not found');
        // default: "now" in event time = the end of the newest closed hourly bucket
        const now = await c.query<{ ts: Date | null }>(
          `SELECT max(ts) + interval '1 hour' AS ts FROM core.telemetry WHERE vin = $1`,
          [vin],
        );
        const repairedAt = body.repaired_at ?? (now.rows[0]?.ts ?? new Date()).toISOString();
        await audit(
          c,
          user,
          { action: 'REPAIR', resource: 'vehicle', resourceId: vin, details: { repaired_at: repairedAt } },
          d.topics.audit,
        );
        return { vin, repaired_at: repairedAt };
      });
      await d.publisher.publish(d.topics.repairs, vin, out); // the same message as `npm run sim:repair`
      res.status(202).json(out);
    }),
  );

  app.get(
    '/cards',
    h(async (req, res, user) => {
      const q = Page.parse(req.query);
      const after = cursor.decode<{ t: string; id: string }>(q.after);
      const out = await tx(user, async (c) => {
        const r = await c.query<{ id: string; created_at: Date }>(
          `SELECT c.id, c.card_type, c.depot_id, d.code AS depot, c.vin::text AS vin, c.campaign_id, c.title, c.event_ts, c.created_at, c.status, c.version
           FROM core.alert_card c LEFT JOIN core.depot d ON d.id = c.depot_id
           WHERE ($1::timestamptz IS NULL OR (c.created_at, c.id) < ($1::timestamptz, $2::uuid))
           ORDER BY c.created_at DESC, c.id DESC LIMIT $3`,
          [after?.t ?? null, after?.id ?? null, q.limit],
        ); // prettier-ignore
        await view(c, user, 'cards');
        return r.rows;
      });
      const last = out.length === q.limit ? out[out.length - 1]! : null;
      res.json({ items: out, next: last ? cursor.encode({ t: last.created_at.toISOString(), id: last.id }) : null });
    }),
  );

  app.get(
    '/proposals',
    h(async (req, res, user) => {
      const q = ProposalList.parse(req.query);
      const after = cursor.decode<{ t: string; id: string }>(q.after);
      const out = await tx(user, async (c) => {
        const r = await c.query<{ id: string; created_at: Date }>(
          `SELECT p.id, p.depot_id, d.code AS depot, p.campaign_id, p.trigger, p.action_type, p.title, p.body, p.evidence, p.diff, p.payload,
                  p.status, p.version, p.created_by, p.decided_by, p.decided_at, p.created_at
           FROM core.proposal p LEFT JOIN core.depot d ON d.id = p.depot_id
           WHERE p.status = coalesce($1, p.status) AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
           ORDER BY p.created_at DESC, p.id DESC LIMIT $4`,
          [q.status ?? null, after?.t ?? null, after?.id ?? null, q.limit],
        ); // prettier-ignore
        await view(c, user, 'proposals', null, { status: q.status ?? null });
        return r.rows;
      });
      const last = out.length === q.limit ? out[out.length - 1]! : null;
      res.json({ items: out, next: last ? cursor.encode({ t: last.created_at.toISOString(), id: last.id }) : null });
    }),
  );

  const decide = (decision: 'APPROVED' | 'REJECTED') =>
    h(async (req, res, user) => {
      const id = Uuid.parse(req.params.id);
      const expected = ifMatch(req);
      const out = await tx(user, async (c) => {
        const r = await c.query<{ version: number; depot_id: number | null; payload: { vin: string; slot: string }[]; action_type: string; created_by: string }>(
          `UPDATE core.proposal SET status = $3, decided_by = $4, decided_at = now(), version = version + 1
           WHERE id = $1 AND version = $2 AND status = 'PENDING' AND created_by <> $4
           RETURNING version, depot_id, payload, action_type, created_by`,
          [id, expected, decision, user.sub],
        ); // prettier-ignore
        if (!r.rows[0]) {
          const cur = await c.query<{ version: number; status: string }>(
            'SELECT version, status FROM core.proposal WHERE id = $1',
            [id],
          );
          if (!cur.rows[0]) throw new HttpError(404, 'proposal not found');
          throw new HttpError(
            409,
            `proposal changed (version ${cur.rows[0].version}, ${cur.rows[0].status}); re-read and retry`,
          );
        }
        const p = r.rows[0];
        if (decision === 'APPROVED' && p.depot_id !== null) {
          for (const b of p.payload) {
            await c.query(
              `INSERT INTO core.queue_booking (depot_id, vin, slot, proposal_id, booked_by) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (depot_id, vin) DO UPDATE SET slot = EXCLUDED.slot, proposal_id = EXCLUDED.proposal_id, booked_by = EXCLUDED.booked_by`,
              [p.depot_id, b.vin, b.slot, id, user.sub],
            );
          }
        }
        await c.query('INSERT INTO core.outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [
          uuidV5(CAMPAIGN_EVENT_NAMESPACE, `PROPOSAL|${id}|${decision}`),
          d.topics.proposals,
          String(p.depot_id ?? 0),
          JSON.stringify({ type: decision, proposal_id: id, depot_id: p.depot_id, action_type: p.action_type, bookings: decision === 'APPROVED' ? p.payload : [], by: user.sub, tenant_id: user.tenantId }),
        ]); // prettier-ignore
        await audit(
          c,
          user,
          { action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT', resource: 'proposal', resourceId: id },
          d.topics.audit,
        );
        return p;
      });
      res.setHeader('ETag', `"${out.version}"`);
      res.json({ id, status: decision, version: out.version });
    });
  app.post('/proposals/:id/approve', requireRole('lead'), decide('APPROVED'));
  app.post('/proposals/:id/reject', requireRole('lead'), decide('REJECTED'));

  app.get(
    '/audit',
    requireRole('lead'),
    h(async (req, res, user) => {
      const q = Page.parse(req.query);
      const after = cursor.decode<{ id: string }>(q.after);
      const out = await tx(user, async (c) => {
        const r = await c.query<{ id: string }>(
          `SELECT id, at, actor, role, action, resource, resource_id, details FROM core.audit
           WHERE ($1::bigint IS NULL OR id < $1::bigint) ORDER BY id DESC LIMIT $2`,
          [after?.id ?? null, q.limit],
        );
        await view(c, user, 'audit');
        return r.rows;
      });
      const last = out.length === q.limit ? out[out.length - 1]! : null;
      res.json({ items: out, next: last ? cursor.encode({ id: last.id }) : null });
    }),
  );

  app.delete(
    '/drivers/:id/personal-data',
    requireRole('lead'),
    h(async (req, res, user) => {
      const { id } = DepotId.parse(req.params);
      const out = await tx(user, async (c) => {
        const r = await c.query<{ pseudonym: string }>(
          `UPDATE core.driver SET pseudonym = 'erased-' || id, erased_at = now() WHERE id = $1 AND erased_at IS NULL RETURNING pseudonym`,
          [id],
        );
        if (!r.rows[0]) {
          const seen = await c.query('SELECT erased_at FROM core.driver WHERE id = $1', [id]);
          if (!seen.rowCount) throw new HttpError(404, 'driver not found');
          return { id, erased: false, assignments_removed: 0, note: 'already erased' };
        }
        // the person ↔ van-over-time link is personal data; per-van behaviour aggregates and safety data stay
        const del = await c.query('DELETE FROM core.driver_assignment WHERE driver_id = $1', [id]);
        await audit(
          c,
          user,
          {
            action: 'ERASE',
            resource: 'driver',
            resourceId: String(id),
            details: { assignments_removed: del.rowCount },
          },
          d.topics.audit,
        );
        return { id, erased: true, assignments_removed: del.rowCount ?? 0 };
      });
      res.json(out);
    }),
  );

  app.get('/events', (req, res) => {
    const user = req.user!;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    const onEvent = (e: LiveEvent) => {
      if (e.tenantId !== user.tenantId) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    d.bus.on('event', onEvent);
    const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
    void withTenant(d.pool, user, (c) => view(c, user, 'events')).catch(() => undefined);
    req.on('close', () => {
      clearInterval(ping);
      d.bus.off('event', onEvent);
    });
  });

  // errors: status + message only, never a stack trace
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof z.ZodError) {
      res.status(400).json({
        error: 'invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    } else if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid JSON' });
    } else {
      res.status(500).json({ error: 'internal error' });
    }
  });
  return app;
}

export { HOUR };
