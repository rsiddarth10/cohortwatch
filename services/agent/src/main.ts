import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createLogger } from '@cw/common';
import { onCampaign, onRunaway, QueueParamsSchema, type QueueRow } from '@cw/domain';
import pg from 'pg';
import { Counter, Registry, collectDefaultMetrics } from 'prom-client';
import { z } from 'zod';

/**
 * S8 template agent (ADR 0020), no LLM. Triggers: campaign events (OPENED, GREW, AT_RISK_CHANGED, REOPENED) and queue
 * changes (a runaway not in today's bays). Per trigger, one transaction: evidence from existing rows (cited by id),
 * the dry run (S4 booking function), polite actions applied (notes, "inspect at next visit") and disruptive ones
 * written as PENDING proposals + an outbox row to agent.proposals.v1. Only a lead approves (API; DB check).
 * AGENT_ENABLED=false: the service stays up and does nothing; the board works without it.
 */
const Config = z.object({
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  DATABASE_URL: z.string().default('postgres://cw_app:cw_app_dev@localhost:15432/cohortwatch'),
  AGENT_ENABLED: z.enum(['true', 'false']).default('true'),
  GROUP_ID: z.string().default('cg.agent'),
  PROPOSALS_TOPIC: z.string().default('agent.proposals.v1'),
  METRICS_PORT: z.coerce.number().int().default(9479),
  LOG_LEVEL: z.string().default('info'),
});
type AgentConfig = z.infer<typeof Config>;
const QP = QueueParamsSchema.parse({
  minBayScore: process.env.QUEUE_MIN_BAY_SCORE ? Number(process.env.QUEUE_MIN_BAY_SCORE) : undefined,
  slotsPerBayPerDay: process.env.QUEUE_SLOTS_PER_BAY ? Number(process.env.QUEUE_SLOTS_PER_BAY) : undefined,
});
const log = createLogger('agent', process.env.LOG_LEVEL ?? 'info');

interface CampaignEvent {
  type: string;
  campaignId: string;
  eventId: string;
}

