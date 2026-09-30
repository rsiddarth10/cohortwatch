import { describe, expect, it } from 'vitest';
import { modelById, dutyById, regionById, S1_MODEL_CODE } from './catalog.js';
import { buildGroundTruth, computeLimitTs, isDrivingReading } from './groundtruth.js';
import { DEFAULT_PARAMS } from './params.js';
import { generateRegistry } from './registry.js';
import { applyFirmwarePlant, buildScenario, driftDelta, traitHooks } from './scenario.js';
import { FleetStream, VehicleStream, ambientAt, makeWorldContext, type SimEvent } from './simulate.js';
import { HOUR_MS, MINUTE_MS, SimClock } from './time.js';

const T0 = Date.parse('2026-09-28T04:00:00Z');
const P = DEFAULT_PARAMS;
const reg = generateRegistry('plant-test', 3000, T0, P);
const sc = buildScenario(reg, P, { plants: true, depotTransfer: false });
applyFirmwarePlant(reg, sc);
const byVin = new Map(reg.vehicles.map((v) => [v.vin, v]));
const vinsOf = (role: string) => [...sc.plants.values()].filter((p) => p.role === role).map((p) => p.vin);

function stream(vin: string, from: number, to: number, repairs?: Map<string, number>): SimEvent[] {
  const ctx = makeWorldContext(reg, P, sc);
  if (repairs) ctx.repairs = repairs;
  const s = new VehicleStream(byVin.get(vin)!, ctx, from);
  const out: SimEvent[] = [];
  for (let e = s.next(); e.eventTs < to; e = s.next()) out.push(e);
  return out;
}
const driving = (events: SimEvent[]) => events.filter((e) => isDrivingReading(e) && e.coolantC !== null);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('scenario selection (brief §5.4)', () => {
  it('picks every plant from the seeded registry with the right sizes', () => {
    const count = (r: string) => vinsOf(r).length;
    expect(count('s1_sister') + count('bad_repair')).toBe(15);
    expect(count('bad_repair')).toBe(1);
    expect(count('s1_late_sister')).toBe(3);
    expect(count('s1_healthy_cohort')).toBe(42);
    expect(count('s1b_sister')).toBe(8);
    expect(count('runaway')).toBe(1);
    expect(count('decoy_scattered')).toBe(6);
    expect(count('decoy_same_depot_other_model')).toBe(2);
    expect(count('loud_stable')).toBe(20);
    expect(count('sensor_glitch')).toBe(3);
  });

  it('puts sisters on the reserved depots and decoys/runaway/heatwave elsewhere', () => {
    const depot = (vin: string) => byVin.get(vin)!.homeDepotId;
    const regionOf = (vin: string) => reg.depots.find((d) => d.id === depot(vin))!.regionId;
    for (const vin of [...vinsOf('s1_sister'), ...vinsOf('s1_late_sister')]) {
      expect(depot(vin)).toBe(reg.reserved.s1DepotId);
      expect(modelById(byVin.get(vin)!.modelId).code).toBe(S1_MODEL_CODE);
    }
    for (const vin of vinsOf('s1b_sister')) expect(depot(vin)).toBe(reg.reserved.s1bDepotId);
    const scattered = vinsOf('decoy_scattered');
    expect(new Set(scattered.map(depot)).size).toBe(6);
    for (const vin of [...scattered, ...vinsOf('runaway')]) {
      expect([reg.reserved.s1DepotId, reg.reserved.s1bDepotId]).not.toContain(depot(vin));
      expect(regionOf(vin)).not.toBe(sc.heatwave!.regionId);
    }
    const runaway = byVin.get(vinsOf('runaway')[0]!)!;
    expect(modelById(runaway.modelId).oemId).toBe(1);
    expect(dutyById(runaway.dutyId).code).toBe('LINEHAUL');
    expect(sc.heatwave!.regionId).not.toBe(regionOf(vinsOf('s1_sister')[0]!));
    expect(regionById(sc.heatwave!.regionId).climate).toBe('HOT_HUMID');
  });

  it('is deterministic and switchable', () => {
    const again = buildScenario(generateRegistry('plant-test', 3000, T0, P), P, { plants: true, depotTransfer: false });
    expect([...again.plants.keys()]).toEqual([...sc.plants.keys()]);
    const off = buildScenario(reg, P, { plants: false, depotTransfer: false });
    expect(off.plants.size).toBe(0);
    expect(off.heatwave).toBeNull();
    expect(off.coolantDeltaC(vinsOf('s1_sister')[0]!, T0 + 40 * HOUR_MS, undefined)).toBe(0);
  });

  it('rolls out firmware 4.2.1: 16/18 sisters and 20/42 healthy peers in T0-48h..T0', () => {
    const f = sc.firmware!;
    expect(f.s1SistersUpdated).toBe(16);
    expect(f.s1HealthyUpdated).toBe(20);
    const sisters = new Set(sc.s1.sisters);
    expect(f.installs.filter((i) => sisters.has(i.vin))).toHaveLength(16);
    for (const i of f.installs) {
      expect(i.installedAtMs).toBeGreaterThanOrEqual(T0 - 48 * HOUR_MS);
      expect(i.installedAtMs).toBeLessThan(T0);
    }
    const updated = f.installs[0]!;
    const e = stream(updated.vin, T0, T0 + 12 * HOUR_MS)[0]!;
    expect(e.firmware).toBe('4.2.1');
    const before = reg.firmwareReleases.length;
    applyFirmwarePlant(reg, sc); // idempotent
    expect(reg.firmwareReleases).toHaveLength(before);
  });
});

