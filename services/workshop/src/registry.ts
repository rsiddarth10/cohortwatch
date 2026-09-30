import type pg from 'pg';

/**
 * What the workshop needs from the registry (cw_app, core.* only), refreshed periodically: each van's CURRENT depot
 * (the bay is where the van is now), duty and powertrain, whether it is in service tomorrow, and bays per depot.
 *
 * In service tomorrow (ADR 0015): the registry has `in_service` and `status` but no shift calendar, so every van
 * that is in service and ACTIVE counts as in service tomorrow. The factor stays in the score for real calendars.
 */
export interface Van {
  vin: string;
  depotId: number;
  dutyId: number;
  powertrain: string;
  inServiceTomorrow: boolean;
}

export class WorkshopRegistry {
  private vans = new Map<string, Van>();
  private byDepot = new Map<number, string[]>();
  private bays = new Map<number, number>();
  private depotCodes = new Map<number, string>();

  constructor(private readonly pool: pg.Pool) {}

  async load(): Promise<void> {
    const [veh, bays, depots] = await Promise.all([
      this.pool.query<{ vin: string; depot_id: number; duty_type_id: number; powertrain: string; ok: boolean }>(
        `SELECT v.vin::text AS vin, a.depot_id, v.duty_type_id, m.powertrain, (v.in_service AND v.status = 'ACTIVE') AS ok
         FROM core.vehicle v JOIN core.vehicle_depot_assignment a ON a.vin = v.vin AND upper_inf(a.valid)
         JOIN core.vehicle_model m ON m.id = v.model_id`,
      ),
      this.pool.query<{ depot_id: number; n: number }>(
        'SELECT depot_id, count(*)::int AS n FROM core.workshop_bay GROUP BY 1',
      ),
      this.pool.query<{ id: number; code: string }>('SELECT id, code FROM core.depot'),
    ]);
    const vans = new Map<string, Van>();
    const byDepot = new Map<number, string[]>();
    for (const r of veh.rows) {
      vans.set(r.vin, {
        vin: r.vin,
        depotId: r.depot_id,
        dutyId: r.duty_type_id,
        powertrain: r.powertrain,
        inServiceTomorrow: r.ok,
      });
      (byDepot.get(r.depot_id) ?? byDepot.set(r.depot_id, []).get(r.depot_id)!).push(r.vin);
    }
    this.vans = vans;
    this.byDepot = byDepot;
    this.bays = new Map(bays.rows.map((b) => [b.depot_id, b.n]));
    this.depotCodes = new Map(depots.rows.map((d) => [d.id, d.code]));
  }

  van(vin: string): Van | undefined {
    return this.vans.get(vin);
  }

  depotVins(depotId: number): readonly string[] {
    return this.byDepot.get(depotId) ?? [];
  }

  depots(): number[] {
    return [...this.byDepot.keys()].sort((a, b) => a - b);
  }

  baysAt(depotId: number): number {
    return this.bays.get(depotId) ?? 0;
  }

  depotCode(depotId: number): string {
    return this.depotCodes.get(depotId) ?? `depot ${depotId}`;
  }

  get size(): number {
    return this.vans.size;
  }
}
