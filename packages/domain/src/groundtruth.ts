import type { FaultFamily } from './catalog.js';
import type { SimParams } from './params.js';
import type { Registry } from './registry.js';
import { roleOf, type GroundTruthRole, type Scenario } from './scenario.js';
import { VehicleStream, makeWorldContext, type SimEvent } from './simulate.js';
import { DAY_MS } from './time.js';

/** Brief §5.7. Simulator-private: written to sim.ground_truth and data/sim-private only. */
export interface GroundTruthRow {
  vin: string;
  scenarioId: string | null;
  role: GroundTruthRole;
  faultFamily: FaultFamily | null;
  onsetTs: number | null;
  late: boolean;
  limitTs: number | null;
  expectedCampaign: string | null;
  repairOutcome: 'fixed' | 'not_fixed' | null;
}

const DRIVING_EVENTS = new Set(['PERIODIC', 'HARSH_BRAKE', 'HARSH_ACCEL', 'DTC', 'TRIP_END']);

/**
 * A driving reading: ignition on and the message closes an interval spent driving
 * (not the ignition-on, trip-start or ignition-off messages, whose engine is cold or cooling).
 * Coolant baselines and incidents use driving readings only (amended before 1b).
 */
export function isDrivingReading(e: SimEvent): boolean {
  return e.ignition && DRIVING_EVENTS.has(e.evt);
}

/** First driving reading at or above the hard limit, if the van were never repaired. */
export function computeLimitTs(
  reg: Registry,
  params: SimParams,
  scenario: Scenario,
  vin: string,
  horizonMs: number,
): number | null {
  const p = scenario.plants.get(vin);
  if (!p?.drift) return null;
  const v = reg.vehicles.find((x) => x.vin === vin)!;
  const ctx = makeWorldContext(reg, params, scenario);
  const s = new VehicleStream(v, ctx, p.drift.onsetMs);
  for (let e = s.next(); e.eventTs < horizonMs; e = s.next()) {
    if (isDrivingReading(e) && e.coolantC !== null && e.coolantC >= params.coolant.hardLimitC && e.coolantC < 135) {
      return e.eventTs;
    }
  }
  return null;
}

export function buildGroundTruth(
  reg: Registry,
  params: SimParams,
  scenario: Scenario,
  horizonMs = reg.t0Ms + 7 * DAY_MS,
): GroundTruthRow[] {
  const regionOf = new Map(reg.depots.map((d) => [d.id, d.regionId]));
  return reg.vehicles.map((v) => {
    const p = scenario.plants.get(v.vin);
    return {
      vin: v.vin,
      scenarioId: p?.scenarioId ?? null,
      role: roleOf(v, scenario, (id) => regionOf.get(id)!),
      faultFamily: p?.faultFamily ?? null,
      onsetTs: p?.drift?.onsetMs ?? null,
      late: p?.late ?? false,
      limitTs: p?.drift ? computeLimitTs(reg, params, scenario, v.vin, horizonMs) : null,
      expectedCampaign: p?.expectedCampaign ?? null,
      repairOutcome: null,
    };
  });
}
