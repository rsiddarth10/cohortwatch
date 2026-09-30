import {
  atRiskOf,
  costText,
  DEFAULT_CAMPAIGN,
  DEFAULT_DETECT,
  familyMetric,
  fillBays,
  judgeRepair,
  mergeSignals,
  rank,
  reasonsOf,
  uuidV5,
  withBookings,
  type CampaignParams,
  type FixParams,
  type HourlyScore,
  type IncidentMessage,
  type Metric,
  type QueueParams,
  type QueueSignal,
  type RepairOutcomeMessage,
  type Severity,
  type VanContext,
} from '@cw/domain';
import type pg from 'pg';
import type { WorkshopRegistry } from './registry.js';

/**
 * S4 + S6 use cases over Postgres. Every consumed event is one transaction: idempotency row (processed_event), cards,
 * repairs, the affected depot's queue rebuild and the outbox rows commit together. The hourly tick (leader only,
 * event time) judges open repairs and refreshes every depot's queue.
 */
type Q = Pick<pg.PoolClient, 'query'>;
const HOUR = 3_600_000;
const NS = '9d1f4b62-7a3c-4e85-b0d9-6c2e8f1a5b37'; // workshop ids (random v4, generated once)

const COL: Record<Metric, string> = { coolant_c: 'coolant', batt_temp_c: 'batt', lv_batt_v: 'lv' };
const METRICS: Metric[] = ['coolant_c', 'batt_temp_c', 'lv_batt_v'];

export interface Rebuilt {
  depotId: number;
  changed: boolean;
  version: number;
  /** VIN at rank 1 (after the rebuild). */
  top: string | null;
}

export interface CampaignEventMsg {
  type: string;
  campaignId: string;
  eventId: string;
  familyKey: string;
  members: number;
  ts: string;
  status: string;
}

export interface RepairMsg {
  vin: string;
  repaired_at: string;
}

interface TelemetryRow {
  vin: string;
  ts: Date;
  [k: string]: unknown;
}

