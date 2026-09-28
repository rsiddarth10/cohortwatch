import {
  DUTIES,
  MODELS,
  REGIONS,
  S1_MODEL_CODE,
  S1_OTHER_MODEL_CODE,
  type DutyCode,
  type Powertrain,
  type VehicleModel,
  modelById,
  oemById,
} from './catalog.js';
import { geohashEncode } from './geohash.js';
import type { SimParams } from './params.js';
import { Rng, clamp, hashSeed } from './rng.js';
import { DAY_MS, worldEpochMs } from './time.js';
import { buildVin } from './vin.js';

export interface Tenant {
  id: number;
  code: string;
  name: string;
  share: number;
}
export interface Subscription {
  id: number;
  tenantId: number;
  plan: 'ENTERPRISE' | 'GROWTH';
  validFromMs: number;
  validToMs: number;
}
export interface Fleet {
  id: number;
  tenantId: number;
  name: string;
}
export interface Depot {
  id: number;
  code: string;
  fleetId: number;
  tenantId: number;
  regionId: number;
  lat: number;
  lon: number;
  geohash5: string;
  sizeClass: 'S' | 'M' | 'L' | 'XL';
  vehicleCount: number;
}
export interface WorkshopBay {
  id: number;
  depotId: number;
  bayNo: number;
  capability: 'EV' | 'ICE' | 'ANY';
}
export interface FirmwareRelease {
  id: number;
  modelId: number;
  version: string;
  releasedAtMs: number;
}
export interface FirmwareInstall {
  releaseId: number;
  version: string;
  installedAtMs: number;
}
/** Hidden per-vehicle profile (sim.vehicle_profile only; never visible to detection). */
export interface VehicleProfile {
  coolantOffsetC: number;
  battTempOffsetC: number;
  lvOffsetV: number;
  efficiency: number;
  style: number;
  naturallyHot: boolean;
  odoBaseKm: number;
  initialSocPct: number;
  initialFuelPct: number;
}
export interface Vehicle {
  index: number;
  vin: string;
  tenantId: number;
  fleetId: number;
  oemId: number;
  modelId: number;
  dutyId: number;
  homeDepotId: number;
  modelYear: number;
  registeredAtMs: number;
  firmware: FirmwareInstall[];
  profile: VehicleProfile;
}
export interface Driver {
  id: number;
  fleetId: number;
  pseudonym: string;
}
export interface DriverAssignment {
  driverId: number;
  vin: string;
  validFromMs: number;
  validToMs: number | null;
}
export interface Registry {
  seed: string;
  n: number;
  t0Ms: number;
  epochMs: number;
  tenants: Tenant[];
  subscriptions: Subscription[];
  fleets: Fleet[];
  depots: Depot[];
  bays: WorkshopBay[];
  firmwareReleases: FirmwareRelease[];
  vehicles: Vehicle[];
  drivers: Driver[];
  driverAssignments: DriverAssignment[];
  reserved: { s1DepotId: number; s1bDepotId: number };
}

export const TENANTS: readonly Tenant[] = [
  { id: 1, code: 'TEN-A', name: 'Aldermoor Freight', share: 0.7 },
  { id: 2, code: 'TEN-B', name: 'Brightwater Rentals', share: 0.3 },
];

const FLEETS: readonly Fleet[] = [
  { id: 1, tenantId: 1, name: 'Aldermoor North' },
  { id: 2, tenantId: 1, name: 'Aldermoor South' },
  { id: 3, tenantId: 1, name: 'Aldermoor Linehaul' },
  { id: 4, tenantId: 1, name: 'Aldermoor Services' },
  { id: 5, tenantId: 2, name: 'Brightwater City' },
  { id: 6, tenantId: 2, name: 'Brightwater Regional' },
];

export const MIN_FLEET_SIZE = 500;

/** Depot index (0-based) reserved for S1 (region R1, hot-dry) and S1b (region R5, temperate). */
const S1_DEPOT_INDEX = 0;
const S1B_DEPOT_INDEX = 4;

