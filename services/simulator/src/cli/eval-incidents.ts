import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';

/**
 * `npm run eval:incidents` (S3 scorecard). An EVALUATION tool, not detection: it runs as cw_sim and joins the
 * detector's output (core.incident, core.global_rule_hit) with sim.ground_truth, per role.
 *
 * "ours" = incidents from the state processor (own normal − peers, k of n). "global" = the simple
 * global-threshold rule (coolant > GLOBAL_COOLANT_THRESHOLD_C or battery > GLOBAL_BATT_TEMP_THRESHOLD_C for
 * the same k of n), run in shadow by the state processor on the same readings.
 */

interface Row {
  role: string;
  vans: number;
  ours: number;
  ours_signal: number;
  ours_dtc: number;
  ours_family: number;
  global: number;
  lag_p50: number | null;
  lag_max: number | null;
  glag_p50: number | null;
  glag_max: number | null;
  critical: number;
  warn_min: number | null;
  warn_max: number | null;
}

const EXPECTED: Record<string, string> = {
  s1_sister: 'flagged',
  s1_late_sister: 'flagged',
  s1b_sister: 'flagged',
  runaway: 'critical',
  decoy_scattered: 'flagged (S5 excludes)',
  decoy_same_depot_other_model: 'flagged (S5 excludes)',
  heatwave_region: '~0',
  naturally_hot: '~0',
  sensor_glitch: '0',
  loud_stable: 'report',
  s1_healthy_cohort: '~0',
  bad_repair: 'flagged',
  background: 'rate / 1,000',
};

const SQL = `
WITH gt AS (SELECT vin, role, fault_family, onset_ts, limit_ts FROM sim.ground_truth),
inc AS (SELECT vin, fault_family, trigger, opened_ts, runaway, critical_ts FROM core.incident),
per_van AS (
  SELECT gt.vin, gt.role,
    EXISTS (SELECT 1 FROM inc WHERE inc.vin = gt.vin) AS ours,
    EXISTS (SELECT 1 FROM inc WHERE inc.vin = gt.vin AND inc.trigger = 'SIGNAL') AS ours_signal,
    EXISTS (SELECT 1 FROM inc WHERE inc.vin = gt.vin AND inc.trigger = 'DTC_RATE') AS ours_dtc,
    EXISTS (SELECT 1 FROM inc WHERE inc.vin = gt.vin AND inc.fault_family = gt.fault_family) AS ours_family,
    EXISTS (SELECT 1 FROM core.global_rule_hit h WHERE h.vin = gt.vin) AS global,
    (SELECT extract(epoch FROM min(inc.opened_ts) - gt.onset_ts) / 3600 FROM inc
      WHERE inc.vin = gt.vin AND inc.fault_family = gt.fault_family) AS lag_h,
    (SELECT extract(epoch FROM min(h.first_ts) - gt.onset_ts) / 3600 FROM core.global_rule_hit h
      WHERE h.vin = gt.vin) AS glag_h,
    (SELECT bool_or(inc.runaway) FROM inc WHERE inc.vin = gt.vin) AS critical,
    (SELECT extract(epoch FROM gt.limit_ts - min(inc.critical_ts)) / 3600 FROM inc
      WHERE inc.vin = gt.vin AND inc.critical_ts IS NOT NULL) AS warn_h
  FROM gt
)
SELECT role, count(*)::int AS vans,
  count(*) FILTER (WHERE ours)::int AS ours,
  count(*) FILTER (WHERE ours_signal)::int AS ours_signal,
  count(*) FILTER (WHERE ours_dtc)::int AS ours_dtc,
  count(*) FILTER (WHERE ours_family)::int AS ours_family,
  count(*) FILTER (WHERE global)::int AS global,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_h)::float8 AS lag_p50,
  max(lag_h)::float8 AS lag_max,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY glag_h)::float8 AS glag_p50,
  max(glag_h)::float8 AS glag_max,
  count(*) FILTER (WHERE critical)::int AS critical,
  min(warn_h)::float8 AS warn_min, max(warn_h)::float8 AS warn_max
FROM per_van GROUP BY role ORDER BY role`;

const f1 = (x: number | null) => (x === null ? '–' : x.toFixed(1));
const pct = (n: number, d: number) => (d === 0 ? '–' : `${((100 * n) / d).toFixed(1)}%`);

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const rows = (await client.query<Row>(SQL)).rows;
    const span = await client.query<{ n: number; from: Date | null; to: Date | null; sig: number; dtc: number }>(
      `SELECT count(*)::int AS n, min(opened_ts) AS "from", max(opened_ts) AS "to",
              count(*) FILTER (WHERE trigger = 'SIGNAL')::int AS sig, count(*) FILTER (WHERE trigger = 'DTC_RATE')::int AS dtc
       FROM core.incident`,
    );
    const s = span.rows[0]!;
    const t0 = new Date(cfg.t0).getTime();
    const hours = (d: Date | null) => (d ? ((d.getTime() - t0) / 3_600_000).toFixed(1) : '–');
    console.log(
      `incidents: ${s.n} (signal ${s.sig}, DTC-rate ${s.dtc}); opened T0+${hours(s.from)} h … T0+${hours(s.to)} h; N = ${cfg.scale}`,
    );
    console.log(
      `global rule: coolant > ${process.env.GLOBAL_COOLANT_THRESHOLD_C ?? cfg.model.globalCoolantThresholdC ?? 97} °C, battery > ${
        process.env.GLOBAL_BATT_TEMP_THRESHOLD_C ?? cfg.model.globalBattTempThresholdC ?? 47
      } °C, same k of n\n`,
    );
    const head = [
      'role',
      'vans',
      'expected',
      'ours',
      'ours %',
      'signal',
      'DTC-rate',
      'global',
      'global %',
      'onset→incident h (p50/max)',
      'global onset→hit h',
      'critical',
      'warning h',
    ];
    const lines = rows.map((r) => [
      r.role,
      String(r.vans),
      EXPECTED[r.role] ?? '',
      String(r.ours),
      pct(r.ours, r.vans),
      String(r.ours_signal),
      String(r.ours_dtc),
      String(r.global),
      pct(r.global, r.vans),
      r.lag_p50 === null ? '–' : `${f1(r.lag_p50)} / ${f1(r.lag_max)}`,
      r.glag_p50 === null ? '–' : `${f1(r.glag_p50)} / ${f1(r.glag_max)}`,
      r.critical ? String(r.critical) : '',
      r.warn_min === null ? '' : r.warn_min === r.warn_max ? f1(r.warn_min) : `${f1(r.warn_min)}–${f1(r.warn_max)}`,
    ]); // prettier-ignore
    const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
    const fmt = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(w[i]!)).join(' | ')} |`;
    console.log(fmt(head));
    console.log(`|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`);
    for (const l of lines) console.log(fmt(l));

    const bg = rows.find((r) => r.role === 'background');
    if (bg && bg.vans > 0) {
      const per1000 = (n: number) => ((1000 * n) / bg.vans).toFixed(1);
      console.log(
        `\nbackground false-incident rate per 1,000 vans: ours ${per1000(bg.ours)} (signal ${per1000(bg.ours_signal)}, DTC-rate ${per1000(bg.ours_dtc)}); global rule ${per1000(bg.global)}`,
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
