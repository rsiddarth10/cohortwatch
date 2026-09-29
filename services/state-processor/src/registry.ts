import { METRICS, type Family, type Metric, type MetricBaseline, type VanBaseline } from '@cw/domain';
import type pg from 'pg';

/**
 * Registry + baselines cache (loaded at start-up, refreshed periodically). Detection reads only core.* as cw_app.
 * Depot assignments are kept as validity ranges, so an incident's depot is the one at EVENT time and a later
 * transfer does not rewrite it.
 */
export interface Assignment {
  depotId: number;
  regionId: number;
  from: number;
  /** Exclusive end (epoch ms); Infinity = current. */
  to: number;
}

export interface VanInfo {
  modelId: number;
  dutyId: number;
  assignments: Assignment[];
  baseline: VanBaseline | undefined;
}

export interface Placement {
  depotId: number;
  regionId: number;
}

export function placementAt(v: VanInfo, tsMs: number): Placement | undefined {
  let best: Assignment | undefined;
  for (const a of v.assignments) {
    if (tsMs >= a.from && tsMs < a.to) return a;
    if (!best || a.from > best.from) best = a; // outside every range (clock at the edges): newest assignment
  }
  return best;
}

interface BaselineRow {
  vin?: string;
  model_id?: number;
  duty_type_id?: number;
  metric: Metric;
  median: number;
  mad: number;
  slope_median: number;
  slope_mad: number;
}

const toMetric = (r: BaselineRow, source: 'VAN' | 'COHORT'): MetricBaseline => ({
  median: r.median,
  mad: r.mad,
  slopeMedian: r.slope_median,
  slopeMad: r.slope_mad,
  source,
});

export class RegistryCache {
  vans = new Map<string, VanInfo>();
  baselineRunId: number | null = null;
  vansWithOwnBaseline = 0;

  constructor(private readonly pool: pg.Pool) {}

  get(vin: string): VanInfo | undefined {
    return this.vans.get(vin);
  }

  async load(): Promise<void> {
    const [veh, own, cohort, dtc, run] = await Promise.all([
      this.pool.query<{
        vin: string;
        model_id: number;
        duty_type_id: number;
        depot_id: number;
        region_id: number;
        lo: Date | null;
        hi: Date | null;
      }>(
        `SELECT v.vin::text AS vin, v.model_id, v.duty_type_id, a.depot_id, d.region_id, lower(a.valid) AS lo, upper(a.valid) AS hi
         FROM core.vehicle v JOIN core.vehicle_depot_assignment a ON a.vin = v.vin JOIN core.depot d ON d.id = a.depot_id`,
      ),
      this.pool.query<BaselineRow>(
        'SELECT vin::text AS vin, metric, median, mad, slope_median, slope_mad FROM core.vehicle_baseline',
      ),
      this.pool.query<BaselineRow>(
        'SELECT model_id, duty_type_id, metric, median, mad, slope_median, slope_mad FROM core.cohort_baseline',
      ),
      this.pool.query<{ vin: string; fault_family: Family; codes_per_day: number }>(
        'SELECT vin::text AS vin, fault_family, codes_per_day FROM core.vehicle_dtc_baseline',
      ),
      this.pool.query<{ id: number }>('SELECT max(id) AS id FROM core.baseline_run'),
    ]);

    const vans = new Map<string, VanInfo>();
    for (const r of veh.rows) {
      let v = vans.get(r.vin);
      if (!v)
        vans.set(r.vin, (v = { modelId: r.model_id, dutyId: r.duty_type_id, assignments: [], baseline: undefined }));
      v.assignments.push({
        depotId: r.depot_id,
        regionId: r.region_id,
        from: r.lo ? r.lo.getTime() : -Infinity,
        to: r.hi ? r.hi.getTime() : Infinity,
      });
    }
    const cohorts = new Map<string, Partial<Record<Metric, MetricBaseline>>>();
    for (const r of cohort.rows) {
      const k = `${r.model_id}|${r.duty_type_id}`;
      (cohorts.get(k) ?? cohorts.set(k, {}).get(k)!)[r.metric] = toMetric(r, 'COHORT');
    }
    const ownByVin = new Map<string, Partial<Record<Metric, MetricBaseline>>>();
    for (const r of own.rows)
      (ownByVin.get(r.vin!) ?? ownByVin.set(r.vin!, {}).get(r.vin!)!)[r.metric] = toMetric(r, 'VAN');
    const dtcByVin = new Map<string, Partial<Record<Family, number>>>();
    for (const r of dtc.rows)
      (dtcByVin.get(r.vin) ?? dtcByVin.set(r.vin, {}).get(r.vin)!)[r.fault_family] = r.codes_per_day;

    let withOwn = 0;
    for (const [vin, v] of vans) {
      const mine = ownByVin.get(vin) ?? {};
      const cohortOf = cohorts.get(`${v.modelId}|${v.dutyId}`) ?? {};
      const metrics: Partial<Record<Metric, MetricBaseline>> = {};
      for (const m of METRICS) {
        const b = mine[m] ?? cohortOf[m]; // a new van without history uses its model × duty cohort
        if (b) metrics[m] = b;
      }
      if (ownByVin.has(vin)) withOwn++;
      v.baseline = Object.keys(metrics).length > 0 ? { metrics, dtcPerDay: dtcByVin.get(vin) ?? {} } : undefined;
    }
    this.vans = vans;
    this.vansWithOwnBaseline = withOwn;
    this.baselineRunId = run.rows[0]?.id ?? null;
  }
}
