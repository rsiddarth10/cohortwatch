import {
  FAULT_CODES,
  REGIONS,
  S1_MODEL_CODE,
  S1_OTHER_MODEL_CODE,
  dutyById,
  familiesFor,
  modelById,
  regionById,
  type FaultFamily,
} from './catalog.js';
import type { SimParams } from './params.js';
import type { Registry, Vehicle } from './registry.js';
import { Rng } from './rng.js';
import type { ScenarioHooks } from './simulate.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';

/**
 * Planted scenarios (brief §5.4). A pure function of (registry, seed, options): every worker builds the
 * same Scenario and applies it inside the vehicle-day generator through ScenarioHooks.
 * Simulator-private: nothing here may ever reach detection code (see CLAUDE.md "No leaks").
 */

export type GroundTruthRole =
  | 's1_sister'
  | 's1_late_sister'
  | 's1_healthy_cohort'
  | 's1b_sister'
  | 'runaway'
  | 'decoy_scattered'
  | 'decoy_same_depot_other_model'
  | 'heatwave_region'
  | 'loud_stable'
  | 'naturally_hot'
  | 'sensor_glitch'
  | 'bad_repair'
  | 'background';

export interface Drift {
  kind: 'linear' | 'quadratic';
  /** Linear: starts at onset, +ratePerH per sim-hour. Quadratic: quadA * hours^2 from onset. */
  onsetMs: number;
  ratePerH: number;
  quadA: number;
  /** Drift target reached at ~T0+42h for sisters (+8..+12 C), recorded for the manifest. */
  targetC: number;
}

export interface PlantVan {
  vin: string;
  role: GroundTruthRole;
  scenarioId: string;
  faultFamily: FaultFamily | null;
  late: boolean;
  expectedCampaign: string | null;
  drift: Drift | null;
  badRepair: boolean;
  /** Sim-day index with gentle driving (behaviour clue only). */
  gentleDay: number | null;
  /** Sim-day index with one impossible 25 -> 140 -> 25 C coolant spike. */
  glitchDay: number | null;
  loudCodesPerDay: number | null;
}

export interface FirmwarePlant {
  modelId: number;
  version: string;
  releaseId: number;
  releasedAtMs: number;
  installs: { vin: string; installedAtMs: number }[];
  s1SistersUpdated: number;
  s1HealthyUpdated: number;
}

export interface Transfer {
  vin: string;
  fromDepotId: number;
  toDepotId: number;
  atMs: number;
}

export interface ScenarioOptions {
  plants: boolean;
  depotTransfer: boolean;
}

export interface Scenario extends ScenarioHooks {
  enabled: boolean;
  t0Ms: number;
  /** Mess: OEM-A switches from v1 (°F) to v2 (°C) for events at/after this time. */
  aurexV2FromMs: number;
  /** Demo surge: driving cadence drops to `cadenceMin` inside [fromMs, toMs). */
  surge: { fromMs: number; toMs: number; cadenceMin: number };
  scenarioEndMs: number;
  autoRepairAtMs: number;
  heatwave: { regionId: number; fromMs: number; toMs: number; deltaC: number } | null;
  plants: Map<string, PlantVan>;
  runaway: { vin: string; driveFromMs: number; driveToMs: number } | null;
  firmware: FirmwarePlant | null;
  transfers: Transfer[];
  s1: { depotId: number; s1bDepotId: number; sisters: string[]; lateSisters: string[]; healthy: string[] };
  params: SimParams;
}

const REPAIR_TAU_MS = 40 * MINUTE_MS; // back inside the normal band within ~2 sim-hours
const RAMP_MS = 2 * HOUR_MS;

function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function plant(vin: string, role: GroundTruthRole, scenarioId: string, extra: Partial<PlantVan> = {}): PlantVan {
  return {
    vin,
    role,
    scenarioId,
    faultFamily: null,
    late: false,
    expectedCampaign: null,
    drift: null,
    badRepair: false,
    gentleDay: null,
    glitchDay: null,
    loudCodesPerDay: null,
    ...extra,
  };
}

/** Rough own-normal coolant for a van (used to size the runaway's quadratic). */
function expectedNormalC(v: Vehicle, reg: Registry, params: SimParams): number {
  const depot = reg.depots.find((d) => d.id === v.homeDepotId)!;
  const region = regionById(depot.regionId);
  const c = params.coolant;
  const duty = dutyById(v.dutyId);
  return (
    c.baseC +
    v.profile.coolantOffsetC +
    duty.load * c.dutyLoadC +
    c.ambientCoef * (region.ambientMeanC - 25) +
    c.hotAmbientCoef * Math.max(0, region.ambientMeanC - c.hotAmbientThresholdC)
  );
}

