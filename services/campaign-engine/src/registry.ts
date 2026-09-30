import type pg from 'pg';

/**
 * What the campaign engine needs from the registry (cw_app, core.* only), loaded at start and refreshed:
 * vans per family-key cohort (model × duty × current depot), vans per region and depot, names for clues,
 * and the batch job's baseline fault rate per family × model × duty.
 */
export interface Names {
  model: string;
  powertrain: string;
  duty: string;
  depot: string;
  climate: string;
}

const METRIC_OF: Record<string, { col: string; unit: string } | undefined> = {
  COOLING: { col: 'coolant', unit: '°C' },
  HV_BATTERY_THERMAL: { col: 'batt', unit: '°C' },
  LV_ELECTRICAL: { col: 'lv', unit: 'V' },
};

/** Telemetry score columns of a family's metric (null for code-only families). */
export const metricOf = (family: string) => METRIC_OF[family] ?? null;

export class EngineRegistry {
  private cohort = new Map<string, string[]>();
  private regionVans = new Map<number, number>();
  private depotVans = new Map<number, number>();
  private baseline = new Map<string, number>();
  private models = new Map<number, { code: string; powertrain: string }>();
  private duties = new Map<number, string>();
  private depots = new Map<number, { code: string; regionId: number }>();
  private climates = new Map<number, string>();

  constructor(private readonly pool: pg.Pool) {}

  async load(): Promise<void> {
    const [veh, models, duties, depots, regions, rates] = await Promise.all([
      this.pool.query<{ vin: string; model_id: number; duty_type_id: number; depot_id: number; region_id: number }>(
        `SELECT v.vin::text AS vin, v.model_id, v.duty_type_id, a.depot_id, d.region_id
         FROM core.vehicle v JOIN core.vehicle_depot_assignment a ON a.vin = v.vin AND upper_inf(a.valid)
         JOIN core.depot d ON d.id = a.depot_id`,
      ),
      this.pool.query<{ id: number; code: string; powertrain: string }>(
        'SELECT id, code, powertrain FROM core.vehicle_model',
      ),
      this.pool.query<{ id: number; code: string }>('SELECT id, code FROM core.duty_type'),
      this.pool.query<{ id: number; code: string; region_id: number }>('SELECT id, code, region_id FROM core.depot'),
      this.pool.query<{ id: number; climate_zone: string }>('SELECT id, climate_zone FROM core.region'),
      this.pool.query<{ fault_family: string; model_id: number; duty_type_id: number; per1000: number }>(
        `SELECT fault_family, model_id, duty_type_id, 1000.0 * sum(codes) / nullif(sum(vehicle_days), 0) AS per1000
         FROM core.fault_rate GROUP BY 1, 2, 3`,
      ),
    ]);
    const cohort = new Map<string, string[]>();
    const regionVans = new Map<number, number>();
    const depotVans = new Map<number, number>();
    for (const r of veh.rows) {
      const k = `${r.model_id}|${r.duty_type_id}|${r.depot_id}`;
      (cohort.get(k) ?? cohort.set(k, []).get(k)!).push(r.vin);
      regionVans.set(r.region_id, (regionVans.get(r.region_id) ?? 0) + 1);
      depotVans.set(r.depot_id, (depotVans.get(r.depot_id) ?? 0) + 1);
    }
    this.cohort = cohort;
    this.regionVans = regionVans;
    this.depotVans = depotVans;
    this.models = new Map(models.rows.map((m) => [m.id, { code: m.code, powertrain: m.powertrain }]));
    this.duties = new Map(duties.rows.map((d) => [d.id, d.code]));
    this.depots = new Map(depots.rows.map((d) => [d.id, { code: d.code, regionId: d.region_id }]));
    this.climates = new Map(regions.rows.map((r) => [r.id, r.climate_zone]));
    this.baseline = new Map(
      rates.rows.map((r) => [`${r.fault_family}|${r.model_id}|${r.duty_type_id}`, Number(r.per1000 ?? 0)]),
    );
  }

  /** Vans currently in the cohort of a family key (model × duty × depot). */
  cohortVins(modelId: number, dutyId: number, depotId: number): readonly string[] {
    return this.cohort.get(`${modelId}|${dutyId}|${depotId}`) ?? [];
  }

  /** Vans in the region outside this depot (the denominator of the current regional rate). */
  regionVansExcluding(regionId: number, depotId: number): number {
    return Math.max(0, (this.regionVans.get(regionId) ?? 0) - (this.depotVans.get(depotId) ?? 0));
  }

  baselinePer1000(family: string, modelId: number, dutyId: number): number {
    return this.baseline.get(`${family}|${modelId}|${dutyId}`) ?? 0;
  }

  names(modelId: number, dutyId: number, depotId: number, regionId: number): Names {
    const m = this.models.get(modelId);
    return {
      model: m?.code ?? `model ${modelId}`,
      powertrain: m?.powertrain ?? 'DIESEL',
      duty: this.duties.get(dutyId) ?? `duty ${dutyId}`,
      depot: this.depots.get(depotId)?.code ?? `depot ${depotId}`,
      climate: this.climates.get(regionId) ?? 'TEMPERATE',
    };
  }

  get size(): number {
    let n = 0;
    for (const v of this.cohort.values()) n += v.length;
    return n;
  }
}