describe('plant signals', () => {
  it('S1 sisters drift up from onset; late sisters only from T0+24h; healthy cohort stays flat', () => {
    const drift = (vin: string, from: number, to: number) =>
      mean(driving(stream(vin, from, to)).map((e) => e.coolantC!));
    for (const vin of vinsOf('s1_sister').slice(0, 5)) {
      const before = drift(vin, T0 - 24 * HOUR_MS, T0 + 6 * HOUR_MS);
      const after = drift(vin, T0 + 36 * HOUR_MS, T0 + 48 * HOUR_MS);
      expect(after - before).toBeGreaterThan(6);
    }
    for (const vin of vinsOf('s1_late_sister')) {
      const p = sc.plants.get(vin)!;
      expect(p.late).toBe(true);
      expect(p.drift!.onsetMs).toBeGreaterThanOrEqual(T0 + 24 * HOUR_MS);
      expect(driftDelta(p, T0 + 20 * HOUR_MS)).toBe(0);
      expect(driftDelta(p, T0 + 60 * HOUR_MS)).toBeGreaterThan(8);
    }
    for (const vin of vinsOf('s1_healthy_cohort').slice(0, 5)) {
      const before = drift(vin, T0 - 24 * HOUR_MS, T0 + 6 * HOUR_MS);
      const after = drift(vin, T0 + 36 * HOUR_MS, T0 + 48 * HOUR_MS);
      expect(Math.abs(after - before)).toBeLessThan(3);
    }
  });

  it('sisters emit COOLING codes more often as they drift', () => {
    const vin = vinsOf('s1_sister')[0]!;
    const codes = stream(vin, T0 + 30 * HOUR_MS, T0 + 80 * HOUR_MS).flatMap((e) => e.dtc);
    expect(codes.length).toBeGreaterThan(2);
    expect(codes.every((c) => ['P0217', 'P0118', 'P0480'].includes(c))).toBe(true);
  });

  it('runaway: drives continuously T0+10h..T0+34h, accelerating, limit at ~T0+34h', () => {
    const vin = vinsOf('runaway')[0]!;
    const events = stream(vin, T0 + 10 * HOUR_MS, T0 + 36 * HOUR_MS);
    const d = driving(events);
    // continuous: no parked heartbeat inside the run, only a 2-minute driver swap
    expect(events.filter((e) => e.evt === 'HEARTBEAT')).toHaveLength(0);
    const limit = computeLimitTs(reg, P, sc, vin, T0 + 60 * HOUR_MS)!;
    expect(Math.abs(limit - (T0 + 34 * HOUR_MS))).toBeLessThan(2 * HOUR_MS);
    const window = d.filter((e) => e.eventTs >= limit - 12 * HOUR_MS && e.eventTs < limit);
    expect(window.length).toBeGreaterThanOrEqual(15);
    // accelerating: second half rises faster than the first
    const at = (h: number) =>
      mean(d.filter((e) => Math.abs(e.eventTs - (T0 + h * HOUR_MS)) < HOUR_MS).map((e) => e.coolantC!));
    expect(at(33) - at(22)).toBeGreaterThan(at(22) - at(11));
  });

  it('heatwave raises ambient by ~10 C in its region, only inside its window', () => {
    const ctx = makeWorldContext(reg, P, sc);
    const plain = makeWorldContext(reg, P);
    const r = regionById(sc.heatwave!.regionId);
    const mid = T0 + 36 * HOUR_MS;
    expect(ambientAt(ctx, r, mid) - ambientAt(plain, r, mid)).toBeCloseTo(10, 5);
    expect(ambientAt(ctx, r, T0) - ambientAt(plain, r, T0)).toBe(0);
    const other = regionById(r.id === 1 ? 2 : 1);
    expect(ambientAt(ctx, other, mid)).toBe(ambientAt(plain, other, mid));
  });

  it('repair stops the drift within ~2 sim-hours; the bad repair keeps drifting', () => {
    const good = vinsOf('s1_sister')[0]!;
    const bad = vinsOf('bad_repair')[0]!;
    const at = T0 + 30 * HOUR_MS;
    const repairs = new Map([
      [good, at],
      [bad, at],
    ]);
    expect(driftDelta(sc.plants.get(good), at + 3 * HOUR_MS, at)).toBeLessThan(0.2);
    expect(driftDelta(sc.plants.get(bad), at + 3 * HOUR_MS, at)).toBeGreaterThan(driftDelta(sc.plants.get(bad), at));
    const later = (vin: string, rep?: Map<string, number>) =>
      mean(driving(stream(vin, at + 20 * HOUR_MS, at + 40 * HOUR_MS, rep)).map((e) => e.coolantC!));
    expect(later(good) - later(good, repairs)).toBeGreaterThan(5);
    expect(Math.abs(later(bad) - later(bad, repairs))).toBeLessThan(0.01);
  });

  it('a mid-day repair regenerates only the future: prefix identical, seq contiguous', () => {
    const vin = vinsOf('s1_sister')[1]!;
    const v = byVin.get(vin)!;
    const ctx = makeWorldContext(reg, P, sc);
    const fleet = new FleetStream([v], ctx, T0 + 30 * HOUR_MS);
    const first = fleet.drainUntil(T0 + 36 * HOUR_MS);
    const effective = fleet.repair(vin, T0 + 36 * HOUR_MS)!;
    const rest = fleet.drainUntil(T0 + 60 * HOUR_MS);
    const all = [...first, ...rest];
    all.forEach((e, i) => i > 0 && expect(e.seq).toBe(all[i - 1]!.seq + 1));
    const unrepaired = stream(vin, T0 + 30 * HOUR_MS, T0 + 60 * HOUR_MS);
    expect(first).toEqual(unrepaired.slice(0, first.length));
    const late = (xs: SimEvent[]) =>
      mean(driving(xs.filter((e) => e.eventTs > effective + 3 * HOUR_MS)).map((e) => e.coolantC!));
    expect(late(unrepaired) - late(rest)).toBeGreaterThan(4);
    expect(fleet.repair('NOPE', 0)).toBeNull();
  });

  it('sensor glitch: one 25 -> 140 -> 25 C spike within 10 s', () => {
    const vin = vinsOf('sensor_glitch')[0]!;
    const e = stream(vin, T0, T0 + 72 * HOUR_MS);
    const spike = e.findIndex((x) => x.coolantC === 140);
    expect(spike).toBeGreaterThan(0);
    expect(e[spike - 1]!.coolantC).toBe(25);
    expect(e[spike + 1]!.coolantC).toBe(25);
    expect(e[spike + 1]!.eventTs - e[spike - 1]!.eventTs).toBe(10_000);
  });

  it('loud-but-stable vans throw many codes with flat signals', () => {
    const vin = vinsOf('loud_stable')[0]!;
    const e = stream(vin, T0, T0 + 48 * HOUR_MS);
    expect(e.flatMap((x) => x.dtc).length).toBeGreaterThan(5);
  });

  it('surge: 10-minute driving cadence inside T0+24h..T0+42h only', () => {
    expect(sc.cadenceMs(T0 + 30 * HOUR_MS, 30 * MINUTE_MS)).toBe(10 * MINUTE_MS);
    expect(sc.cadenceMs(T0 + 50 * HOUR_MS, 30 * MINUTE_MS)).toBe(30 * MINUTE_MS);
  });

  it('faults never touch history: events before T0 match a fault-free world exactly', () => {
    for (const vin of [...vinsOf('s1_sister').slice(0, 3), vinsOf('runaway')[0]!]) {
      const withPlants = stream(vin, reg.epochMs, T0);
      const ctx = makeWorldContext(reg, P);
      const s = new VehicleStream(byVin.get(vin)!, ctx, reg.epochMs);
      const plain: SimEvent[] = [];
      for (let e = s.next(); e.eventTs < T0; e = s.next()) plain.push(e);
      expect(withPlants).toEqual(plain);
    }
  });

  it('loudness is a van trait: a loud van is loud in history too, identical to the traits-only world', () => {
    const vin = vinsOf('loud_stable')[0]!;
    const withPlants = stream(vin, reg.epochMs, T0);
    const s = new VehicleStream(byVin.get(vin)!, makeWorldContext(reg, P, traitHooks(sc)), reg.epochMs);
    const traits: SimEvent[] = [];
    for (let e = s.next(); e.eventTs < T0; e = s.next()) traits.push(e);
    expect(withPlants).toEqual(traits);
    expect(traits.filter((e) => e.evt === 'DTC').length).toBeGreaterThan(20);
  });
});

