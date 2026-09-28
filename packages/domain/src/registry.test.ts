import { describe, expect, it } from 'vitest';
import { DUTIES, MODELS, S1_MODEL_CODE, S1_OTHER_MODEL_CODE, dutyById, modelById, regionById } from './catalog.js';
import { geohashEncode } from './geohash.js';
import { DEFAULT_PARAMS, withParams } from './params.js';
import { firmwareAt, generateRegistry, workerRange } from './registry.js';
import { DAY_MS } from './time.js';
import { isValidVin } from './vin.js';

const T0 = Date.parse('2026-09-28T04:00:00Z');
const N = 5000;
const reg = generateRegistry('test-seed', N, T0, DEFAULT_PARAMS);

describe('registry', () => {
  it('has exactly N vehicles with valid, unique VINs', () => {
    expect(reg.vehicles).toHaveLength(N);
    const vins = new Set(reg.vehicles.map((v) => v.vin));
    expect(vins.size).toBe(N);
    expect(reg.vehicles.every((v) => isValidVin(v.vin))).toBe(true);
  });

  it('is deterministic for (seed, N) and changes with the seed', () => {
    const again = generateRegistry('test-seed', N, T0, DEFAULT_PARAMS);
    expect(again.vehicles.map((v) => v.vin)).toEqual(reg.vehicles.map((v) => v.vin));
    expect(again.vehicles[123]!.profile).toEqual(reg.vehicles[123]!.profile);
    const other = generateRegistry('other-seed', N, T0, DEFAULT_PARAMS);
    expect(other.vehicles.map((v) => v.modelId)).not.toEqual(reg.vehicles.map((v) => v.modelId));
  });

  it('rejects tiny fleets', () => {
    expect(() => generateRegistry('s', 10, T0, DEFAULT_PARAMS)).toThrow(/SIM_SCALE/);
  });

  it('follows the powertrain mix (55/35/10) and duty shares', () => {
    const pt = { EV: 0, DIESEL: 0, HYBRID: 0 };
    const duty: Record<string, number> = {};
    for (const v of reg.vehicles) {
      pt[modelById(v.modelId).powertrain]++;
      const code = dutyById(v.dutyId).code;
      duty[code] = (duty[code] ?? 0) + 1;
    }
    expect(pt.EV / N).toBeCloseTo(0.55, 1);
    expect(pt.DIESEL / N).toBeCloseTo(0.35, 1);
    expect(pt.HYBRID / N).toBeCloseTo(0.1, 1);
    for (const d of DUTIES) expect(duty[d.code]! / N).toBeCloseTo(d.share, 1);
    // EVs never run linehaul
    expect(
      reg.vehicles.some((v) => modelById(v.modelId).powertrain === 'EV' && dutyById(v.dutyId).code === 'LINEHAUL'),
    ).toBe(false);
  });

  it('uses 8 models (4 per OEM) and 8 regions', () => {
    expect(new Set(reg.vehicles.map((v) => v.modelId)).size).toBe(8);
    expect(MODELS.filter((m) => m.oemId === 1)).toHaveLength(4);
    expect(new Set(reg.depots.map((d) => d.regionId)).size).toBe(8);
  });

  it('splits tenants roughly 70/30 and keeps vehicle tenant == fleet tenant', () => {
    const a = reg.vehicles.filter((v) => v.tenantId === 1).length / N;
    expect(a).toBeGreaterThan(0.6);
    expect(a).toBeLessThan(0.8);
    const fleetTenant = new Map(reg.fleets.map((f) => [f.id, f.tenantId]));
    expect(reg.vehicles.every((v) => fleetTenant.get(v.fleetId) === v.tenantId)).toBe(true);
  });

  it.each([1000, 5000])('reserves depots S1 (>= 60 cohort) and S1b (>= 30) in different regions at N=%i', (n) => {
    const r = n === N ? reg : generateRegistry('test-seed', n, T0, DEFAULT_PARAMS);
    const cohort = (depotId: number, code: string) =>
      r.vehicles.filter(
        (v) => v.homeDepotId === depotId && modelById(v.modelId).code === code && dutyById(v.dutyId).code === 'URBAN',
      ).length;
    const s1 = r.depots.find((d) => d.id === r.reserved.s1DepotId)!;
    const s1b = r.depots.find((d) => d.id === r.reserved.s1bDepotId)!;
    expect(cohort(s1.id, S1_MODEL_CODE)).toBe(DEFAULT_PARAMS.s1CohortSize);
    expect(cohort(s1b.id, S1_MODEL_CODE)).toBe(DEFAULT_PARAMS.s1bCohortSize);
    expect(cohort(s1.id, S1_OTHER_MODEL_CODE)).toBeGreaterThanOrEqual(2);
    expect(s1.regionId).not.toBe(s1b.regionId);
    expect(modelById(MODELS.find((m) => m.code === S1_MODEL_CODE)!.id).powertrain).toBe('DIESEL');
    expect(regionById(s1.regionId).climate).toBe('HOT_DRY');
  });

  it('has about N/250 depots, mostly 150-300 vans, and 2-8 bays each', () => {
    expect(reg.depots).toHaveLength(Math.round(N / 250));
    const normal = reg.depots.filter((d) => d.id !== reg.reserved.s1DepotId && d.id !== reg.reserved.s1bDepotId);
    const inRange = normal.filter((d) => d.vehicleCount >= 150 && d.vehicleCount <= 300).length;
    expect(inRange / normal.length).toBeGreaterThan(0.8);
    for (const d of reg.depots) {
      const bays = reg.bays.filter((b) => b.depotId === d.id).length;
      expect(bays).toBeGreaterThanOrEqual(2);
      expect(bays).toBeLessThanOrEqual(8);
      expect(d.geohash5).toBe(geohashEncode(d.lat, d.lon, 5));
    }
  });

  it('makes ~2% of diesel vans naturally hot (+6..+8 C) and nobody else', () => {
    const diesel = reg.vehicles.filter((v) => modelById(v.modelId).powertrain === 'DIESEL');
    const hot = diesel.filter((v) => v.profile.naturallyHot);
    expect(hot.length / diesel.length).toBeGreaterThan(0.01);
    expect(hot.length / diesel.length).toBeLessThan(0.035);
    expect(hot.every((v) => v.profile.coolantOffsetC >= 6 && v.profile.coolantOffsetC <= 9)).toBe(true);
    expect(reg.vehicles.filter((v) => v.profile.naturallyHot).length).toBe(hot.length);
  });

  it('records firmware history in order, all before the world epoch', () => {
    for (const v of reg.vehicles.slice(0, 500)) {
      const times = v.firmware.map((f) => f.installedAtMs);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(times.every((t) => t < reg.epochMs)).toBe(true);
      expect(firmwareAt(v, reg.epochMs)).toBe(v.firmware.at(-1)!.version);
      expect(firmwareAt(v, v.registeredAtMs - DAY_MS)).toBe(v.firmware[0]!.version);
    }
  });

  it('gives each vehicle a current driver and non-overlapping assignment history', () => {
    const byVin = new Map<string, { from: number; to: number | null }[]>();
    for (const a of reg.driverAssignments) {
      const list = byVin.get(a.vin) ?? [];
      list.push({ from: a.validFromMs, to: a.validToMs });
      byVin.set(a.vin, list);
    }
    expect(byVin.size).toBe(N);
    for (const list of byVin.values()) {
      expect(list.filter((x) => x.to === null)).toHaveLength(1);
      const sorted = list.sort((a, b) => a.from - b.from);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1]!.to!).toBeLessThanOrEqual(sorted[i]!.from);
    }
    expect(new Set(reg.drivers.map((d) => d.pseudonym)).size).toBe(reg.drivers.length);
  });

  it('splits VIN ranges across workers without gaps or overlap', () => {
    for (const workers of [1, 3, 4, 7]) {
      let next = 0;
      for (let w = 0; w < workers; w++) {
        const r = workerRange(N, workers, w);
        expect(r.start).toBe(next);
        next = r.end;
      }
      expect(next).toBe(N);
    }
  });

  it('applies param overrides', () => {
    const p = withParams({ s1CohortSize: 70, coolant: { ...DEFAULT_PARAMS.coolant, baseC: 90 } });
    expect(p.s1CohortSize).toBe(70);
    expect(p.coolant.baseC).toBe(90);
    expect(p.coolant.noiseSdC).toBe(DEFAULT_PARAMS.coolant.noiseSdC);
  });
});