export function buildScenario(reg: Registry, params: SimParams, opts: ScenarioOptions): Scenario {
  const t0 = reg.t0Ms;
  const rng = Rng.of(reg.seed, 'scenario', reg.n);
  const plants = new Map<string, PlantVan>();
  const taken = new Set<string>();
  const depotOf = new Map(reg.depots.map((d) => [d.id, d]));
  const regionOfVan = (v: Vehicle) => depotOf.get(v.homeDepotId)!.regionId;
  const code = (v: Vehicle) => modelById(v.modelId).code;
  const dutyCode = (v: Vehicle) => dutyById(v.dutyId).code;
  const t0Day = Math.floor((t0 - reg.epochMs) / DAY_MS);

  const s1DepotId = reg.reserved.s1DepotId;
  const s1bDepotId = reg.reserved.s1bDepotId;
  const s1Region = depotOf.get(s1DepotId)!.regionId;
  const s1bRegion = depotOf.get(s1bDepotId)!.regionId;
  const cohort = (depotId: number) =>
    reg.vehicles.filter((v) => v.homeDepotId === depotId && code(v) === S1_MODEL_CODE && dutyCode(v) === 'URBAN');

  const linearDrift = (onsetMs: number, targetC: number): Drift => ({
    kind: 'linear',
    onsetMs,
    ratePerH: targetC / 36, // +target by ~36 h after onset (T0+42h for main sisters), continues if untreated
    quadA: 0,
    targetC,
  });

  // --- S1 outbreak: 15 main + 3 late sisters among the reserved cohort --------------------------
  const s1Cohort = shuffle(cohort(s1DepotId), rng);
  const s1Candidates = s1Cohort.filter((v) => !v.profile.naturallyHot);
  const sisters = s1Candidates.slice(0, 18);
  const main = sisters.slice(0, 15);
  const late = sisters.slice(15, 18);
  const healthy = s1Cohort.filter((v) => !sisters.includes(v));
  const badRepair = main[rng.int(0, main.length - 1)]!;
  const others = main.filter((v) => v !== badRepair);
  const gentle = shuffle(others, rng).slice(0, 2);
  const s1Transfers = opts.depotTransfer
    ? shuffle(
        others.filter((v) => !gentle.includes(v)),
        rng,
      ).slice(0, 2)
    : [];

  for (const v of main) {
    const onset = t0 + 6 * HOUR_MS + Math.round(rng.uniform(0, 60) * MINUTE_MS);
    plants.set(
      v.vin,
      plant(v.vin, v === badRepair ? 'bad_repair' : 's1_sister', 'S1', {
        faultFamily: 'COOLING',
        expectedCampaign: 'S1',
        drift: linearDrift(onset, rng.uniform(8, 12)),
        badRepair: v === badRepair,
        gentleDay: gentle.includes(v) ? t0Day + 1 : null,
      }),
    );
  }
  for (const v of late) {
    const onset = t0 + 24 * HOUR_MS + Math.round(rng.uniform(0, 60) * MINUTE_MS);
    plants.set(
      v.vin,
      plant(v.vin, 's1_late_sister', 'S1', {
        faultFamily: 'COOLING',
        late: true,
        expectedCampaign: 'S1',
        drift: linearDrift(onset, rng.uniform(8, 12)),
      }),
    );
  }
  for (const v of healthy) plants.set(v.vin, plant(v.vin, 's1_healthy_cohort', 'S1'));
  sisters.forEach((v) => taken.add(v.vin));
  healthy.forEach((v) => taken.add(v.vin));

  // --- S1b: 8 sisters at the other reserved depot (different region), onset T0+18h ---------------
  const s1bCohort = shuffle(cohort(s1bDepotId), rng).filter((v) => !v.profile.naturallyHot);
  for (const v of s1bCohort.slice(0, 8)) {
    const onset = t0 + 18 * HOUR_MS + Math.round(rng.uniform(0, 60) * MINUTE_MS);
    plants.set(
      v.vin,
      plant(v.vin, 's1b_sister', 'S1b', {
        faultFamily: 'COOLING',
        expectedCampaign: 'S1b',
        drift: linearDrift(onset, rng.uniform(8, 12)),
      }),
    );
    taken.add(v.vin);
  }

  // --- Heatwave region: hot-humid, not containing S1/S1b -----------------------------------------
  const hwRegion =
    REGIONS.find((r) => r.climate === 'HOT_HUMID' && r.id !== s1Region && r.id !== s1bRegion) ??
    REGIONS.find((r) => r.id !== s1Region && r.id !== s1bRegion)!;
  const heatwave = { regionId: hwRegion.id, fromMs: t0 + 12 * HOUR_MS, toMs: t0 + 60 * HOUR_MS, deltaC: 10 };

  const free = (v: Vehicle) =>
    !taken.has(v.vin) &&
    !v.profile.naturallyHot &&
    v.homeDepotId !== s1DepotId &&
    v.homeDepotId !== s1bDepotId &&
    regionOfVan(v) !== hwRegion.id;
  const pool = shuffle(reg.vehicles, rng);

  // --- Runaway: OEM-A diesel on linehaul, different model/depot ----------------------------------
  const runawayVan = pool.find((v) => free(v) && code(v) === 'AX-D1' && dutyCode(v) === 'LINEHAUL')!;
  const driveFromMs = t0 + 10 * HOUR_MS;
  const limitAtMs = t0 + 34 * HOUR_MS;
  const runaway = { vin: runawayVan.vin, driveFromMs, driveToMs: t0 + 36 * HOUR_MS };
  const rise = params.coolant.hardLimitC - expectedNormalC(runawayVan, reg, params);
  const hours = (limitAtMs - driveFromMs) / HOUR_MS;
  plants.set(
    runawayVan.vin,
    plant(runawayVan.vin, 'runaway', 'RUNAWAY', {
      faultFamily: 'COOLING',
      drift: { kind: 'quadratic', onsetMs: driveFromMs, ratePerH: 0, quadA: rise / (hours * hours), targetC: rise },
    }),
  );
  taken.add(runawayVan.vin);

  // --- Scattered decoys: 6 diesel vans, 6 different depots, none on the S1 key --------------------
  const decoyDepots = new Set<number>();
  const decoyDuties: string[] = [];
  for (const v of pool) {
    if (decoyDepots.size >= 6) break;
    if (!free(v) || modelById(v.modelId).powertrain !== 'DIESEL') continue;
    if (code(v) === S1_MODEL_CODE && dutyCode(v) === 'URBAN') continue;
    if (decoyDepots.has(v.homeDepotId)) continue;
    // spread over duties: at most 2 per duty
    if (decoyDuties.filter((d) => d === dutyCode(v)).length >= 2) continue;
    decoyDepots.add(v.homeDepotId);
    decoyDuties.push(dutyCode(v));
    const onset = t0 + Math.round(rng.uniform(6, 40) * HOUR_MS);
    plants.set(
      v.vin,
      plant(v.vin, 'decoy_scattered', 'DECOY_SCATTERED', {
        faultFamily: 'COOLING',
        drift: linearDrift(onset, rng.uniform(8, 12)),
      }),
    );
    taken.add(v.vin);
  }

  // --- Same depot (S1), other diesel model: 2 decoys ---------------------------------------------
  const otherModel = shuffle(
    reg.vehicles.filter(
      (v) =>
        v.homeDepotId === s1DepotId &&
        code(v) === S1_OTHER_MODEL_CODE &&
        dutyCode(v) === 'URBAN' &&
        !v.profile.naturallyHot,
    ),
    rng,
  ).slice(0, 2);
  for (const v of otherModel) {
    const onset = t0 + Math.round(rng.uniform(8, 30) * HOUR_MS);
    plants.set(
      v.vin,
      plant(v.vin, 'decoy_same_depot_other_model', 'DECOY_SAME_DEPOT', {
        faultFamily: 'COOLING',
        drift: linearDrift(onset, rng.uniform(8, 12)),
      }),
    );
    taken.add(v.vin);
  }

  // --- Loud-but-stable: 20 vans, 10-40 mixed codes/day, flat signals -----------------------------
  let loud = 0;
  for (const v of pool) {
    if (loud >= 20) break;
    if (!free(v)) continue;
    plants.set(v.vin, plant(v.vin, 'loud_stable', 'LOUD_STABLE', { loudCodesPerDay: rng.uniform(10, 40) }));
    taken.add(v.vin);
    loud++;
  }

  // --- Sensor glitch: 3 engine vans, one impossible spike each ------------------------------------
  let glitches = 0;
  for (const v of pool) {
    if (glitches >= 3) break;
    if (!free(v) || modelById(v.modelId).powertrain === 'EV' || dutyCode(v) === 'RENTAL') continue;
    plants.set(v.vin, plant(v.vin, 'sensor_glitch', 'SENSOR_GLITCH', { glitchDay: t0Day + 1 + (glitches % 2) }));
    taken.add(v.vin);
    glitches++;
  }

  // --- Firmware 4.2.1 rollout for the S1 model over T0-48h..T0 -----------------------------------
  const s1Model = reg.vehicles.find((v) => code(v) === S1_MODEL_CODE)!.modelId;
  const rolloutFrom = t0 - 48 * HOUR_MS;
  const installAt = () => rolloutFrom + Math.round(rng.uniform(0, 48 * HOUR_MS - MINUTE_MS));
  const installs: { vin: string; installedAtMs: number }[] = [];
  const updatedSisters = new Set(
    shuffle(sisters, rng)
      .slice(0, 16)
      .map((v) => v.vin),
  );
  const updatedHealthy = new Set(
    shuffle(healthy, rng)
      .slice(0, 20)
      .map((v) => v.vin),
  );
  for (const v of reg.vehicles) {
    if (v.modelId !== s1Model) continue;
    const inS1 = sisters.includes(v) || healthy.includes(v);
    const update = inS1 ? updatedSisters.has(v.vin) || updatedHealthy.has(v.vin) : rng.chance(0.5);
    if (update) installs.push({ vin: v.vin, installedAtMs: installAt() });
  }
  const firmware: FirmwarePlant = {
    modelId: s1Model,
    version: '4.2.1',
    releaseId: Math.max(...reg.firmwareReleases.map((r) => r.id)) + 1,
    releasedAtMs: rolloutFrom,
    installs,
    s1SistersUpdated: updatedSisters.size,
    s1HealthyUpdated: updatedHealthy.size,
  };

  const transfers: Transfer[] = s1Transfers.map((v) => ({
    vin: v.vin,
    fromDepotId: s1DepotId,
    toDepotId: reg.depots.find((d) => d.regionId === s1Region && d.id !== s1DepotId)?.id ?? s1bDepotId,
    atMs: t0 + 30 * HOUR_MS,
  }));

  const enabled = opts.plants;
  const scenario: Scenario = {
    enabled,
    t0Ms: t0,
    aurexV2FromMs: t0 + 12 * HOUR_MS,
    surge: { fromMs: t0 + 24 * HOUR_MS, toMs: t0 + 42 * HOUR_MS, cadenceMin: 10 },
    scenarioEndMs: t0 + 72 * HOUR_MS,
    autoRepairAtMs: t0 + 30 * HOUR_MS,
    heatwave: enabled ? heatwave : null,
    plants: enabled ? plants : new Map(),
    runaway: enabled ? runaway : null,
    firmware: enabled ? firmware : null,
    transfers: enabled ? transfers : [],
    s1: {
      depotId: s1DepotId,
      s1bDepotId,
      sisters: sisters.map((v) => v.vin),
      lateSisters: late.map((v) => v.vin),
      healthy: healthy.map((v) => v.vin),
    },
    params,
    ...hooks(),
  };
  return scenario;

  function hooks(): ScenarioHooks {
    return {
      ambientDeltaC(regionId, t) {
        if (!scenario.heatwave || regionId !== scenario.heatwave.regionId) return 0;
        const { fromMs, toMs, deltaC } = scenario.heatwave;
        if (t <= fromMs || t >= toMs) return 0;
        const up = Math.min(1, (t - fromMs) / RAMP_MS);
        const down = Math.min(1, (toMs - t) / RAMP_MS);
        return deltaC * Math.min(up, down);
      },
      cadenceMs(t, baseMs) {
        return t >= scenario.surge.fromMs && t < scenario.surge.toMs ? scenario.surge.cadenceMin * MINUTE_MS : baseMs;
      },
      overrideWindows(v, day, dayStart, windows) {
        const r = scenario.runaway;
        if (!r || v.vin !== r.vin) return windows;
        const dayEnd = dayStart + DAY_MS;
        if (dayEnd <= r.driveFromMs || dayStart >= r.driveToMs) return windows;
        // Team-driven run: continuous driving, split only by a 2-minute driver swap at the day boundary.
        const kept = windows.filter((w) => w.offMs <= r.driveFromMs - 30 * MINUTE_MS && w.onMs >= dayStart);
        const on = Math.max(dayStart + MINUTE_MS, r.driveFromMs);
        const off = Math.min(dayEnd - MINUTE_MS, r.driveToMs);
        if (off - on > 10 * MINUTE_MS) kept.push({ onMs: on, offMs: off, endsAtDepot: off === r.driveToMs });
        return kept;
      },
      coolantDeltaC(vin, t, repairAtMs) {
        return driftDelta(scenario.plants.get(vin), t, repairAtMs);
      },
      extraDtc(v, w, repairAtMs) {
        const p = scenario.plants.get(v.vin);
        if (!p || (!p.drift && !p.loudCodesPerDay)) return [];
        const out: { t: number; codes: string[] }[] = [];
        const pt = modelById(v.modelId).powertrain;
        const activeH = dutyById(v.dutyId).activeH ?? 4;
        // Independent RNG per (VIN, hour): a repair only changes hours after it.
        for (let h = Math.floor(w.onMs / HOUR_MS); h * HOUR_MS < w.offMs; h++) {
          // Plants start at T0: nothing before it (history stays plant-free).
          const from = Math.max(w.onMs + 2 * MINUTE_MS, h * HOUR_MS, scenario.t0Ms);
          const to = Math.min(w.offMs - 2 * MINUTE_MS, (h + 1) * HOUR_MS);
          if (to <= from) continue;
          // Rate at the slot start: a repair at time r changes only slots starting after r,
          // so everything already emitted is regenerated identically.
          const r = Rng.of(reg.seed, v.vin, 'plant-dtc', h);
          let lambda = 0;
          let family: FaultFamily | null = null;
          if (p.drift) {
            const x = Math.min(1.5, driftDelta(p, h * HOUR_MS, repairAtMs) / 10);
            lambda = 0.5 * x * x;
            family = p.faultFamily;
          } else if (p.loudCodesPerDay) {
            lambda = p.loudCodesPerDay / activeH;
          }
          const n = r.poisson((lambda * (to - from)) / HOUR_MS);
          for (let k = 0; k < n; k++) {
            const fam = family ?? r.pick(familiesFor(pt));
            out.push({ t: Math.round(r.uniform(from, to)), codes: [r.pick(FAULT_CODES[fam])] });
          }
        }
        return out;
      },
      styleFactor(vin, day) {
        return scenario.plants.get(vin)?.gentleDay === day ? 0.5 : 1;
      },
      glitchDay(vin) {
        return scenario.plants.get(vin)?.glitchDay ?? null;
      },
      homeDepotId(v, t) {
        for (const tr of scenario.transfers) if (tr.vin === v.vin && t >= tr.atMs) return tr.toDepotId;
        return v.homeDepotId;
      },
    };
  }
}

