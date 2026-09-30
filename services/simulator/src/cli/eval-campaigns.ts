import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';

/**
 * `npm run eval:campaigns` (S5 scorecard). An EVALUATION tool, not detection: it runs as cw_sim and joins the
 * campaign engine's output (core.campaign*, core.incident) with sim.ground_truth.
 * "Campaign" = a group that opened (OPEN or DISMISSED); WATCHING groups are not campaigns.
 */
const H = 3_600_000;

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) =>
    (await client.query<T>(sql, args)).rows;
  const t0 = new Date(cfg.t0).getTime();
  const h = (d: Date | null | undefined) => (d ? `T0+${((d.getTime() - t0) / H).toFixed(1)} h` : '–');
  const rows: [string, string, string][] = [];
  try {
    const [hz] = await q<{ ts: Date | null }>("SELECT max(ts) + interval '1 hour' AS ts FROM core.telemetry");
    const [counts] = await q<{ campaigns: number; watching: number; merged: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('OPEN', 'DISMISSED'))::int AS campaigns,
              count(*) FILTER (WHERE status = 'WATCHING')::int AS watching, count(*) FILTER (WHERE status = 'MERGED')::int AS merged
       FROM core.campaign`,
    );
    console.log(`produced horizon: ${h(hz?.ts)} (latest hourly telemetry row) · N = ${cfg.scale}`);
    console.log(
      `campaigns: ${counts!.campaigns} opened, ${counts!.watching} watching groups, ${counts!.merged} merged\n`,
    );

    // members of opened campaigns, by ground-truth role
    const members = await q<{ id: string; role: string; vin: string; opened_ts: Date; status: string }>(
      `SELECT c.id, g.role, m.vin::text AS vin, c.opened_ts, c.status FROM core.campaign c
       JOIN core.campaign_member m ON m.campaign_id = c.id AND m.active
       JOIN sim.ground_truth g ON g.vin = m.vin WHERE c.status IN ('OPEN', 'DISMISSED')`,
    );
    const campaignsWith = (roles: string[]) => new Set(members.filter((m) => roles.includes(m.role)).map((m) => m.id));
    const S1 = ['s1_sister', 's1_late_sister', 'bad_repair'];
    const s1c = campaignsWith(S1);
    const s1bc = campaignsWith(['s1b_sister']);
    const inCampaigns = (ids: Set<string>) => members.filter((m) => ids.has(m.id));
    const s1m = inCampaigns(s1c);
    const s1Intruders = s1m.filter((m) => !S1.includes(m.role)).length;
    const s1Recall = new Set(s1m.filter((m) => S1.includes(m.role)).map((m) => m.vin)).size;
    rows.push([
      'S1',
      'exactly 1 campaign; members ⊆ sisters',
      `${s1c.size} campaign(s); ${s1Recall}/18 sisters; ${s1Intruders} non-sisters`,
    ]);
    const s1bm = inCampaigns(s1bc);
    rows.push([
      'S1b',
      'exactly 1, separate from S1',
      `${s1bc.size} campaign(s); ${new Set(s1bm.filter((m) => m.role === 's1b_sister').map((m) => m.vin)).size}/8 sisters; ${
        [...s1bc].some((id) => s1c.has(id)) ? 'SHARED with S1' : 'separate'
      }; ${s1bm.filter((m) => m.role !== 's1b_sister').length} non-sisters`,
    ]);

    // late sisters: at-risk before their own incident
    const late = await q<{ vin: string; at_risk: Date | null; incident: Date | null }>(
      `SELECT g.vin::text AS vin,
         (SELECT min(a.first_ts) FROM core.campaign_at_risk a WHERE a.vin = g.vin) AS at_risk,
         (SELECT min(i.opened_ts) FROM core.incident i WHERE i.vin = g.vin AND i.fault_family = 'COOLING') AS incident
       FROM sim.ground_truth g WHERE g.role = 's1_late_sister'`,
    );
    const before = late.filter((l) => l.at_risk && (!l.incident || l.at_risk < l.incident));
    const leads = before.filter((l) => l.incident).map((l) => (l.incident!.getTime() - l.at_risk!.getTime()) / H);
    rows.push([
      'Late sisters',
      'at-risk before own incident; lead (h)',
      `${before.length}/${late.length} (${Math.round((100 * before.length) / Math.max(1, late.length))}%); lead ${
        leads.length ? leads.map((x) => x.toFixed(1)).join(', ') : '–'
      } h`,
    ]);
    const [fp] = await q<{ n: number }>(
      `SELECT count(DISTINCT a.vin)::int AS n FROM core.campaign_at_risk a JOIN sim.ground_truth g ON g.vin = a.vin
       WHERE g.role = 's1_healthy_cohort'`,
    );
    rows.push(['At-risk false positives', 'healthy S1 cohort flagged', `${fp!.n}/42`]);
    const decoys = members.filter((m) => m.role === 'decoy_scattered' || m.role === 'decoy_same_depot_other_model');
    rows.push(['Decoys', 'admitted to any campaign = 0', `${new Set(decoys.map((d) => d.vin)).size}`]);
    const heat = campaignsWith(['heatwave_region']);
    rows.push(['Heatwave region', 'campaigns = 0', `${heat.size}`]);
    const plantRoles = new Set([...S1, 's1b_sister', 'decoy_scattered', 'decoy_same_depot_other_model', 'runaway']);
    const bgOnly = [...new Set(members.map((m) => m.id))].filter(
      (id) => !heat.has(id) && members.filter((m) => m.id === id).every((m) => !plantRoles.has(m.role)),
    );
    rows.push(['Background', 'campaigns = 0', `${bgOnly.length}`]);

    // firmware clue vs the plant's split (same query as simulator:verify #9)
    const clue = await q<{ text: string }>(
      `SELECT text FROM core.campaign_clue WHERE clue_type = 'FIRMWARE' AND campaign_id = ANY($1)`,
      [[...s1c]],
    );
    const fw = await q<{ grp: string; n: number }>(
      `SELECT CASE WHEN g.expected_campaign = 'S1' THEN 'sister' ELSE 'healthy' END AS grp, count(DISTINCT h.vin)::int AS n
       FROM sim.ground_truth g JOIN core.vehicle_firmware_history h ON h.vin = g.vin
       JOIN core.firmware_release r ON r.id = h.firmware_id AND r.version = '4.2.1'
       WHERE g.role IN ('s1_sister','bad_repair','s1_late_sister','s1_healthy_cohort')
         AND h.installed_at >= $1::timestamptz - interval '72 hours' AND h.installed_at < $1::timestamptz + interval '6 hours'
       GROUP BY 1`,
      [new Date(t0).toISOString()],
    );
    const man = (g: string) => fw.find((r) => r.grp === g)?.n ?? 0;
    rows.push([
      'Firmware clue',
      'S1 clue printed; matches the plant',
      `"${clue[0]?.text ?? '(none)'}" · plant: ${man('sister')}/18 sisters, ${man('healthy')}/42 healthy (${Math.round(
        (100 * man('healthy')) / 42,
      )}%)`,
    ]);

    // early warning: S1 open → first sister limit_ts
    const [ew] = await q<{ opened: Date | null; limit_ts: Date | null }>(
      `SELECT (SELECT min(opened_ts) FROM core.campaign WHERE id = ANY($1)) AS opened,
              (SELECT min(limit_ts) FROM sim.ground_truth WHERE role IN ('s1_sister', 's1_late_sister', 'bad_repair')) AS limit_ts`,
      [[...s1c]],
    );
    rows.push([
      'Early warning',
      'S1 OPEN → first sister limit_ts',
      ew?.opened && ew.limit_ts
        ? `${((ew.limit_ts.getTime() - ew.opened.getTime()) / H).toFixed(1)} h (opened ${h(ew.opened)}, limit ${h(ew.limit_ts)})`
        : '–',
    ]);
    const [cnt] = await q<{ rows: number; vins: number; outbox: number; unpublished: number }>(
      `SELECT (SELECT count(*)::int FROM core.campaign_member WHERE active) AS rows,
              (SELECT count(DISTINCT (vin, fault_family))::int FROM core.campaign_member WHERE active) AS vins,
              (SELECT count(*)::int FROM core.outbox) AS outbox,
              (SELECT count(*)::int FROM core.outbox WHERE published_at IS NULL) AS unpublished`,
    );
    rows.push([
      'Counting',
      'members = unique VINs after restarts',
      `${cnt!.rows} member rows = ${cnt!.vins} unique (vin, family); outbox ${cnt!.outbox} rows, ${cnt!.unpublished} unpublished`,
    ]);

    const w = [0, 1, 2].map((i) =>
      Math.max(...rows.map((r) => r[i]!.length), ['Check', 'Expected', 'Result'][i]!.length),
    );
    const fmt = (r: string[]) => `| ${r.map((c, i) => c.padEnd(w[i]!)).join(' | ')} |`;
    console.log(fmt(['Check', 'Expected', 'Result']));
    console.log(`|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`);
    for (const r of rows) console.log(fmt(r));

    const list = await q<{
      key: string;
      status: string;
      members: number;
      at_risk: number;
      opened_ts: Date | null;
      p: number | null;
    }>(
      `SELECT family_key AS key, status, member_count AS members, at_risk_count AS at_risk, opened_ts, p_value AS p
       FROM core.campaign WHERE status IN ('OPEN', 'DISMISSED') ORDER BY opened_ts`,
    );
    console.log('\nopened campaigns:');
    for (const c of list) {
      console.log(
        `  ${c.key.padEnd(22)} ${c.status.padEnd(9)} members ${String(c.members).padStart(3)}  at-risk ${String(c.at_risk).padStart(3)}  opened ${h(c.opened_ts)}  p=${c.p?.toExponential(1)}`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
