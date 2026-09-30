import {
  applyIncident,
  applyOutcome,
  atRiskChanged,
  atRiskOf,
  campaignClues,
  costIfNotFixed,
  dismiss as dismissGroup,
  featureVector,
  firmwareClue,
  ratePer1000,
  type CampaignClue,
  type CampaignEvent,
  type CampaignParams,
  type Group,
  type HourlyScore,
  type IncidentMessage,
  type Install,
  type RepairOutcomeMessage,
} from '@cw/domain';
import type pg from 'pg';
import { metricOf, type EngineRegistry } from './registry.js';
import { enqueue, firstTime, loadBook, loadGroup, memberElsewhere, saveGroups } from './store.js';

/**
 * The campaign engine's use cases over Postgres. One transaction per incident action: idempotency row, the key's
 * book (join once, merge, open/grow/re-raise), members, clues, at-risk sisters, similar past campaigns and the
 * outbox rows commit together, so a crash leaves either all of it or none (the redelivery then re-applies it).
 */
type Q = Pick<pg.PoolClient, 'query'>;
const HOUR = 3_600_000;

export interface Applied {
  duplicate: boolean;
  events: CampaignEvent[];
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
};

export class CampaignEngine {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: EngineRegistry,
    private readonly params: CampaignParams,
    private readonly topic: string,
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

  /**
   * Current rate of the same family among the key's cohort type (same model × duty) in the same region, outside
   * this depot (per 1,000 van-days): "are the same vans elsewhere in the region doing this too?". A heatwave lifts
   * them all, so 5 at one depot is not surprising; an outbreak at one depot is.
   */
  private async regionalPer1000(
    c: Q,
    g: { family: string; modelId: number; dutyId: number; regionId: number; depotId: number },
    atTs: number,
  ): Promise<number> {
    const r = await c.query<{ n: number }>(
      `SELECT count(DISTINCT vin)::int AS n FROM core.incident
       WHERE fault_family = $1 AND model_id = $2 AND duty_type_id = $3 AND region_id = $4 AND depot_id <> $5
         AND opened_ts > $6 AND opened_ts <= $7`,
      [
        g.family,
        g.modelId,
        g.dutyId,
        g.regionId,
        g.depotId,
        new Date(atTs - this.params.regionalWindowH * HOUR),
        new Date(atTs),
      ],
    );
    const days = this.params.regionalWindowH / 24;
    return ratePer1000(
      r.rows[0]!.n,
      this.registry.cohortInRegionExcluding(g.modelId, g.dutyId, g.regionId, g.depotId),
      days,
    );
  }

  async onIncident(m: IncidentMessage): Promise<Applied> {
    return this.tx(async (c) => {
      if (!(await firstTime(c, m.incident_id, m.action, m.seq))) return { duplicate: true, events: [] };
      const book = await loadBook(c, m.family_key);
      const ts = Date.parse(m.event_ts);
      const regional = await this.regionalPer1000(
        c,
        {
          family: m.fault_family,
          modelId: m.model_id,
          dutyId: m.duty_type_id,
          regionId: m.region_id,
          depotId: m.depot_id,
        },
        ts,
      );
      const r = applyIncident(book, m, {
        params: this.params,
        rates: {
          vansInKey: Math.max(1, this.registry.cohortVins(m.model_id, m.duty_type_id, m.depot_id).length),
          baselinePer1000: this.registry.baselinePer1000(m.fault_family, m.model_id, m.duty_type_id),
          regionalPer1000: regional,
        },
        memberElsewhere: m.action === 'OPEN' ? await memberElsewhere(c, m.vin, m.fault_family, m.family_key) : false,
      });
      const changed = Object.values(r.book.groups).filter((g) => book.groups[g.id] !== g);
      if (changed.length === 0) return { duplicate: false, events: [] };
      await saveGroups(c, changed);
      const events = [...r.events];
      for (const g of changed) {
        if (g.status === 'OPEN') events.push(...(await this.enrich(c, g, ts, regional)));
      }
      await enqueue(c, this.topic, events, (e) => ({ id: e.campaignId, familyKey: e.familyKey }));
      return { duplicate: false, events };
    });
  }