/** Coolant added by a plant at sim time t, honouring a repair (the bad repair keeps drifting). */
export function driftDelta(p: PlantVan | undefined, t: number, repairAtMs?: number): number {
  if (!p?.drift) return 0;
  const d = p.drift;
  const raw = (x: number) => {
    const h = Math.max(0, (x - d.onsetMs) / HOUR_MS);
    return d.kind === 'linear' ? d.ratePerH * h : d.quadA * h * h;
  };
  if (repairAtMs !== undefined && t > repairAtMs && !p.badRepair) {
    return raw(repairAtMs) * Math.exp(-(t - repairAtMs) / REPAIR_TAU_MS);
  }
  return raw(t);
}

/**
 * Add the 4.2.1 rollout to the in-memory registry (idempotent). The DB rows are written by the simulator;
 * the stream must carry the same firmware field, so every worker applies this too.
 */
export function applyFirmwarePlant(reg: Registry, s: Scenario): void {
  const f = s.firmware;
  if (!f || reg.firmwareReleases.some((r) => r.id === f.releaseId)) return;
  reg.firmwareReleases.push({ id: f.releaseId, modelId: f.modelId, version: f.version, releasedAtMs: f.releasedAtMs });
  const byVin = new Map(reg.vehicles.map((v) => [v.vin, v]));
  for (const i of f.installs) {
    const v = byVin.get(i.vin)!;
    v.firmware.push({ releaseId: f.releaseId, version: f.version, installedAtMs: i.installedAtMs });
    v.firmware.sort((a, b) => a.installedAtMs - b.installedAtMs);
  }
}

/** Ground-truth role for every vehicle (plants first, then naturally hot, heatwave region, background). */
export function roleOf(v: Vehicle, s: Scenario, regionOf: (depotId: number) => number): GroundTruthRole {
  const p = s.plants.get(v.vin);
  if (p) return p.role;
  if (v.profile.naturallyHot) return 'naturally_hot';
  if (s.heatwave && regionOf(v.homeDepotId) === s.heatwave.regionId) return 'heatwave_region';
  return 'background';
}