/** Powertrain mix for non-linehaul duties so the whole fleet lands on 55% EV / 35% diesel / 10% hybrid. */
function powertrainFor(duty: DutyCode, rng: Rng): Powertrain {
  if (duty === 'LINEHAUL') return rng.weighted<Powertrain>(['DIESEL', 'HYBRID'], [0.8, 0.2]);
  return rng.weighted<Powertrain>(['EV', 'DIESEL', 'HYBRID'], [0.6875, 0.2375, 0.075]);
}

function modelFor(pt: Powertrain, rng: Rng): VehicleModel {
  const candidates = MODELS.filter((m) => m.powertrain === pt);
  return rng.pick(candidates);
}

function modelByCode(code: string): VehicleModel {
  const m = MODELS.find((x) => x.code === code);
  if (!m) throw new Error(`unknown model code ${code}`);
  return m;
}

function sizeClass(count: number): Depot['sizeClass'] {
  if (count < 150) return 'S';
  if (count <= 300) return 'M';
  if (count <= 500) return 'L';
  return 'XL';
}

function makeProfile(seed: string, vin: string, model: VehicleModel, params: SimParams): VehicleProfile {
  const r = Rng.of(seed, vin, 'profile');
  const naturallyHot = model.powertrain === 'DIESEL' && r.chance(params.naturallyHotShare);
  let coolantOffsetC = r.normal(0, params.coolant.offsetSdC);
  if (naturallyHot) coolantOffsetC = Math.abs(coolantOffsetC) * 0.25 + r.uniform(6, 8);
  return {
    coolantOffsetC,
    battTempOffsetC: r.normal(0, 1.5),
    lvOffsetV: r.normal(0, 0.05),
    efficiency: clamp(r.normal(1, 0.06), 0.85, 1.2),
    style: clamp(Math.exp(r.normal(0, 0.2)), 0.6, 1.6),
    naturallyHot,
    odoBaseKm: r.uniform(2_000, 120_000),
    initialSocPct: r.uniform(70, 100),
    initialFuelPct: r.uniform(55, 100),
  };
}

/**
 * Generate the whole registry as a pure function of (seed, N, T0, params).
 * Every worker can regenerate it and slice its own VIN range, so no database read is needed
 * and output is identical for any number of workers.
 */