  /**
   * Clues, firmware, at-risk sisters, money and similar past campaigns for an open campaign, as of event time
   * `simNow`. Returns an AT_RISK_CHANGED event when the at-risk list changed.
   */
  async enrich(c: Q, g0: Group, simNow: number, regional?: number): Promise<CampaignEvent[]> {
    let g = g0;
    const events: CampaignEvent[] = [];
    const names = this.registry.names(g.modelId, g.dutyId, g.depotId, g.regionId);
    const metric = metricOf(g.family);
    const members = Object.values(g.members);
    const cohort = this.registry.cohortVins(g.modelId, g.dutyId, g.depotId);
    const sisters = cohort.filter((v) => !g.members[v]);

    // at-risk sisters from the hourly scores (S3 telemetry rows)
    let atRisk: string[] = [];
    if (metric && sisters.length > 0) {
      const rows = await c.query<{ vin: string; ts: Date; dev: number | null; z: number | null; zs: number | null }>(
        `SELECT vin::text AS vin, ts, ${metric.col}_dev AS dev, ${metric.col}_z AS z, ${metric.col}_zs AS zs
         FROM core.telemetry WHERE vin = ANY($1) AND ts <= $2 AND ts > $3 AND ${metric.col}_z IS NOT NULL
         ORDER BY vin, ts DESC`,
        [sisters, new Date(simNow), new Date(simNow - 24 * HOUR)],
      );
      const byVin = new Map<string, HourlyScore[]>();
      for (const r of rows.rows) {
        const list = byVin.get(r.vin) ?? byVin.set(r.vin, []).get(r.vin)!;
        list.push({ ts: r.ts.getTime(), adjDev: r.dev, zLevel: r.z, zSlope: r.zs });
      }
      const verdicts = [...byVin].map(([vin, list]) => ({ vin, v: atRiskOf(list, this.params.atRisk) }));
      const flagged = verdicts.filter((x) => x.v.atRisk);
      atRisk = flagged.map((x) => x.vin).sort();
      const before = (
        await c.query<{ vin: string }>(
          'SELECT vin::text AS vin FROM core.campaign_at_risk WHERE campaign_id = $1 AND active ORDER BY vin',
          [g.id],
        )
      ).rows.map((r) => r.vin);
      for (const f of flagged) {
        await c.query(
          `INSERT INTO core.campaign_at_risk (campaign_id, vin, active, first_ts, last_ts, reason)
           VALUES ($1, $2, true, $3, $3, $4)
           ON CONFLICT (campaign_id, vin) DO UPDATE SET active = true, last_ts = EXCLUDED.last_ts, reason = EXCLUDED.reason`,
          [g.id, f.vin, new Date(f.v.ts!), f.v.reason],
        );
      }
      await c.query(
        'UPDATE core.campaign_at_risk SET active = false WHERE campaign_id = $1 AND active AND NOT (vin = ANY($2))',
        [g.id, atRisk],
      );
      if (before.join() !== atRisk.join()) {
        const ch = atRiskChanged(g, simNow, atRisk);
        g = ch.group;
        events.push(ch.event);
      }
    }

    // clues
    const n = members.length;
    const days = ((g.lastBucket - g.firstBucket + 1) * this.params.bucketH) / 24;
    const vansInKey = Math.max(1, cohort.length);
    const regionalRate = regional ?? (await this.regionalPer1000(c, g, simNow));
    const clues: CampaignClue[] = campaignClues(
      members,
      { family: g.family, model: names.model, duty: names.duty, depot: names.depot, unit: metric?.unit ?? '' },
      { n, lambda: g.lambda ?? 0, pValue: g.pValue ?? 1, days, keyPer1000: ratePer1000(n, vansInKey, days), regionalPer1000: regionalRate },
    ); // prettier-ignore
    const fwRows = await c.query<{ vin: string; version: string; installed_at: Date }>(
      `SELECT h.vin::text AS vin, r.version, h.installed_at FROM core.vehicle_firmware_history h
       JOIN core.firmware_release r ON r.id = h.firmware_id WHERE h.vin = ANY($1)`,
      [cohort],
    );
    const installs = new Map<string, Install[]>();
    for (const r of fwRows.rows)
      (installs.get(r.vin) ?? installs.set(r.vin, []).get(r.vin)!).push({
        version: r.version,
        ts: r.installed_at.getTime(),
      });
    const fw = firmwareClue(
      {
        members: members.map((m) => ({ vin: m.vin, firstIncidentTs: m.firstTs, installs: installs.get(m.vin) ?? [] })),
        sisters: sisters.map((v) => ({ vin: v, installs: installs.get(v) ?? [] })),
        campaignFirstTs: g.firstTs,
      },
      this.params.firmware,
    );
    if (fw?.shown) clues.push({ type: 'FIRMWARE', text: fw.text, value: fw.memberShare * 100, unit: '%' });
    const money = costIfNotFixed(n, atRisk.length, this.params.money);
    clues.push(money);

    await c.query('DELETE FROM core.campaign_clue WHERE campaign_id = $1', [g.id]);
    for (const [i, cl] of clues.entries()) {
      await c.query(
        'INSERT INTO core.campaign_clue (campaign_id, ord, clue_type, text, value, unit) VALUES ($1, $2, $3, $4, $5, $6)',
        [g.id, i, cl.type, cl.text, cl.value, cl.unit],
      );
    }

    // similar past campaigns (pgvector cosine)
    const vec = featureVector({
      family: g.family,
      powertrain: names.powertrain,
      duty: names.duty,
      climate: names.climate,
      members: n,
      deviation: median(members.map((m) => m.deviation).filter((x): x is number => x !== null)),
      slopePerH: median(members.map((m) => m.slopePerH).filter((x): x is number => x !== null)),
      codes: members.map((m) => m.lastCode).filter((x): x is string => x !== null),
    });
    await c.query('DELETE FROM core.campaign_similar WHERE campaign_id = $1', [g.id]);
    await c.query(
      `INSERT INTO core.campaign_similar (campaign_id, rank, past_campaign_id, similarity)
       SELECT $1, row_number() OVER (ORDER BY embedding <=> $2::vector), id, 1 - (embedding <=> $2::vector)
       FROM core.past_campaign ORDER BY embedding <=> $2::vector LIMIT 3`,
      [g.id, `[${vec.join(',')}]`],
    );
    await c.query('UPDATE core.campaign SET at_risk_count = $2, cost_inr = $3, version = $4 WHERE id = $1', [
      g.id,
      atRisk.length,
      Math.round(money.value),
      g.version,
    ]);
    return events;
  }