export class Agent {
  constructor(
    private readonly pool: pg.Pool,
    private readonly proposalsTopic: string,
  ) {}

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  private async queueOf(
    c: pg.PoolClient,
    depotId: number,
  ): Promise<{ rows: QueueRow[]; bays: number; booked: Set<string> }> {
    const q = await c.query<{ vin: string; rank: number; slot: QueueRow['slot']; pinned: boolean; score: number }>(
      'SELECT vin::text AS vin, rank, slot, pinned, score FROM core.queue_item WHERE depot_id = $1 ORDER BY rank',
      [depotId],
    );
    const bays = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.workshop_bay WHERE depot_id = $1', [
      depotId,
    ]);
    const booked = await c.query<{ vin: string }>(
      'SELECT vin::text AS vin FROM core.queue_booking WHERE depot_id = $1',
      [depotId],
    );
    return {
      rows: q.rows.map((r) => ({
        vin: r.vin,
        rank: r.rank,
        slot: r.slot,
        pinned: r.pinned,
        eligible: r.pinned || r.slot !== 'WAITING' || r.score >= QP.minBayScore,
      })),
      bays: bays.rows[0]!.n * QP.slotsPerBayPerDay,
      booked: new Set(booked.rows.map((b) => b.vin)),
    };
  }

  private async writeProposal(
    c: pg.PoolClient,
    tenant: number,
    depotId: number,
    campaignId: string | null,
    trigger: string,
    p: NonNullable<ReturnType<typeof onCampaign>['proposal']>,
  ): Promise<boolean> {
    const r = await c.query(
      `INSERT INTO core.proposal (id, tenant_id, depot_id, campaign_id, trigger, action_type, title, body, evidence, diff, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET status = 'PENDING', version = core.proposal.version + 1, trigger = EXCLUDED.trigger,
         title = EXCLUDED.title, body = EXCLUDED.body, evidence = EXCLUDED.evidence, diff = EXCLUDED.diff,
         payload = EXCLUDED.payload, decided_at = NULL WHERE core.proposal.status = 'WITHDRAWN'`,
      [p.id, tenant, depotId, campaignId, trigger, p.actionType, p.title, p.body, JSON.stringify(p.evidence), JSON.stringify(p.diff), JSON.stringify(p.payload)],
    ); // prettier-ignore
    if ((r.rowCount ?? 0) === 0) return false; // same set proposed before and decided (e.g. rejected): not again
    await this.emit(c, 'CREATED', tenant, depotId, p.id, p.actionType, p.title);
    return true;
  }

  private async emit(c: pg.PoolClient, type: string, tenant: number, depotId: number, id: string, actionType: string, title: string): Promise<void> {
    await c.query('INSERT INTO core.outbox (id, topic, key, payload) VALUES (gen_random_uuid(), $1, $2, $3)', [
      this.proposalsTopic,
      String(depotId),
      JSON.stringify({ type, proposal_id: id, depot_id: depotId, tenant_id: tenant, action_type: actionType, title }),
    ]);
  } // prettier-ignore

  /**
   * At most one live (PENDING) booking proposal per campaign: created, updated in place when the at-risk set changes
   * (its version bumps, so a lead approving an older view gets 409 and re-reads), or withdrawn when nothing is left
   * to book or the campaign is no longer open.
   */
  private async syncCampaignProposal(
    c: pg.PoolClient,
    camp: { tenant: number; depot_id: number },
    campaignId: string,
    trigger: string,
    p: ReturnType<typeof onCampaign>['proposal'],
  ): Promise<'CREATED' | 'UPDATED' | 'WITHDRAWN' | null> {
    const cur = await c.query<{ id: string; payload: { vin: string; slot: string }[]; title: string }>(
      `SELECT id, payload, title FROM core.proposal WHERE campaign_id = $1 AND action_type = 'BOOK_AT_RISK' AND status = 'PENDING' FOR UPDATE`,
      [campaignId],
    ); // prettier-ignore
    const live = cur.rows[0];
    if (!p) {
      if (!live) return null;
      await c.query(`UPDATE core.proposal SET status = 'WITHDRAWN', version = version + 1, decided_at = now() WHERE id = $1`, [live.id]); // prettier-ignore
      await this.emit(c, 'WITHDRAWN', camp.tenant, camp.depot_id, live.id, 'BOOK_AT_RISK', live.title);
      return 'WITHDRAWN';
    }
    if (!live)
      return (await this.writeProposal(c, camp.tenant, camp.depot_id, campaignId, trigger, p)) ? 'CREATED' : null;
    const key = (x: { vin: string; slot: string }[]) => x.map((b) => `${b.vin}:${b.slot}`).join(',');
    if (key(live.payload) === key(p.payload)) return null;
    await c.query(
      `UPDATE core.proposal SET title = $2, body = $3, evidence = $4, diff = $5, payload = $6, trigger = $7, version = version + 1 WHERE id = $1`,
      [live.id, p.title, p.body, JSON.stringify(p.evidence), JSON.stringify(p.diff), JSON.stringify(p.payload), trigger],
    ); // prettier-ignore
    await this.emit(c, 'UPDATED', camp.tenant, camp.depot_id, live.id, 'BOOK_AT_RISK', p.title);
    return 'UPDATED';
  }

  async onCampaignEvent(
    e: CampaignEvent,
  ): Promise<{ notes: number; proposal: 'CREATED' | 'UPDATED' | 'WITHDRAWN' | null } | null> {
    return this.tx(async (c) => {
      const first = await c.query(
        `INSERT INTO core.processed_event (source, id) VALUES ('agent-campaign', $1) ON CONFLICT DO NOTHING`,
        [e.eventId],
      );
      if ((first.rowCount ?? 0) === 0) return null;
      const g = await c.query<{
        fault_family: string;
        depot_id: number;
        member_count: number;
        status: string;
        code: string;
        tenant: number;
      }>(
        `SELECT c.fault_family, c.depot_id, c.member_count, c.status, d.code, core.depot_tenant(c.depot_id) AS tenant
         FROM core.campaign c JOIN core.depot d ON d.id = c.depot_id WHERE c.id = $1 FOR UPDATE OF c`,
        [e.campaignId],
      );
      const camp = g.rows[0];
      if (!camp) return null;
      if (camp.status !== 'OPEN') {
        // dismissed, merged or closed: nothing left to book
        const w = await this.syncCampaignProposal(c, camp, e.campaignId, e.eventId, null);
        return w ? { notes: 0, proposal: w } : null;
      }
      const clues = await c.query<{ ord: number; clue_type: string; text: string }>('SELECT ord, clue_type, text FROM core.campaign_clue WHERE campaign_id = $1 ORDER BY ord', [e.campaignId]); // prettier-ignore
      const atRisk = await c.query<{ vin: string; reason: string }>(
        'SELECT vin::text AS vin, reason FROM core.campaign_at_risk WHERE campaign_id = $1 AND active ORDER BY first_ts',
        [e.campaignId],
      );
      const q = await this.queueOf(c, camp.depot_id);
      const out = onCampaign({
        campaignId: e.campaignId,
        family: camp.fault_family,
        depotId: camp.depot_id,
        depotCode: camp.code,
        members: camp.member_count,
        clues: clues.rows.map((x) => ({ ord: x.ord, type: x.clue_type, text: x.text })),
        atRisk: atRisk.rows,
        queue: q.rows,
        bays: q.bays,
        alreadyBooked: q.booked,
      });
      // polite actions, applied directly
      await c.query(`DELETE FROM core.agent_note WHERE campaign_id = $1 AND kind = 'NOTE' AND vin IS NULL`, [
        e.campaignId,
      ]);
      for (const n of out.notes) {
        await c.query(
          `INSERT INTO core.agent_note (tenant_id, campaign_id, vin, kind, text, evidence) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (kind, campaign_id, vin) DO UPDATE SET text = EXCLUDED.text, evidence = EXCLUDED.evidence`,
          [camp.tenant, e.campaignId, n.vin, n.kind, n.text, JSON.stringify(n.evidence)],
        );
      }
      // disruptive action → a proposal for a lead
      const proposal = await this.syncCampaignProposal(c, camp, e.campaignId, e.eventId, out.proposal);
      return { notes: out.notes.length, proposal };
    });
  }

  async onQueueEvent(e: {
    depot_id: number;
    version: number;
    items: { vin: string; slot: string; pinned: boolean }[];
  }): Promise<boolean> {
    const stuck = e.items.filter((i) => i.pinned && i.slot !== 'TODAY');
    if (stuck.length === 0) return false;
    return this.tx(async (c) => {
      const first = await c.query(
        `INSERT INTO core.processed_event (source, id) VALUES ('agent-queue', $1) ON CONFLICT DO NOTHING`,
        [`${e.depot_id}|${e.version}`],
      );
      if ((first.rowCount ?? 0) === 0) return false;
      const d = await c.query<{ code: string; tenant: number }>(
        'SELECT code, core.depot_tenant(id) AS tenant FROM core.depot WHERE id = $1',
        [e.depot_id],
      );
      const q = await this.queueOf(c, e.depot_id);
      let any = false;
      for (const s of stuck) {
        const why = await c.query<{ text: string }>(
          `SELECT r->>'text' AS text FROM core.queue_item qi, jsonb_array_elements(qi.reasons) r WHERE qi.depot_id = $1 AND qi.vin = $2 AND r->>'type' = 'RUNAWAY' LIMIT 1`,
          [e.depot_id, s.vin],
        );
        const p = onRunaway({ depotId: e.depot_id, depotCode: d.rows[0]!.code, vin: s.vin, reason: { id: `${e.depot_id}#${s.vin}`, text: why.rows[0]?.text ?? 'runaway' }, queue: q.rows, bays: q.bays }); // prettier-ignore
        if (p)
          any =
            (await this.writeProposal(
              c,
              d.rows[0]!.tenant,
              e.depot_id,
              null,
              `queue ${e.depot_id} v${e.version}`,
              p,
            )) || any;
      }
      return any;
    });
  }
}