export class Workshop {
  readonly money: CampaignParams['money'] = DEFAULT_CAMPAIGN.money;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: WorkshopRegistry,
    private readonly qp: QueueParams,
    private readonly fp: FixParams,
    private readonly topics: { queue: string; outcomes: string },
  ) {}

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

  private async firstTime(c: Q, source: string, id: string): Promise<boolean> {
    const r = await c.query('INSERT INTO core.processed_event (source, id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      source,
      id,
    ]);
    return (r.rowCount ?? 0) === 1;
  }

  // ---- events ------------------------------------------------------------------------------------

  async onIncident(m: IncidentMessage, incidentWrittenAt: number | null): Promise<Rebuilt | null> {
    return this.tx(async (c) => {
      if (!(await this.firstTime(c, 'incident', `${m.incident_id}|${m.action}|${m.seq}`))) return null;
      const van = this.registry.van(m.vin);
      if (!van) return null;
      if (m.runaway && m.action !== 'CLOSE') {
        const mi = m.metric ? DEFAULT_DETECT.metrics[m.metric] : null;
        const eta =
          m.hours_to_limit !== null && mi?.hardLimit != null
            ? `, ≈ ${Math.round(m.hours_to_limit)} h to ${mi.hardLimit} ${mi.unit}`
            : '';
        await c.query(
          `INSERT INTO core.alert_card (id, card_type, depot_id, vin, incident_id, title, body, event_ts, source_written_at)
           VALUES ($1, 'RUNAWAY', $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [
            uuidV5(NS, `RUNAWAY|${m.incident_id}`), van.depotId, m.vin, m.incident_id,
            `Runaway ${m.fault_family}: ${m.vin} at ${this.registry.depotCode(van.depotId)}${eta}`,
            m.clues.map((x) => x.text).join('; '), m.event_ts, incidentWrittenAt ? new Date(incidentWrittenAt) : null,
          ],
        ); // prettier-ignore
      }
      return this.rebuildDepot(c, van.depotId, Date.parse(m.event_ts));
    });
  }

  async onCampaignEvent(e: CampaignEventMsg): Promise<Rebuilt | null> {
    return this.tx(async (c) => {
      if (!(await this.firstTime(c, 'campaign', e.eventId))) return null;
      const r = await c.query<{ depot_id: number }>('SELECT depot_id FROM core.campaign WHERE id = $1', [e.campaignId]);
      const depotId = r.rows[0]?.depot_id;
      if (depotId === undefined) return null;
      if (e.type === 'OPENED' || e.type === 'GREW' || e.type === 'REOPENED') {
        const family = e.familyKey.split('|')[0];
        await c.query(
          `INSERT INTO core.alert_card (id, card_type, depot_id, campaign_id, title, body, event_ts)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
          [
            uuidV5(NS, `CAMPAIGN|${e.eventId}`), `CAMPAIGN_${e.type}`, depotId, e.campaignId,
            `${family} campaign ${e.type === 'OPENED' ? 'opened' : e.type === 'GREW' ? 'grew' : 're-raised'} at ${this.registry.depotCode(depotId)}: ${e.members} vans`,
            e.familyKey, e.ts,
          ],
        ); // prettier-ignore
      }
      return this.rebuildDepot(c, depotId, Date.parse(e.ts));
    });
  }

  /** A lead approved or rejected an agent proposal: rebuild that depot (approved bookings take their slot). */
  async onProposalDecision(e: { type: string; proposal_id: string; depot_id: number | null }): Promise<Rebuilt | null> {
    if ((e.type !== 'APPROVED' && e.type !== 'REJECTED') || e.depot_id === null) return null;
    return this.tx(async (c) => {
      if (!(await this.firstTime(c, 'proposal', `${e.proposal_id}|${e.type}`))) return null;
      const r = await c.query<{ ts: Date | null }>(
        'SELECT as_of_ts AS ts FROM core.queue_version WHERE depot_id = $1',
        [e.depot_id],
      );
      return this.rebuildDepot(c, e.depot_id!, r.rows[0]?.ts?.getTime() ?? Date.now());
    });
  }

  async onRepair(r: RepairMsg): Promise<Rebuilt | null> {
    const ts = Date.parse(r.repaired_at);
    const van = this.registry.van(r.vin);
    if (!van || !Number.isFinite(ts)) return null;
    return this.tx(async (c) => {
      if (!(await this.firstTime(c, 'repair', `${r.vin}|${r.repaired_at}`))) return null;
      // the fault being fixed: its newest open incident, else its live campaign, else its powertrain's main signal
      const f = await c.query<{ family: string }>(
        `SELECT fault_family AS family FROM core.incident WHERE vin = $1 AND status = 'OPEN' AND metric IS NOT NULL
         UNION ALL SELECT m.fault_family FROM core.campaign_member m WHERE m.vin = $1 AND m.active LIMIT 1`,
        [r.vin],
      );
      const family = f.rows[0]?.family ?? null;
      const metric = (family && familyMetric(family)) || (van.powertrain === 'EV' ? 'batt_temp_c' : 'coolant_c');
      await c.query(
        `INSERT INTO core.repair (id, vin, repaired_ts, fault_family, metric, status, text)
         VALUES ($1, $2, $3, $4, $5, 'REPAIRED', 'repaired; watching the next driven hours') ON CONFLICT (id) DO NOTHING`,
        [uuidV5(NS, `REPAIR|${r.vin}|${r.repaired_at}`), r.vin, new Date(ts), family, metric],
      );
      return this.rebuildDepot(c, van.depotId, ts);
    });
  }

  // ---- hourly tick: fix confirmation, then every depot's queue -----------------------------------

  async judgeRepairs(simNow: number): Promise<RepairOutcomeMessage[]> {
    const open = (
      await this.pool.query<{ id: string; vin: string; repaired_ts: Date; metric: Metric }>(
        `SELECT id, vin::text AS vin, repaired_ts, metric FROM core.repair WHERE status IN ('REPAIRED', 'PENDING')`,
      )
    ).rows;
    const decided: RepairOutcomeMessage[] = [];
    for (const rp of open) {
      const out = await this.tx(async (c) => {
        const col = COL[rp.metric] ?? 'coolant';
        const rows = (
          await c.query<{ ts: Date; z: number | null }>(
            `SELECT ts, ${col}_z AS z FROM core.telemetry WHERE vin = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts`,
            [rp.vin, new Date(rp.repaired_ts.getTime() - HOUR), new Date(simNow)],
          )
        ).rows;
        const v = judgeRepair(
          rp.repaired_ts.getTime(),
          rows.map((r) => ({ ts: r.ts.getTime(), z: r.z })),
          simNow,
          this.fp,
        );
        await c.query(
          'UPDATE core.repair SET status = $2, driven_hours = $3, text = $4, updated_at = now() WHERE id = $1',
          [rp.id, v.status, v.drivenHours, v.text],
        );
        if (v.status !== 'FIXED' && v.status !== 'NOT_FIXED') return null;
        const decidedTs = new Date(v.ts ?? simNow);
        await c.query(
          `INSERT INTO core.repair_outcome (repair_id, vin, outcome, decided_ts, driven_hours, text)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (repair_id) DO NOTHING`,
          [rp.id, rp.vin, v.status, decidedTs, v.drivenHours, v.text],
        );
        const msg: RepairOutcomeMessage = {
          repair_id: rp.id,
          vin: rp.vin,
          outcome: v.status,
          repaired_ts: rp.repaired_ts.toISOString(),
          decided_ts: decidedTs.toISOString(),
          driven_hours: v.drivenHours,
          text: v.text,
        };
        await c.query(
          `INSERT INTO core.outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [uuidV5(NS, `OUTCOME|${rp.id}|${v.status}`), this.topics.outcomes, rp.vin, JSON.stringify(msg)],
        );
        const van = this.registry.van(rp.vin);
        if (van) await this.rebuildDepot(c, van.depotId, simNow);
        return msg;
      });
      if (out) decided.push(out);
    }
    return decided;
  }

  async refreshAll(simNow: number): Promise<Rebuilt[]> {
    const out: Rebuilt[] = [];
    for (const depotId of this.registry.depots()) out.push(await this.tx((c) => this.rebuildDepot(c, depotId, simNow)));
    return out;
  }

  // ---- the queue of one depot --------------------------------------------------------------------

  async rebuildDepot(c: Q, depotId: number, asOf: number): Promise<Rebuilt> {
    await c.query(
      'INSERT INTO core.queue_version (depot_id, version, as_of_ts) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING',
      [depotId, new Date(asOf)],
    );
    const cur = await c.query<{ version: number }>(
      'SELECT version FROM core.queue_version WHERE depot_id = $1 FOR UPDATE',
      [depotId],
    );
    const version = cur.rows[0]!.version;
    const vins = this.registry.depotVins(depotId);
    const since = new Date(asOf - 24 * HOUR);
    const at = new Date(asOf);

    const [repairs, incidents, members, atRisk, rows, agg] = [
      await c.query<{ vin: string; repaired_ts: Date; status: string }>(
        `SELECT DISTINCT ON (vin) vin::text AS vin, repaired_ts, status FROM core.repair
         WHERE vin = ANY($1) AND repaired_ts <= $2 ORDER BY vin, repaired_ts DESC`,
        [vins, at],
      ),
      await c.query<{ id: string; vin: string; fault_family: string; metric: string | null; severity: Severity; runaway: boolean; hours_to_limit: number | null; deviation: number | null; slope_per_h: number | null; z_slope: number | null; trigger: 'SIGNAL' | 'DTC_RATE'; opened_ts: Date }>(
        `SELECT id, vin::text AS vin, fault_family, metric, severity, runaway, hours_to_limit, deviation, slope_per_h, z_slope,
                trigger, opened_ts FROM core.incident WHERE status = 'OPEN' AND vin = ANY($1) AND opened_ts <= $2`,
        [vins, at],
      ),
      await c.query<{ vin: string; id: string; fault_family: string; member_count: number; depot_id: number; fixed: boolean }>(
        `SELECT m.vin::text AS vin, g.id, g.fault_family, g.member_count, g.depot_id, m.fixed FROM core.campaign_member m
         JOIN core.campaign g ON g.id = m.campaign_id WHERE m.active AND g.status = 'OPEN' AND m.vin = ANY($1)`,
        [vins],
      ),
      await c.query<{ vin: string; id: string; fault_family: string; member_count: number; depot_id: number }>(
        `SELECT a.vin::text AS vin, g.id, g.fault_family, g.member_count, g.depot_id FROM core.campaign_at_risk a
         JOIN core.campaign g ON g.id = a.campaign_id WHERE a.active AND g.status = 'OPEN' AND a.vin = ANY($1)`,
        [vins],
      ),
      await c.query<TelemetryRow>(
        `SELECT vin::text AS vin, ts, coolant_dev, coolant_z, coolant_zs, batt_dev, batt_z, batt_zs, lv_dev, lv_z, lv_zs
         FROM core.telemetry WHERE vin = ANY($1) AND ts > $2 AND ts <= $3 ORDER BY vin, ts DESC`,
        [vins, new Date(asOf - 6 * HOUR), at],
      ),
      await c.query<{ vin: string; codes: number; harsh: number | null; driven: number }>(
        `SELECT vin::text AS vin, sum(dtc_count)::int AS codes,
                sum(harsh_count) FILTER (WHERE speed_kmh > 0)::float8 AS harsh,
                count(*) FILTER (WHERE speed_kmh > 0 AND harsh_count IS NOT NULL)::int AS driven
         FROM core.telemetry WHERE vin = ANY($1) AND ts > $2 AND ts <= $3 GROUP BY vin`,
        [vins, since, at],
      ),
    ]; // prettier-ignore

    const repairOf = new Map(repairs.rows.map((r) => [r.vin, r]));
    const repaired = (vin: string) => {
      const r = repairOf.get(vin);
      return r && r.status !== 'NOT_FIXED' ? r.repaired_ts.getTime() : null; // in the workshop's hands or fixed
    };
    const rowsOf = new Map<string, TelemetryRow[]>();
    for (const r of rows.rows) (rowsOf.get(r.vin) ?? rowsOf.set(r.vin, []).get(r.vin)!).push(r);
    const depotCode = (id: number) => this.registry.depotCode(id);

    const signals: QueueSignal[] = [];
    for (const i of incidents.rows) {
      const rt = repaired(i.vin);
      if (rt !== null && i.opened_ts.getTime() <= rt) continue; // repaired since: judged by fix confirmation
      signals.push({
        kind: 'INCIDENT', vin: i.vin, depotId, incidentId: i.id, family: i.fault_family, metric: i.metric,
        severity: i.severity, runaway: i.runaway, hoursToLimit: i.hours_to_limit, deviation: i.deviation,
        slopePerH: i.slope_per_h, zSlope: i.z_slope, trigger: i.trigger,
      }); // prettier-ignore
    }
    for (const m of members.rows) {
      if (m.fixed || repaired(m.vin) !== null) continue;
      signals.push({ kind: 'CAMPAIGN', vin: m.vin, depotId, campaignId: m.id, family: m.fault_family, members: m.member_count, role: 'MEMBER', depotCode: depotCode(m.depot_id), adjDev: null }); // prettier-ignore
    }
    const hasSignal = new Set(signals.map((s) => s.vin));
    for (const a of atRisk.rows) {
      if (repaired(a.vin) !== null) continue;
      const metric = familyMetric(a.fault_family);
      const latest = metric ? rowsOf.get(a.vin)?.find((r) => r[`${COL[metric]}_dev`] !== null) : undefined;
      const adjDev = latest && metric ? (latest[`${COL[metric]}_dev`] as number) : null;
      signals.push({ kind: 'CAMPAIGN', vin: a.vin, depotId, campaignId: a.id, family: a.fault_family, members: a.member_count, role: 'AT_RISK', depotCode: depotCode(a.depot_id), adjDev }); // prettier-ignore
      hasSignal.add(a.vin);
    }
    // solo at-risk: vans with no incident and no campaign whose own trend is heading for their line
    for (const vin of vins) {
      if (hasSignal.has(vin)) continue;
      const rt = repaired(vin);
      const list = (rowsOf.get(vin) ?? []).filter((r) => rt === null || r.ts.getTime() > rt);
      for (const metric of METRICS) {
        const col = COL[metric];
        const scores: HourlyScore[] = list.map((r) => ({
          ts: r.ts.getTime(),
          adjDev: r[`${col}_dev`] as number | null,
          zLevel: r[`${col}_z`] as number | null,
          zSlope: r[`${col}_zs`] as number | null,
        }));
        const v = atRiskOf(scores, DEFAULT_CAMPAIGN.atRisk);
        if (!v.atRisk) continue;
        const mi = DEFAULT_DETECT.metrics[metric];
        const dev = scores.find((s) => s.adjDev !== null)?.adjDev ?? null;
        const devText = dev === null ? '' : ` ${dev >= 0 ? '+' : ''}${dev.toFixed(1)} ${mi.unit}`;
        signals.push({ kind: 'AT_RISK', vin, depotId, family: metric, metric, adjDev: dev, zSlope: scores[0]?.zSlope ?? null, reason: `${mi.label}${devText} vs its own normal, ${v.reason}` }); // prettier-ignore
        break;
      }
    }
    for (const [vin, r] of repairOf) {
      if (r.status === 'NOT_FIXED')
        signals.push({ kind: 'NOT_FIXED', vin, depotId, repairedTs: r.repaired_ts.getTime() });
    }

    // context: codes (a reason only, never a score term), capped behaviour vs the depot's duty median, in service
    const aggOf = new Map(agg.rows.map((a) => [a.vin, a]));
    const rateOf = (vin: string) => {
      const a = aggOf.get(vin);
      return a && a.driven > 0 && a.harsh !== null ? a.harsh / a.driven : null;
    };
    const dutyMedian = new Map<number, number>();
    const byDuty = new Map<number, number[]>();
    for (const vin of vins) {
      const r = rateOf(vin);
      const d = this.registry.van(vin)?.dutyId;
      if (r !== null && d !== undefined) (byDuty.get(d) ?? byDuty.set(d, []).get(d)!).push(r);
    }
    for (const [d, xs] of byDuty) dutyMedian.set(d, [...xs].sort((a, b) => a - b)[xs.length >> 1]!);
    const ctx = (vin: string): VanContext => {
      const van = this.registry.van(vin);
      const r = rateOf(vin);
      const med = van ? dutyMedian.get(van.dutyId) : undefined;
      return {
        codes24h: aggOf.get(vin)?.codes ?? 0,
        behaviourRatio: r !== null && med !== undefined && med > 0 ? r / med : null,
        inServiceTomorrow: van?.inServiceTomorrow ?? true,
      };
    };

    const bays = this.registry.baysAt(depotId);
    // lead-approved bookings (S8 proposals) go into their slot first, after runaways
    const bk = await c.query<{ vin: string; slot: 'TODAY' | 'TOMORROW'; booked_by: string }>(
      'SELECT vin::text AS vin, slot, booked_by FROM core.queue_booking WHERE depot_id = $1',
      [depotId],
    );
    const cands = mergeSignals(signals, ctx);
    // a booked van stays booked even when its signal fades (an at-risk sister is booked *before* it fails)
    const have = new Set(cands.map((x) => x.vin));
    for (const b of bk.rows)
      if (!have.has(b.vin))
        cands.push({ vin: b.vin, depotId, incidents: [], campaigns: [], atRisk: [], notFixed: null, ctx: ctx(b.vin) });
    let placed = fillBays(rank(cands, this.qp), bays, this.qp);
    const bookedBy = new Map(bk.rows.map((b) => [b.vin, b.booked_by]));
    if (bk.rows.length > 0) {
      const perDay = bays * this.qp.slotsPerBayPerDay;
      const rows = placed.map((p) => ({
        vin: p.vin,
        rank: p.rank,
        slot: p.slot,
        pinned: p.pinned,
        eligible: p.pinned || p.score >= this.qp.minBayScore,
      }));
      const byVin = new Map(placed.map((p) => [p.vin, p]));
      let waiting = 0;
      placed = withBookings(rows, new Map(bk.rows.map((b) => [b.vin, b.slot])), perDay).map((b) => ({
        ...byVin.get(b.vin)!,
        rank: b.rank,
        slot: b.slot,
        waitDays: b.slot === 'TODAY' ? 0 : b.slot === 'TOMORROW' ? 1 : 2 + Math.floor(waiting++ / Math.max(1, perDay)),
      }));
    }
    const signature = placed.map((p) => `${p.vin}:${p.rank}:${p.slot}`).join(',');
    const before = await c.query<{ s: string | null }>(
      `SELECT string_agg(vin || ':' || rank || ':' || slot, ',' ORDER BY rank) AS s FROM core.queue_item WHERE depot_id = $1`,
      [depotId],
    );
    const top = placed[0]?.vin ?? null;
    if (placed[0]?.pinned) {
      await c.query(
        `UPDATE core.alert_card SET queue_top_at = now() WHERE card_type = 'RUNAWAY' AND vin = $1 AND queue_top_at IS NULL`,
        [placed[0].vin],
      );
    }
    if ((before.rows[0]?.s ?? '') === signature) return { depotId, changed: false, version, top };

    const next = version + 1;
    await c.query('DELETE FROM core.queue_item WHERE depot_id = $1', [depotId]);
    const snapshot: unknown[] = [];
    for (const p of placed) {
      const reasons = reasonsOf(p);
      const by = bookedBy.get(p.vin);
      if (by) reasons.unshift({ type: 'BOOKED', text: `booked by ${by} (approved agent proposal)` });
      const cost = costText(p, this.qp, this.money);
      await c.query(
        `INSERT INTO core.queue_item (depot_id, vin, rank, slot, score, pinned, parts, reasons, cost_inr, cost_text, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          depotId,
          p.vin,
          p.rank,
          p.slot,
          p.score,
          p.pinned,
          JSON.stringify(p.parts),
          JSON.stringify(reasons),
          cost.inr,
          cost.text,
          next,
        ],
      );
      snapshot.push({
        vin: p.vin,
        rank: p.rank,
        slot: p.slot,
        score: Math.round(p.score * 1000) / 1000,
        pinned: p.pinned,
        reasons: reasons.map((r) => r.type),
      });
    }
    await c.query('UPDATE core.queue_version SET version = $2, as_of_ts = $3, updated_at = now() WHERE depot_id = $1', [
      depotId,
      next,
      at,
    ]);
    await c.query('INSERT INTO core.queue_snapshot (depot_id, version, as_of_ts, items) VALUES ($1, $2, $3, $4)', [
      depotId,
      next,
      at,
      JSON.stringify(snapshot),
    ]);
    await c.query(
      `INSERT INTO core.outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [
        uuidV5(NS, `QUEUE|${depotId}|${next}`),
        this.topics.queue,
        String(depotId),
        JSON.stringify({
          type: 'QUEUE_CHANGED',
          depot_id: depotId,
          version: next,
          as_of_ts: at.toISOString(),
          items: snapshot.slice(0, 20),
        }),
      ],
    );
    return { depotId, changed: true, version: next, top };
  }
}