  /** At-risk refresh for every open campaign as of event time `simNow` (leader, once per sim-hour). */
  async refreshOpen(simNow: number): Promise<CampaignEvent[]> {
    const ids = (await this.pool.query<{ id: string }>(`SELECT id FROM core.campaign WHERE status = 'OPEN'`)).rows;
    const all: CampaignEvent[] = [];
    for (const { id } of ids) {
      const events = await this.tx(async (c) => {
        await c.query('SELECT 1 FROM core.campaign WHERE id = $1 FOR UPDATE', [id]);
        const g = await loadGroup(c, id);
        if (!g || g.status !== 'OPEN') return [];
        const ev = await this.enrich(c, g, simNow);
        await enqueue(c, this.topic, ev, (e) => ({ id: e.campaignId, familyKey: e.familyKey }));
        return ev;
      });
      all.push(...events);
    }
    return all;
  }

  /**
   * S6 outcome of a member's repair: FIXED marks it; a campaign closes (CLOSED event) only when every member is
   * FIXED; NOT_FIXED keeps it open. Idempotent via processed_incident_action (repair id, outcome).
   */
  async onOutcome(o: RepairOutcomeMessage): Promise<Applied> {
    return this.tx(async (c) => {
      if (!(await firstTime(c, o.repair_id, `OUTCOME_${o.outcome}`, 0))) return { duplicate: true, events: [] };
      const ids = (
        await c.query<{ id: string }>(
          `SELECT g.id FROM core.campaign g JOIN core.campaign_member m ON m.campaign_id = g.id AND m.active
           WHERE m.vin = $1 AND g.status IN ('WATCHING', 'OPEN', 'DISMISSED') FOR UPDATE OF g`,
          [o.vin],
        )
      ).rows;
      const events: CampaignEvent[] = [];
      for (const { id } of ids) {
        const g = await loadGroup(c, id);
        if (!g) continue;
        const r = applyOutcome(g, o.vin, o.outcome, Date.parse(o.decided_ts));
        if (r.group === g) continue;
        await saveGroups(c, [r.group]);
        events.push(...r.events);
      }
      await enqueue(c, this.topic, events, (e) => ({ id: e.campaignId, familyKey: e.familyKey }));
      return { duplicate: false, events };
    });
  }

  /** "Not an outbreak" (sticky): override row + campaign + outbox in one transaction. */
  async dismiss(id: string, by: string, reason: string): Promise<CampaignEvent[]> {
    return this.tx(async (c) => {
      await c.query('SELECT 1 FROM core.campaign WHERE id = $1 FOR UPDATE', [id]);
      const g = await loadGroup(c, id);
      if (!g) throw new Error(`campaign ${id} not found`);
      const r = dismissGroup(g, by, reason, g.lastTs);
      if (r.events.length === 0) return [];
      await saveGroups(c, [r.group]);
      await c.query(
        'INSERT INTO core.campaign_override (campaign_id, action, by_user, reason, members_at) VALUES ($1, $2, $3, $4, $5)',
        [id, 'DISMISS', by, reason, Object.keys(g.members).length],
      );
      await enqueue(c, this.topic, r.events, (e) => ({ id: e.campaignId, familyKey: e.familyKey }));
      return r.events;
    });
  }
}
