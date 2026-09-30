import { H, horizonH, rowsOf, sinceT0, type Check, type EvalContext } from './common.js';

/**
 * S4 + S6 scorecard as data. Queue questions are point-in-time: each depot's latest snapshot at or before
 * T0 + atH (default 29 h: S1 open, before the T0+30 h repairs). Needs AUTO_REPAIRS=on and a horizon ≥ T0+84 h.
 */
export const TRUE_ROLES = [
  's1_sister',
  's1_late_sister',
  's1b_sister',
  'runaway',
  'decoy_scattered',
  'decoy_same_depot_other_model',
  'bad_repair',
];

interface Item {
  vin: string;
  rank: number;
  slot: string;
  score: number;
  pinned: boolean;
  reasons: string[];
}

export interface WorkshopFacts {
  horizonH: number | null;
  atH: number;
  depotCode: string;
  k: number;
  precisionAtK: number;
  loudestAtK: number;
  precisionAt50: number;
  loudestAt50: number;
  loudQueuedEver: number;
  loudTodayEver: number;
  loudAboveSisterEver: number;
  runawayRank: number | null;
  runawayTopS: number | null;
  runawayCardH: number | null;
  runawayLimitH: number | null;
  lateInQueue: number;
  lateTotal: number;
  lateLeadsH: number[];
  repairs: number;
  truthFixed: { FIXED: number; NOT_FIXED: number; PENDING: number };
  truthNotFixed: { FIXED: number; NOT_FIXED: number; PENDING: number };
  badRepairRank: number | null;
  badRepairReason: string | null;
  s1Status: string | null;
  s1Fixed: number;
  s1Members: number;
  heatwaveToday: number;
  hotToday: number;
  cards: Record<string, number>;
}