export async function startAgent(c: AgentConfig): Promise<{ stop(): Promise<void> }> {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'cw_agent_' });
  const actions = new Counter({
    name: 'cw_agent_actions_total',
    help: 'Agent actions',
    labelNames: ['kind'],
    registers: [registry],
  });
  const server = createServer((req, res) => {
    if (req.url === '/metrics')
      void registry.metrics().then((b) => res.writeHead(200, { 'content-type': registry.contentType }).end(b));
    else if (req.url === '/healthz')
      res.writeHead(200).end(JSON.stringify({ ok: true, enabled: c.AGENT_ENABLED === 'true' }));
    else res.writeHead(404).end();
  }).listen(c.METRICS_PORT);
  if (c.AGENT_ENABLED !== 'true') {
    log.info('AGENT_ENABLED=false: idle (the board works without the agent)');
    return { stop: async () => void server.close() };
  }
  const pool = new pg.Pool({
    connectionString: c.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  });
  const agent = new Agent(pool, c.PROPOSALS_TOPIC);
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: c.KAFKA_BROKERS.split(','), clientId: 'cw-agent', logLevel: KafkaJS.logLevel.WARN },
  });
  const consumer = kafka.consumer({ kafkaJS: { groupId: c.GROUP_ID, fromBeginning: true, autoCommit: true } });
  await consumer.connect();
  await consumer.subscribe({ topics: ['campaign.events.v1', 'queue.events.v1'] });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const v = JSON.parse(message.value?.toString() ?? '{}');
        if (topic === 'campaign.events.v1') {
          const r = await agent.onCampaignEvent(v as CampaignEvent);
          if (r) {
            actions.inc({ kind: 'note' }, r.notes);
            if (r.proposal) {
              actions.inc({ kind: `proposal_${r.proposal.toLowerCase()}` });
              log.info({ campaign: (v as CampaignEvent).campaignId, proposal: r.proposal }, 'booking proposal');
            }
          }
        } else if (await agent.onQueueEvent(v)) {
          actions.inc({ kind: 'proposal' });
        }
      } catch (err) {
        log.warn({ topic, err: String(err) }, 'agent: trigger failed (skipped; the board works without the agent)');
      }
    },
  });
  log.info('agent running');
  return {
    stop: async () => {
      await consumer.disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
      server.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgent(Config.parse(process.env))
    .then((s) => {
      const exit = () => void s.stop().then(() => process.exit(0));
      process.on('SIGTERM', exit);
      process.on('SIGINT', exit);
    })
    .catch((err: unknown) => {
      log.fatal({ err }, 'agent failed');
      process.exit(1);
    });
}
