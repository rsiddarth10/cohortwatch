/** Tunable model parameters (defaults follow brief §5.1-§5.8). Overridable from config/simulator.yaml. */
export interface SimParams {
  /** Days of history before T0 (world starts here; seq counts from here). */
  historyDays: number;
  /** Vehicle-day boundary, hour UTC. All shifts end before the next boundary. */
  dayStartHourUtc: number;
  /** Periodic reading cadence while the ignition is on (sim-minutes). */
  cadenceMin: number;
  /** Heartbeat cadence while parked (sim-hours). */
  heartbeatH: number;
  /** Background fault codes per vehicle-day (Poisson). */
  dtcPerVehicleDay: number;
  /** Share of diesel vans that run naturally hot (+6..+8 C, healthy and stable). */
  naturallyHotShare: number;
  /** EV depot charging rate, % SoC per hour. */
  chargeRatePctPerH: number;
  coolant: {
    baseC: number;
    /** Healthy personal offset sd (amended before 1b: 1.5 C). */
    offsetSdC: number;
    warmupTauMin: number;
    cooldownTauMin: number;
    noiseSdC: number;
    /** Degrees added per unit of duty load factor. */
    dutyLoadC: number;
    ambientCoef: number;
    hotAmbientCoef: number;
    hotAmbientThresholdC: number;
    /** Hard limit used for limit_ts (brief §5.4). */
    hardLimitC: number;
  };
  /** Simple global thresholds, used only by checks #10/#11 and the S9 baseline. Detection never uses them. */
  globalCoolantThresholdC: number;
  globalBattTempThresholdC: number;
  /** Vehicles per depot target: depots = N / vansPerDepot (brief: ~N/250). */
  vansPerDepot: number;
  /** Reserved depot cohorts (brief §5.1). */
  s1CohortSize: number;
  s1OtherModelSize: number;
  s1bCohortSize: number;
}

export const DEFAULT_PARAMS: SimParams = {
  historyDays: 7,
  dayStartHourUtc: 4,
  cadenceMin: 30,
  heartbeatH: 4,
  dtcPerVehicleDay: 0.02,
  naturallyHotShare: 0.02,
  chargeRatePctPerH: 15,
  coolant: {
    baseC: 88,
    offsetSdC: 1.5,
    warmupTauMin: 6,
    cooldownTauMin: 40,
    noiseSdC: 0.8,
    dutyLoadC: 2,
    ambientCoef: 0.15,
    hotAmbientCoef: 0.4,
    hotAmbientThresholdC: 35,
    hardLimitC: 110,
  },
  globalCoolantThresholdC: 97,
  globalBattTempThresholdC: 47,
  vansPerDepot: 250,
  s1CohortSize: 60,
  s1OtherModelSize: 10,
  s1bCohortSize: 30,
};

export function withParams(overrides: Partial<SimParams> = {}): SimParams {
  return {
    ...DEFAULT_PARAMS,
    ...overrides,
    coolant: { ...DEFAULT_PARAMS.coolant, ...(overrides.coolant ?? {}) },
  };
}