describe('ground truth', () => {
  it('has one row per vehicle with roles, onsets and limit times', () => {
    const gt = buildGroundTruth(reg, P, sc);
    expect(gt).toHaveLength(reg.n);
    const runaway = gt.find((r) => r.role === 'runaway')!;
    expect(runaway.limitTs).not.toBeNull();
    expect(gt.filter((r) => r.expectedCampaign === 'S1')).toHaveLength(18);
    expect(gt.filter((r) => r.expectedCampaign === 'S1b')).toHaveLength(8);
    expect(gt.some((r) => r.role === 'heatwave_region')).toBe(true);
    expect(gt.filter((r) => r.role === 'background').length).toBeGreaterThan(reg.n / 2);
  });

  it('heatwave vans carry scenario "heatwave" with the heatwave start as onset (no fault family)', () => {
    const heat = buildGroundTruth(reg, P, sc).filter((r) => r.role === 'heatwave_region');
    expect(heat.length).toBeGreaterThan(0);
    for (const r of heat) {
      expect(r.scenarioId).toBe('heatwave');
      expect(r.onsetTs).toBe(sc.heatwave!.fromMs);
      expect(r.faultFamily).toBeNull();
      expect(r.expectedCampaign).toBeNull();
    }
  });
});

describe('SimClock', () => {
  it('runs 360x from its start and maps back to wall time', () => {
    let wall = 1_000;
    const c = new SimClock(T0, 360, 1_000, () => wall);
    expect(c.now()).toBe(T0);
    wall += 1_000;
    expect(c.now()).toBe(T0 + 6 * MINUTE_MS);
    expect(c.wallAt(T0 + 72 * HOUR_MS)).toBe(1_000 + 720_000);
    expect(() => new SimClock(T0, 0)).toThrow();
  });

  it('pauses (now stands still) and resumes where it stood (video helper)', () => {
    let wall = 1_000;
    const c = new SimClock(T0, 360, 1_000, () => wall);
    wall = 2_000;
    c.pause();
    c.pause(); // idempotent
    expect(c.paused).toBe(true);
    wall = 60_000;
    expect(c.now()).toBe(T0 + 6 * MINUTE_MS);
    c.resume();
    c.resume(); // idempotent
    expect(c.paused).toBe(false);
    expect(c.now()).toBe(T0 + 6 * MINUTE_MS);
    wall = 61_000;
    expect(c.now()).toBe(T0 + 12 * MINUTE_MS);
    expect(c.wallAt(T0 + 12 * MINUTE_MS)).toBe(61_000);
    // explicit wall times: every worker applies the same instants
    const w = new SimClock(T0, 360, 1_000, () => 999_999);
    w.pause(2_000);
    w.resume(60_000);
    expect(w.wallAt(T0 + 6 * MINUTE_MS)).toBe(60_000);
  });
});
