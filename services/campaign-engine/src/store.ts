import type { CampaignEvent, CampaignStatus, Dismissal, Group, KeyBook, Member } from '@cw/domain';
import type pg from 'pg';

/**
 * Postgres persistence of a family key's campaign book (core.campaign + core.campaign_member) and the outbox.
 * Every call takes the transaction's client: a change, its members and its outbox rows commit together.
 */
type Q = Pick<pg.PoolClient, 'query'>;

interface CampaignRow {
  id: string;
  family_key: string;
  fault_family: string;
  model_id: number;
  duty_type_id: number;
  depot_id: number;
  region_id: number;
  status: CampaignStatus;
  first_bucket: number;
  last_bucket: number;
  first_ts: Date;
  last_ts: Date;
  opened_ts: Date | null;
  merged_into: string | null;
  lambda: number | null;
  p_value: number | null;
  rate_source: Group['rateSource'];
  dismissal: Dismissal | null;
  version: number;
}

interface MemberRow {
  campaign_id: string;
  vin: string;
  first_incident_id: string;
  joined_ts: Date;
  runaway: boolean;
  deviation: number | null;
  slope_per_h: number | null;
  last_code: string | null;
  firmware: string | null;
  fixed: boolean;
}

const toGroup = (r: CampaignRow, members: Record<string, Member>): Group => ({
  id: r.id,
  familyKey: r.family_key,
  family: r.fault_family,
  modelId: r.model_id,
  dutyId: r.duty_type_id,
  depotId: r.depot_id,
  regionId: r.region_id,
  status: r.status,
  firstBucket: r.first_bucket,
  lastBucket: r.last_bucket,
  firstTs: r.first_ts.getTime(),
  lastTs: r.last_ts.getTime(),
  members,
  mergedInto: r.merged_into,
  openedTs: r.opened_ts ? r.opened_ts.getTime() : null,
  lambda: r.lambda,
  pValue: r.p_value,
  rateSource: r.rate_source,
  dismissal: r.dismissal,
  version: r.version,
});

async function withMembers(c: Q, rows: CampaignRow[]): Promise<Group[]> {
  if (rows.length === 0) return [];
  const m = await c.query<MemberRow>(
    `SELECT campaign_id, vin::text AS vin, first_incident_id, joined_ts, runaway, deviation, slope_per_h, last_code, firmware, fixed
     FROM core.campaign_member WHERE campaign_id = ANY($1) AND active`,
    [rows.map((r) => r.id)],
  );
  const by = new Map<string, Record<string, Member>>();
  for (const x of m.rows) {
    const rec = by.get(x.campaign_id) ?? by.set(x.campaign_id, {}).get(x.campaign_id)!;
    rec[x.vin] = {
      vin: x.vin,
      incidentId: x.first_incident_id,
      firstTs: x.joined_ts.getTime(),
      runaway: x.runaway,
      deviation: x.deviation,
      slopePerH: x.slope_per_h,
      lastCode: x.last_code,
      firmware: x.firmware,
      fixed: x.fixed,
    };
  }
  return rows.map((r) => toGroup(r, by.get(r.id) ?? {}));
}

/** The live groups of one family key (MERGED/CLOSED are history). */
export async function loadBook(c: Q, key: string): Promise<KeyBook> {
  const rows = await c.query<CampaignRow>(
    `SELECT * FROM core.campaign WHERE family_key = $1 AND status NOT IN ('MERGED', 'CLOSED') FOR UPDATE`,
    [key],
  );
  const groups = await withMembers(c, rows.rows);
  return { key, groups: Object.fromEntries(groups.map((g) => [g.id, g])) };
}

export async function loadGroup(c: Q, id: string): Promise<Group | null> {
  const rows = await c.query<CampaignRow>('SELECT * FROM core.campaign WHERE id = $1', [id]);
  return (await withMembers(c, rows.rows))[0] ?? null;
}

