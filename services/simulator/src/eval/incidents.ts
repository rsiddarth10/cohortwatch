import { rowsOf, type EvalContext } from './common.js';

/**
 * S3 scorecard as data: per ground-truth role, how many vans our detector flagged vs the global-threshold rule
 * (run in shadow on the same readings), with onset→incident lag and runaway warning hours.
 */
export interface IncidentRow {
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

export const EXPECTED_INCIDENTS: Record<string, string> = {
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

export interface IncidentEval {
  rows: IncidentRow[];
  total: number;
  signal: number;
  dtc: number;
  from: Date | null;
  to: Date | null;
}

export async function evalIncidents(e: EvalContext): Promise<IncidentEval> {
  const rows = await rowsOf<IncidentRow>(e.client, SQL);
  const [s] = await rowsOf<{ n: number; from: Date | null; to: Date | null; sig: number; dtc: number }>(
    e.client,
    `SELECT count(*)::int AS n, min(opened_ts) AS "from", max(opened_ts) AS "to",
            count(*) FILTER (WHERE trigger = 'SIGNAL')::int AS sig, count(*) FILTER (WHERE trigger = 'DTC_RATE')::int AS dtc
     FROM core.incident`,
  );
  return { rows, total: s!.n, signal: s!.sig, dtc: s!.dtc, from: s!.from, to: s!.to };
}