export function generateRegistry(seed: string, n: number, t0Ms: number, params: SimParams): Registry {
  if (!Number.isInteger(n) || n < MIN_FLEET_SIZE) throw new Error(`SIM_SCALE must be an integer >= ${MIN_FLEET_SIZE}`);
  const rng = Rng.of(seed, 'registry', n);
  const epochMs = worldEpochMs(t0Ms, params.historyDays, params.dayStartHourUtc);

  // --- depots -------------------------------------------------------------------------------
  const depotCount = Math.max(10, Math.round(n / params.vansPerDepot));
  const tenantACount = Math.round(depotCount * TENANTS[0]!.share);
  // Shuffle depot indices, first tenantACount go to tenant A; reserved depots are always tenant A.
  const order = Array.from({ length: depotCount }, (_, i) => i).filter(
    (i) => i !== S1_DEPOT_INDEX && i !== S1B_DEPOT_INDEX,
  );
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const tenantOf = new Map<number, number>([
    [S1_DEPOT_INDEX, 1],
    [S1B_DEPOT_INDEX, 1],
  ]);
  order.forEach((idx, k) => tenantOf.set(idx, k < tenantACount - 2 ? 1 : 2));

  const depots: Depot[] = [];
  for (let i = 0; i < depotCount; i++) {
    const region = REGIONS[i % REGIONS.length]!;
    const tenantId = tenantOf.get(i)!;
    const fleets = FLEETS.filter((f) => f.tenantId === tenantId);
    const fleetId = i === S1_DEPOT_INDEX || i === S1B_DEPOT_INDEX ? 1 : rng.pick(fleets).id;
    const lat = region.lat + rng.uniform(-1.5, 1.5);
    const lon = region.lon + rng.uniform(-1.5, 1.5);
    depots.push({
      id: i + 1,
      code: `D-${String(i + 1).padStart(3, '0')}`,
      fleetId,
      tenantId,
      regionId: region.id,
      lat,
      lon,
      geohash5: geohashEncode(lat, lon, 5),
      sizeClass: 'M',
      vehicleCount: 0,
    });
  }
  const s1 = depots[S1_DEPOT_INDEX]!;
  const s1b = depots[S1B_DEPOT_INDEX]!;
  const reservedIds = new Set([s1.id, s1b.id]);

  // --- vehicle skeletons (model, duty, depot) ------------------------------------------------
  interface Skeleton {
    model: VehicleModel;
    duty: DutyCode;
    depot: Depot;
  }
  const skeletons: Skeleton[] = [];
  const s1Model = modelByCode(S1_MODEL_CODE);
  const s1Other = modelByCode(S1_OTHER_MODEL_CODE);
  for (let i = 0; i < params.s1CohortSize; i++) skeletons.push({ model: s1Model, duty: 'URBAN', depot: s1 });
  for (let i = 0; i < params.s1OtherModelSize; i++) skeletons.push({ model: s1Other, duty: 'URBAN', depot: s1 });
  for (let i = 0; i < params.s1bCohortSize; i++) skeletons.push({ model: s1Model, duty: 'URBAN', depot: s1b });

  const dutyCodes = DUTIES.map((d) => d.code);
  const dutyShares = DUTIES.map((d) => d.share);
  while (skeletons.length < n) {
    const duty = rng.weighted(dutyCodes, dutyShares);
    const model = modelFor(powertrainFor(duty, rng), rng);
    let depot = depots[rng.int(0, depotCount - 1)]!;
    // Keep the reserved S1/S1b cohorts at their exact configured size.
    while (reservedIds.has(depot.id) && model.code === S1_MODEL_CODE && duty === 'URBAN') {
      depot = depots[rng.int(0, depotCount - 1)]!;
    }
    skeletons.push({ model, duty, depot });
  }

  // --- firmware releases ----------------------------------------------------------------------
  const firmwareReleases: FirmwareRelease[] = [];
  const releaseAges = [330, 160, 50];
  for (const m of MODELS) {
    m.firmware.forEach((version, k) => {
      firmwareReleases.push({
        id: firmwareReleases.length + 1,
        modelId: m.id,
        version,
        releasedAtMs: epochMs - (releaseAges[k]! + rng.int(0, 20)) * DAY_MS,
      });
    });
  }

  // --- vehicles -------------------------------------------------------------------------------
  const serials = new Map<number, number>();
  const vehicles: Vehicle[] = [];
  const drivers: Driver[] = [];
  const driverAssignments: DriverAssignment[] = [];
  const latestInstallCutoff = epochMs - DAY_MS;

  skeletons.forEach((sk, index) => {
    const oem = oemById(sk.model.oemId);
    const registeredAtMs = epochMs - Math.round(rng.uniform(60, 1400)) * DAY_MS - rng.int(0, 86_399) * 1000;
    const modelYear = clamp(new Date(registeredAtMs).getUTCFullYear(), 2021, 2026);
    const serial = (serials.get(oem.id) ?? 0) + 1;
    serials.set(oem.id, serial);
    const vin = buildVin(oem.wmi, sk.model.vds, modelYear, oem.plant, 100_000 + serial);

    const releases = firmwareReleases.filter((r) => r.modelId === sk.model.id);
    const firmware: FirmwareInstall[] = [];
    const baseline = [...releases].reverse().find((r) => r.releasedAtMs <= registeredAtMs) ?? releases[0]!;
    firmware.push({ releaseId: baseline.id, version: baseline.version, installedAtMs: registeredAtMs });
    for (const r of releases) {
      if (r.releasedAtMs <= registeredAtMs || r.id === baseline.id) continue;
      const installedAtMs = r.releasedAtMs + rng.int(1, 35) * DAY_MS + rng.int(0, 86_399) * 1000;
      if (installedAtMs > latestInstallCutoff) break; // stays on the older version for now
      firmware.push({ releaseId: r.id, version: r.version, installedAtMs });
    }

    // Pseudonymous drivers: a current one and sometimes a previous one.
    const currentFrom = Math.max(registeredAtMs, epochMs - rng.int(20, 400) * DAY_MS);
    const current: Driver = { id: drivers.length + 1, fleetId: sk.depot.fleetId, pseudonym: '' };
    current.pseudonym = pseudonym(seed, current.id);
    drivers.push(current);
    if (rng.chance(0.3) && currentFrom - registeredAtMs > 30 * DAY_MS) {
      const prev: Driver = { id: drivers.length + 1, fleetId: sk.depot.fleetId, pseudonym: '' };
      prev.pseudonym = pseudonym(seed, prev.id);
      drivers.push(prev);
      const prevFrom = Math.max(registeredAtMs, currentFrom - rng.int(60, 500) * DAY_MS);
      driverAssignments.push({ driverId: prev.id, vin, validFromMs: prevFrom, validToMs: currentFrom });
    }
    driverAssignments.push({ driverId: current.id, vin, validFromMs: currentFrom, validToMs: null });

    sk.depot.vehicleCount++;
    vehicles.push({
      index,
      vin,
      tenantId: sk.depot.tenantId,
      fleetId: sk.depot.fleetId,
      oemId: oem.id,
      modelId: sk.model.id,
      dutyId: DUTIES.find((d) => d.code === sk.duty)!.id,
      homeDepotId: sk.depot.id,
      modelYear,
      registeredAtMs,
      firmware,
      profile: makeProfile(seed, vin, sk.model, params),
    });
  });

  // --- bays -----------------------------------------------------------------------------------
  const bays: WorkshopBay[] = [];
  for (const d of depots) {
    d.sizeClass = sizeClass(d.vehicleCount);
    const count = clamp(Math.round(d.vehicleCount / 45) + rng.int(-1, 1), 2, 8);
    for (let b = 1; b <= count; b++) {
      const capability: WorkshopBay['capability'] = b === 1 ? 'ANY' : b % 2 === 0 ? 'EV' : 'ICE';
      bays.push({ id: bays.length + 1, depotId: d.id, bayNo: b, capability });
    }
  }

  const year = 365 * DAY_MS;
  const subscriptions: Subscription[] = [
    { id: 1, tenantId: 1, plan: 'ENTERPRISE', validFromMs: epochMs - 2 * year, validToMs: epochMs + year },
    { id: 2, tenantId: 2, plan: 'GROWTH', validFromMs: epochMs - year, validToMs: epochMs + year / 2 },
  ];

  return {
    seed,
    n,
    t0Ms,
    epochMs,
    tenants: [...TENANTS],
    subscriptions,
    fleets: [...FLEETS],
    depots,
    bays,
    firmwareReleases,
    vehicles,
    drivers,
    driverAssignments,
    reserved: { s1DepotId: s1.id, s1bDepotId: s1b.id },
  };
}

function pseudonym(seed: string, driverId: number): string {
  return `DRV-${hashSeed(seed, 'driver', driverId).toString(36).toUpperCase().padStart(7, '0')}`;
}

/** Firmware version installed at time t (the newest install at or before t). */
export function firmwareAt(v: Vehicle, t: number): string {
  let current = v.firmware[0]!.version;
  for (const f of v.firmware) {
    if (f.installedAtMs <= t) current = f.version;
    else break;
  }
  return current;
}

export function vehicleModel(v: Vehicle): VehicleModel {
  return modelById(v.modelId);
}

/** Contiguous VIN-index range owned by worker `w` of `workers`. */
export function workerRange(n: number, workers: number, w: number): { start: number; end: number } {
  const size = Math.ceil(n / workers);
  return { start: Math.min(n, w * size), end: Math.min(n, (w + 1) * size) };
}