export async function evalWorkshop(e: EvalContext, atH = 29): Promise<{ checks: Check[]; facts: WorkshopFacts }> {
  const q = <T extends import('pg').QueryResultRow>(sql: string, args: unknown[] = []) =>
    rowsOf<T>(e.client, sql, args);
  const at = new Date(e.t0 + atH * H);
  const h = (d: Date | null | undefined) => sinceT0(e.t0, d);
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  const checks: Check[] = [];
  const roleOf = new Map(
    (await q<{ vin: string; role: string }>('SELECT vin::text AS vin, role FROM sim.ground_truth')).map((r) => [r.vin, r.role]),
  ); // prettier-ignore
  const isTrue = (vin: string) => TRUE_ROLES.includes(roleOf.get(vin) ?? '');

  const snaps = await q<{ depot_id: number; items: Item[] }>(
    `SELECT DISTINCT ON (depot_id) depot_id, items FROM core.queue_snapshot WHERE as_of_ts <= $1 ORDER BY depot_id, as_of_ts DESC, version DESC`,
    [at],
  );
  const byDepot = new Map(snaps.map((s) => [s.depot_id, s.items]));
  const [s1] = await q<{ depot_id: number; code: string }>(
    `SELECT a.depot_id, d.code FROM sim.ground_truth g JOIN core.vehicle_depot_assignment a ON a.vin = g.vin AND upper_inf(a.valid)
     JOIN core.depot d ON d.id = a.depot_id WHERE g.role = 's1_sister' LIMIT 1`,
  );
  const codes = new Map(
    (
      await q<{ vin: string; depot_id: number; codes: number }>(
        `SELECT t.vin::text AS vin, a.depot_id, sum(t.dtc_count)::int AS codes FROM core.telemetry t
         JOIN core.vehicle_depot_assignment a ON a.vin = t.vin AND upper_inf(a.valid)
         WHERE t.ts > $1::timestamptz - interval '24 hours' AND t.ts <= $1 GROUP BY 1, 2`,
        [at],
      )
    ).map((r) => [r.vin, r]),
  );
  const loudest = (vins: { vin: string; codes: number }[], k: number) =>
    [...vins]
      .sort((a, b) => b.codes - a.codes || a.vin.localeCompare(b.vin))
      .slice(0, k)
      .map((x) => x.vin);
  const precision = (vins: string[]) => (vins.length ? vins.filter(isTrue).length / vins.length : 0);

  const s1Items = byDepot.get(s1!.depot_id) ?? [];
  const [bays] = await q<{ n: number }>('SELECT count(*)::int AS n FROM core.workshop_bay WHERE depot_id = $1', [s1!.depot_id]); // prettier-ignore
  const k = bays!.n;
  const precisionAtK = precision(s1Items.slice(0, k).map((i) => i.vin));
  const loudestAtK = precision(loudest([...codes.values()].filter((c) => c.depot_id === s1!.depot_id), k)); // prettier-ignore
  checks.push(['Queue vs loudest-first', `precision@${k} at ${s1!.code} (today's bays)`, `ours ${pct(precisionAtK)} vs loudest-first ${pct(loudestAtK)}`]); // prettier-ignore
  const fleet = [...byDepot.values()].flat().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
  const precisionAt50 = precision(fleet.slice(0, 50).map((i) => i.vin));
  const loudestAt50 = precision(loudest([...codes.values()], 50));
  checks.push(['', 'precision@50 fleet-wide', `ours ${pct(precisionAt50)} vs loudest-first ${pct(loudestAt50)}`]);

  const scoreOf = new Map(fleet.map((i) => [i.vin, i]));
  const sisterScores = [...roleOf]
    .filter(([, r]) => r === 's1_sister')
    .map(([v]) => scoreOf.get(v)?.score)
    .filter((x): x is number => x !== undefined);
  const minSister = Math.min(...sisterScores);
  const loud = [...roleOf]
    .filter(([, r]) => r === 'loud_stable')
    .map(([v]) => scoreOf.get(v))
    .filter((x): x is Item => !!x);
  const loudAbove = loud.filter((l) => l.score > minSister || l.pinned).length;
  const [lr] = await q<{ queued: number; today: number; above: number }>(
    `WITH items AS (
       SELECT s.depot_id, s.version, i->>'vin' AS vin, (i->>'rank')::int AS rank, i->>'slot' AS slot, g.role
       FROM core.queue_snapshot s, jsonb_array_elements(s.items) i JOIN sim.ground_truth g ON g.vin = i->>'vin')
     SELECT count(DISTINCT vin) FILTER (WHERE role = 'loud_stable')::int AS queued,
            count(DISTINCT vin) FILTER (WHERE role = 'loud_stable' AND slot = 'TODAY')::int AS today,
            (SELECT count(*) FROM items l JOIN items x ON x.depot_id = l.depot_id AND x.version = l.version
               AND x.role = 's1_sister' AND l.rank < x.rank WHERE l.role = 'loud_stable')::int AS above
     FROM items`,
  );
  checks.push(['Loud-but-stable', 'none above any S1 sister', `snapshot: ${loudAbove} of ${loud.length} queued loud vans above the lowest S1 sister (${Number.isFinite(minSister) ? minSister.toFixed(2) : '–'}); whole run: ${lr!.queued} loud vans ever queued, ${lr!.today} ever in today's bays, ${lr!.above} times above an S1 sister at the same depot`]); // prettier-ignore

  const [rv] = await q<{ vin: string; depot_id: number }>(
    `SELECT g.vin::text AS vin, a.depot_id FROM sim.ground_truth g JOIN core.vehicle_depot_assignment a ON a.vin = g.vin AND upper_inf(a.valid) WHERE g.role = 'runaway'`,
  );
  const [card] = await q<{ top_s: number | null; event_ts: Date; limit_ts: Date | null }>(
    `SELECT extract(epoch FROM c.queue_top_at - c.source_written_at)::float8 AS top_s, c.event_ts,
            (SELECT limit_ts FROM sim.ground_truth WHERE vin = c.vin) AS limit_ts
     FROM core.alert_card c WHERE c.card_type = 'RUNAWAY' AND c.vin = $1 ORDER BY c.created_at LIMIT 1`,
    [rv?.vin],
  );
  const rvRanks = await q<{ rank: number | null }>(
    `SELECT (SELECT (i->>'rank')::int FROM jsonb_array_elements(s.items) i WHERE i->>'vin' = $2) AS rank
     FROM core.queue_snapshot s WHERE s.depot_id = $1 AND s.as_of_ts >= $3 ORDER BY s.as_of_ts LIMIT 20`,
    [rv?.depot_id, rv?.vin, card?.event_ts ?? new Date(0)],
  );
  const runawayRank = rvRanks.find((r) => r.rank !== null)?.rank ?? null;
  checks.push(['Runaway', 'rank 1 in its depot; critical → top (s)', card ? `rank ${runawayRank ?? '–'} after its card (${h(card.event_ts)}); critical incident written → top of queue ${card.top_s === null ? '–' : `${card.top_s.toFixed(2)} s`}; limit ${h(card.limit_ts)}` : 'no runaway card']); // prettier-ignore

  const late = await q<{ vin: string; first_q: Date | null; incident: Date | null }>(
    `SELECT g.vin::text AS vin,
       (SELECT min(s.as_of_ts) FROM core.queue_snapshot s, jsonb_array_elements(s.items) i
         WHERE i->>'vin' = g.vin AND i->'reasons' ? 'AT_RISK') AS first_q,
       (SELECT min(opened_ts) FROM core.incident WHERE vin = g.vin AND fault_family = 'COOLING') AS incident
     FROM sim.ground_truth g WHERE g.role = 's1_late_sister'`,
  );
  const before = late.filter((l) => l.first_q && (!l.incident || l.first_q < l.incident));
  const leads = before.filter((l) => l.incident).map((l) => (l.incident!.getTime() - l.first_q!.getTime()) / H);
  checks.push(['Late sisters', 'in the queue (at-risk) before their own incident', `${before.length}/${late.length}; lead ${leads.length ? leads.map((x) => x.toFixed(1)).join(', ') : '–'} h`]); // prettier-ignore

  const fx = await q<{ truth: string | null; ours: string }>(
    `SELECT g.repair_outcome AS truth, r.status AS ours FROM core.repair r JOIN sim.ground_truth g ON g.vin = r.vin`,
  );
  const cell = (t: string, o: string) => fx.filter((x) => (x.truth ?? 'none') === t && x.ours === o).length;
  const conf = (t: string) => ({
    FIXED: cell(t, 'FIXED'),
    NOT_FIXED: cell(t, 'NOT_FIXED'),
    PENDING: cell(t, 'PENDING') + cell(t, 'REPAIRED'),
  });
  const truthFixed = conf('fixed');
  const truthNotFixed = conf('not_fixed');
  const confText = (t: string, c: typeof truthFixed) => `truth ${t}: FIXED ${c.FIXED}, NOT_FIXED ${c.NOT_FIXED}, PENDING ${c.PENDING}`; // prettier-ignore
  checks.push(['Fix confirmation', 'repaired sisters FIXED; bad repair NOT_FIXED', `${fx.length} repairs · ${confText('fixed', truthFixed)} · ${confText('not_fixed', truthNotFixed)}`]); // prettier-ignore
  const [bad] = await q<{ rank: number | null; slot: string | null; reason: string | null }>(
    `SELECT qi.rank, qi.slot,
       (SELECT r->>'text' FROM jsonb_array_elements(qi.reasons) r WHERE r->>'type' = 'NOT_FIXED') AS reason
     FROM sim.ground_truth g LEFT JOIN core.queue_item qi ON qi.vin = g.vin WHERE g.role = 'bad_repair'`,
  );
  checks.push(['', 'bad repair back in the queue', bad?.rank ? `rank ${bad.rank} (${bad.slot}): "${bad.reason ?? ''}"` : 'not in the queue']); // prettier-ignore

  const [camp] = await q<{ status: string; fixed: number; members: number }>(
    `SELECT c.status, count(*) FILTER (WHERE m.fixed)::int AS fixed, count(*)::int AS members
     FROM core.campaign c JOIN core.campaign_member m ON m.campaign_id = c.id
     JOIN sim.ground_truth g ON g.vin = m.vin AND g.role IN ('s1_sister', 's1_late_sister', 'bad_repair')
     WHERE c.status IN ('OPEN', 'DISMISSED', 'CLOSED') GROUP BY c.id, c.status ORDER BY members DESC LIMIT 1`,
  );
  checks.push(['Campaign close', 'S1 stays OPEN (bad repair, late sisters)', camp ? `${camp.status}: ${camp.fixed} of ${camp.members} fixed` : '–']); // prettier-ignore

  const [hb] = await q<{ heat: number; hot: number }>(
    `SELECT count(DISTINCT i->>'vin') FILTER (WHERE g.role = 'heatwave_region')::int AS heat,
            count(DISTINCT i->>'vin') FILTER (WHERE g.role = 'naturally_hot')::int AS hot
     FROM core.queue_snapshot s, jsonb_array_elements(s.items) i JOIN sim.ground_truth g ON g.vin = i->>'vin'
     WHERE i->>'slot' = 'TODAY'`,
  );
  checks.push(['Heatwave / naturally hot', "not in today's bays", `heatwave ${hb!.heat} vans, naturally hot ${hb!.hot} vans (ever, any snapshot)`]); // prettier-ignore
  const cardRows = await q<{ t: string; n: number }>('SELECT card_type AS t, count(*)::int AS n FROM core.alert_card GROUP BY 1 ORDER BY 1'); // prettier-ignore
  checks.push(['Cards', 'runaways and new/growing campaigns only', cardRows.map((c) => `${c.t} ${c.n}`).join(', ') || '0']); // prettier-ignore

  const hOf = (d: Date | null | undefined) => (d ? (d.getTime() - e.t0) / H : null);
  return {
    checks,
    facts: {
      horizonH: await horizonH(e.client, e.t0),
      atH,
      depotCode: s1!.code,
      k,
      precisionAtK,
      loudestAtK,
      precisionAt50,
      loudestAt50,
      loudQueuedEver: lr!.queued,
      loudTodayEver: lr!.today,
      loudAboveSisterEver: lr!.above,
      runawayRank,
      runawayTopS: card?.top_s ?? null,
      runawayCardH: hOf(card?.event_ts),
      runawayLimitH: hOf(card?.limit_ts),
      lateInQueue: before.length,
      lateTotal: late.length,
      lateLeadsH: leads,
      repairs: fx.length,
      truthFixed,
      truthNotFixed,
      badRepairRank: bad?.rank ?? null,
      badRepairReason: bad?.reason ?? null,
      s1Status: camp?.status ?? null,
      s1Fixed: camp?.fixed ?? 0,
      s1Members: camp?.members ?? 0,
      heatwaveToday: hb!.heat,
      hotToday: hb!.hot,
      cards: Object.fromEntries(cardRows.map((c) => [c.t, c.n])),
    },
  };
}