/** Live groups of this family that another key holds this van in (a depot transfer keeps its first campaign). */
export async function memberElsewhere(c: Q, vin: string, family: string, key: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM core.campaign_member m JOIN core.campaign g ON g.id = m.campaign_id
     WHERE m.vin = $1 AND m.fault_family = $2 AND m.active AND g.family_key <> $3 LIMIT 1`,
    [vin, family, key],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Idempotency: true the first time an (incident, action, seq) is seen; false for a replay. */
export async function firstTime(c: Q, incidentId: string, action: string, seq: number): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO core.processed_incident_action (incident_id, action, seq) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [incidentId, action, seq],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Persist changed groups: merged children first (their members go inactive), then live groups and members. */
export async function saveGroups(c: Q, groups: readonly Group[]): Promise<void> {
  const ordered = [...groups].sort((a, b) => Number(b.status === 'MERGED') - Number(a.status === 'MERGED'));
  for (const g of ordered) {
    await c.query(
      `INSERT INTO core.campaign (id, family_key, fault_family, model_id, duty_type_id, depot_id, region_id, status,
         first_bucket, last_bucket, first_ts, last_ts, opened_ts, opened_at, merged_into, member_count, lambda, p_value,
         rate_source, dismissal, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $13::timestamptz IS NULL THEN NULL ELSE now() END,
         $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, first_bucket = EXCLUDED.first_bucket,
         last_bucket = EXCLUDED.last_bucket, first_ts = EXCLUDED.first_ts, last_ts = EXCLUDED.last_ts,
         opened_ts = EXCLUDED.opened_ts, opened_at = coalesce(core.campaign.opened_at, EXCLUDED.opened_at),
         merged_into = EXCLUDED.merged_into, member_count = EXCLUDED.member_count, lambda = EXCLUDED.lambda,
         p_value = EXCLUDED.p_value, rate_source = EXCLUDED.rate_source, dismissal = EXCLUDED.dismissal,
         version = EXCLUDED.version, updated_at = now()`,
      [
        g.id, g.familyKey, g.family, g.modelId, g.dutyId, g.depotId, g.regionId, g.status, g.firstBucket, g.lastBucket,
        new Date(g.firstTs), new Date(g.lastTs), g.openedTs === null ? null : new Date(g.openedTs), g.mergedInto,
        Object.keys(g.members).length, g.lambda, g.pValue, g.rateSource, g.dismissal ? JSON.stringify(g.dismissal) : null,
        g.version,
      ],
    ); // prettier-ignore
    if (g.status === 'MERGED' || g.status === 'CLOSED') {
      // merged: its members moved to the root; closed: they may join a new campaign later
      await c.query('UPDATE core.campaign_member SET active = false WHERE campaign_id = $1', [g.id]);
      continue;
    }
    for (const m of Object.values(g.members)) {
      await c.query(
        `INSERT INTO core.campaign_member (campaign_id, vin, fault_family, first_incident_id, joined_ts, runaway,
           deviation, slope_per_h, last_code, firmware, fixed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (campaign_id, vin) DO UPDATE SET runaway = EXCLUDED.runaway, fixed = EXCLUDED.fixed, active = true`,
        [
          g.id,
          m.vin,
          g.family,
          m.incidentId,
          new Date(m.firstTs),
          m.runaway,
          m.deviation,
          m.slopePerH,
          m.lastCode,
          m.firmware,
          Boolean(m.fixed),
        ],
      );
      // a new member is no longer "at risk" in this campaign
      await c.query('UPDATE core.campaign_at_risk SET active = false WHERE campaign_id = $1 AND vin = $2', [
        g.id,
        m.vin,
      ]);
    }
  }
}

export interface OutboxPayload {
  event: CampaignEvent;
  campaign: Record<string, unknown>;
}

/** One outbox row per event; the id is the event's stable id, so a re-derived event is never written twice. */
export async function enqueue(
  c: Q,
  topic: string,
  events: readonly CampaignEvent[],
  campaign: (e: CampaignEvent) => Record<string, unknown>,
) {
  for (const e of events) {
    await c.query(
      `INSERT INTO core.outbox (id, topic, key, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [
        e.eventId,
        topic,
        e.campaignId,
        JSON.stringify({ ...e, ts: new Date(e.ts).toISOString(), campaign: campaign(e) }),
      ],
    );
  }
}
