import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';

/**
 * `npm run eval:workshop` (S4 + S6 scorecard). An EVALUATION tool, not detection: it runs as cw_sim and joins the
 * workshop's output (core.queue_snapshot, core.repair*, core.alert_card, core.campaign*) with sim.ground_truth.
 * Queue questions are point-in-time: each depot's latest snapshot at or before T0 + EVAL_AT_H (default 29 h,
 * S1 open and before the T0+30 h repairs). Run with AUTO_REPAIRS=on to a produced horizon ≥ T0+84 h.
 */
const H = 3_600_000;
const TRUE_ROLES = [
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

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) =>
    (await client.query<T>(sql, args)).rows;
  const t0 = new Date(cfg.t0).getTime();
  const atH = Number(process.env.EVAL_AT_H ?? 29);
  const at = new Date(t0 + atH * H);
  const h = (d: Date | null | undefined) => (d ? `T0+${((d.getTime() - t0) / H).toFixed(1)} h` : '–');
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  const rows: [string, string, string][] = [];
  try {
    const [hz] = await q<{ ts: Date | null }>(`SELECT max(ts) + interval '1 hour' AS ts FROM core.telemetry`);
    console.log(`produced horizon: ${h(hz?.ts)} · queue snapshot at ${h(at)} · N = ${cfg.scale}\n`);
    const roleOf = new Map(
      (await q<{ vin: string; role: string }>('SELECT vin::text AS vin, role FROM sim.ground_truth')).map((r) => [
        r.vin,
        r.role,
      ]),
    );
    const isTrue = (vin: string) => TRUE_ROLES.includes(roleOf.get(vin) ?? '');

    // point-in-time queues
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
    const [bays] = await q<{ n: number }>('SELECT count(*)::int AS n FROM core.workshop_bay WHERE depot_id = $1', [
      s1!.depot_id,
    ]);
    const k = bays!.n;
    const oursS1 = s1Items.slice(0, k).map((i) => i.vin);
    const loudS1 = loudest(
      [...codes.values()].filter((c) => c.depot_id === s1!.depot_id),
      k,
    );
    rows.push([
      'Queue vs loudest-first',
      `precision@${k} at ${s1!.code} (today's bays)`,
      `ours ${pct(precision(oursS1))} vs loudest-first ${pct(precision(loudS1))}`,
    ]);
    const fleet = [...byDepot.values()].flat().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
    const oursTop = fleet.slice(0, 50).map((i) => i.vin);
    const loudTop = loudest([...codes.values()], 50);
    rows.push([
      '',
      'precision@50 fleet-wide',
      `ours ${pct(precision(oursTop))} vs loudest-first ${pct(precision(loudTop))}`,
    ]);

    // loud-but-stable vs S1 sisters (scores at the snapshot)
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
    const loudS1Above = s1Items.filter((i) => roleOf.get(i.vin) === 'loud_stable').length;
    // over the whole run: any depot version where a loud van ranked above an S1 sister of the same depot
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
    rows.push([
      'Loud-but-stable',
      'none above any S1 sister',
      `snapshot: ${loudAbove} of ${loud.length} queued loud vans above the lowest S1 sister (${minSister.toFixed(2)}); whole run: ${lr!.queued} loud vans ever queued, ${lr!.today} ever in today's bays, ${lr!.above} times above an S1 sister at the same depot`,
    ]);

    // runaway
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
    const first = rvRanks.find((r) => r.rank !== null)?.rank ?? null;
    rows.push([
      'Runaway',
      'rank 1 in its depot; critical → top (s)',
      card
        ? `rank ${first ?? '–'} after its card (${h(card.event_ts)}); critical incident written → top of queue ${card.top_s === null ? '–' : `${card.top_s.toFixed(2)} s`}; limit ${h(card.limit_ts)}`
        : 'no runaway card',
    ]);

    // late sisters: at-risk in the queue before their own incident
    const late = await q<{ vin: string; first_q: Date | null; incident: Date | null }>(
      `SELECT g.vin::text AS vin,
         (SELECT min(s.as_of_ts) FROM core.queue_snapshot s, jsonb_array_elements(s.items) i
           WHERE i->>'vin' = g.vin AND i->'reasons' ? 'AT_RISK') AS first_q,
         (SELECT min(opened_ts) FROM core.incident WHERE vin = g.vin AND fault_family = 'COOLING') AS incident
       FROM sim.ground_truth g WHERE g.role = 's1_late_sister'`,
    );
    const before = late.filter((l) => l.first_q && (!l.incident || l.first_q < l.incident));
    const leads = before
      .filter((l) => l.incident)
      .map((l) => ((l.incident!.getTime() - l.first_q!.getTime()) / H).toFixed(1));
    rows.push([
      'Late sisters',
      'in the queue (at-risk) before their own incident',
      `${before.length}/${late.length}; lead ${leads.length ? leads.join(', ') : '–'} h`,
    ]);

    // fix confirmation vs ground truth
    const fx = await q<{ truth: string | null; ours: string }>(
      `SELECT g.repair_outcome AS truth, r.status AS ours FROM core.repair r JOIN sim.ground_truth g ON g.vin = r.vin`,
    );
    const cell = (t: string, o: string) => fx.filter((x) => (x.truth ?? 'none') === t && x.ours === o).length;
    const confusion = ['fixed', 'not_fixed']
      .map(
        (t) =>
          `truth ${t}: FIXED ${cell(t, 'FIXED')}, NOT_FIXED ${cell(t, 'NOT_FIXED')}, PENDING ${cell(t, 'PENDING') + cell(t, 'REPAIRED')}`,
      )
      .join(' · ');
    rows.push([
      'Fix confirmation',
      'repaired sisters FIXED; bad repair NOT_FIXED',
      `${fx.length} repairs · ${confusion}`,
    ]);
    const [bad] = await q<{ vin: string; rank: number | null; slot: string | null; reason: string | null }>(
      `SELECT g.vin::text AS vin, qi.rank, qi.slot,
         (SELECT r->>'text' FROM jsonb_array_elements(qi.reasons) r WHERE r->>'type' = 'NOT_FIXED') AS reason
       FROM sim.ground_truth g LEFT JOIN core.queue_item qi ON qi.vin = g.vin WHERE g.role = 'bad_repair'`,
    );
    rows.push([
      '',
      'bad repair back in the queue',
      bad?.rank ? `rank ${bad.rank} (${bad.slot}): "${bad.reason ?? ''}"` : 'not in the queue',
    ]);

    // campaign close
    const [camp] = await q<{ status: string; fixed: number; members: number }>(
      `SELECT c.status, count(*) FILTER (WHERE m.fixed)::int AS fixed, count(*)::int AS members
       FROM core.campaign c JOIN core.campaign_member m ON m.campaign_id = c.id
       JOIN sim.ground_truth g ON g.vin = m.vin AND g.role IN ('s1_sister', 's1_late_sister', 'bad_repair')
       WHERE c.status IN ('OPEN', 'DISMISSED', 'CLOSED') GROUP BY c.id, c.status ORDER BY members DESC LIMIT 1`,
    );
    rows.push([
      'Campaign close',
      'S1 stays OPEN (bad repair, late sisters)',
      camp ? `${camp.status}: ${camp.fixed} of ${camp.members} fixed` : '–',
    ]);

    // heatwave / naturally hot in today's bays (any snapshot)
    const [hb] = await q<{ heat: number; hot: number }>(
      `SELECT count(DISTINCT i->>'vin') FILTER (WHERE g.role = 'heatwave_region')::int AS heat,
              count(DISTINCT i->>'vin') FILTER (WHERE g.role = 'naturally_hot')::int AS hot
       FROM core.queue_snapshot s, jsonb_array_elements(s.items) i JOIN sim.ground_truth g ON g.vin = i->>'vin'
       WHERE i->>'slot' = 'TODAY'`,
    );
    rows.push([
      'Heatwave / naturally hot',
      "not in today's bays",
      `heatwave ${hb!.heat} vans, naturally hot ${hb!.hot} vans (ever, any snapshot)`,
    ]);
    const cards = await q<{ t: string; n: number }>(
      'SELECT card_type AS t, count(*)::int AS n FROM core.alert_card GROUP BY 1 ORDER BY 1',
    );
    rows.push([
      'Cards',
      'runaways and new/growing campaigns only',
      cards.map((c) => `${c.t} ${c.n}`).join(', ') || '0',
    ]);

    const w = [0, 1, 2].map((i) =>
      Math.max(...rows.map((r) => r[i]!.length), ['Check', 'Expected', 'Result'][i]!.length),
    );
    const fmt = (r: string[]) => `| ${r.map((c, i) => c.padEnd(w[i]!)).join(' | ')} |`;
    console.log(fmt(['Check', 'Expected', 'Result']));
    console.log(`|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`);
    for (const r of rows) console.log(fmt(r));
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
