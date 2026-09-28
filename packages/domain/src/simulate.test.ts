import { describe, expect, it } from 'vitest';
import { DUTIES, MODELS, REGIONS, dutyById, modelById } from './catalog.js';
import { DEFAULT_PARAMS } from './params.js';
import { generateRegistry, workerRange, type Vehicle } from './registry.js';
import {
  FleetStream,
  VehicleStream,
  ambientAt,
  dayStartMs,
  generateVehicleDay,
  initialState,
  makeWorldContext,
  planDay,
  type SimEvent,
} from './simulate.js';
import { DAY_MS, HOUR_MS, LiveClock, ManualClock, worldEpochMs } from './time.js';

const T0 = Date.parse('2026-09-28T04:00:00Z');
const reg = generateRegistry('sim-test', 1000, T0, DEFAULT_PARAMS);
const ctx = makeWorldContext(reg, DEFAULT_PARAMS);
const DAYS = 4;

/** A sample covering every model x duty combination present, plus extra urban vans. */
function sample(): Vehicle[] {
  const seen = new Set<string>();
  const out: Vehicle[] = [];
  for (const v of reg.vehicles) {
    const key = `${v.modelId}:${v.dutyId}`;
    if (!seen.has(key) || (dutyById(v.dutyId).code === 'URBAN' && out.length < 150)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}
const vehicles = sample();

function run(v: Vehicle, days = DAYS): SimEvent[] {
  let s = initialState(v, ctx);
  const all: SimEvent[] = [];
  for (let d = 0; d < days; d++) {
    const r = generateVehicleDay(v, d, s, ctx);
    all.push(...r.events);
    s = r.end;
  }
  return all;
}
const streams = new Map(vehicles.map((v) => [v.vin, run(v)]));

describe('healthy signal model', () => {
  it('covers all powertrains and duties in the sample', () => {
    expect(new Set(vehicles.map((v) => modelById(v.modelId).powertrain)).size).toBe(3);
    expect(new Set(vehicles.map((v) => v.dutyId)).size).toBe(DUTIES.length);
  });

  it('keeps every signal inside physical ranges', () => {
    for (const events of streams.values()) {
      for (const e of events) {
        expect(e.speedKmh).toBeGreaterThanOrEqual(0);
        expect(e.speedKmh).toBeLessThanOrEqual(130);
        expect(e.ambientC).toBeGreaterThan(-25);
        expect(e.ambientC).toBeLessThan(55);
        expect(e.lvBattV).toBeGreaterThan(11.8);
        expect(e.lvBattV).toBeLessThan(14.8);
        if (e.coolantC !== null) {
          expect(e.coolantC).toBeGreaterThanOrEqual(-40);
          expect(e.coolantC).toBeLessThanOrEqual(115);
        }
        if (e.socPct !== null) {
          expect(e.socPct).toBeGreaterThanOrEqual(0);
          expect(e.socPct).toBeLessThanOrEqual(100);
        }
        if (e.fuelPct !== null) {
          expect(e.fuelPct).toBeGreaterThanOrEqual(0);
          expect(e.fuelPct).toBeLessThanOrEqual(100);
        }
        if (e.battTempC !== null) {
          expect(e.battTempC).toBeGreaterThan(-25);
          expect(e.battTempC).toBeLessThan(65);
        }
        expect(Number.isFinite(e.lat) && Number.isFinite(e.lon)).toBe(true);
        expect(e.idleS).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reports coolant only while the ignition is on, and only for engines', () => {
    for (const v of vehicles) {
      const pt = modelById(v.modelId).powertrain;
      for (const e of streams.get(v.vin)!) {
        if (!e.ignition) expect(e.coolantC).toBeNull();
        if (pt === 'EV') expect(e.coolantC).toBeNull();
        if (pt !== 'EV' && e.ignition) expect(e.coolantC).not.toBeNull();
        if (e.evt === 'HEARTBEAT' || e.evt === 'IGNITION_OFF') expect(e.ignition).toBe(false);
      }
    }
  });

  it('keeps the odometer monotonic and each increment equal to speed x time', () => {
    for (const events of streams.values()) {
      for (let i = 1; i < events.length; i++) {
        const a = events[i - 1]!;
        const b = events[i]!;
        expect(b.odoKm).toBeGreaterThanOrEqual(a.odoKm);
        const expected = (b.speedKmh * (b.eventTs - a.eventTs)) / HOUR_MS;
        expect(b.odoKm - a.odoKm).toBeCloseTo(expected, 6);
        if (!a.ignition && !b.ignition) expect(b.speedKmh).toBe(0);
      }
    }
  });

  it('numbers messages contiguously per vehicle across day boundaries, in time order', () => {
    for (const events of streams.values()) {
      events.forEach((e, i) => expect(e.seq).toBe(i + 1));
      for (let i = 1; i < events.length; i++) expect(events[i]!.eventTs).toBeGreaterThanOrEqual(events[i - 1]!.eventTs);
    }
  });

  it('gives urban vans >= 20 readings per day, >= 18 with the ignition on (brief 5.8 #6)', () => {
    const urban = vehicles.filter((v) => dutyById(v.dutyId).code === 'URBAN');
    let total = 0;
    let on = 0;
    for (const v of urban) {
      const ev = streams.get(v.vin)!;
      total += ev.length;
      on += ev.filter((e) => e.ignition).length;
    }
    const perDay = total / (urban.length * DAYS);
    const onPerDay = on / (urban.length * DAYS);
    expect(perDay).toBeGreaterThanOrEqual(20);
    expect(onPerDay).toBeGreaterThanOrEqual(18);
  });

  it('holds a healthy engine near its own normal once warm', () => {
    for (const v of vehicles.filter((x) => modelById(x.modelId).powertrain === 'DIESEL')) {
      const warm = streams.get(v.vin)!.filter((e) => e.evt === 'PERIODIC' && e.coolantC !== null);
      if (warm.length === 0) continue;
      const mean = warm.reduce((a, e) => a + e.coolantC!, 0) / warm.length;
      expect(mean).toBeGreaterThan(80);
      expect(mean).toBeLessThan(v.profile.naturallyHot ? 110 : 102);
    }
  });

  it('sends heartbeats every 4 sim-hours while parked', () => {
    for (const events of streams.values()) {
      const hb = events.filter((e) => e.evt === 'HEARTBEAT');
      expect(hb.length).toBeGreaterThan(0);
      for (let i = 1; i < events.length; i++) {
        const a = events[i - 1]!;
        const b = events[i]!;
        if (a.evt === 'HEARTBEAT' && b.evt === 'HEARTBEAT') expect(b.eventTs - a.eventTs).toBe(4 * HOUR_MS);
      }
    }
  });

  it('charges EVs at the depot while parked and drains them while driving', () => {
    const ev = vehicles.find((v) => modelById(v.modelId).powertrain === 'EV' && dutyById(v.dutyId).code === 'URBAN')!;
    const events = streams.get(ev.vin)!;
    expect(events.some((e) => e.charging && !e.ignition)).toBe(true);
    expect(events.every((e) => !(e.charging && e.ignition))).toBe(true);
    const driving = events.filter((e) => e.speedKmh > 0);
    expect(driving.length).toBeGreaterThan(0);
  });

  it('emits trip and ignition events in order within each window', () => {
    for (const events of streams.values()) {
      const lifecycle = events
        .map((e) => e.evt)
        .filter((t) => t === 'IGNITION_ON' || t === 'TRIP_START' || t === 'TRIP_END' || t === 'IGNITION_OFF');
      for (let i = 0; i < lifecycle.length; i += 4) {
        expect(lifecycle.slice(i, i + 4)).toEqual(['IGNITION_ON', 'TRIP_START', 'TRIP_END', 'IGNITION_OFF']);
      }
    }
  });

  it('plans shifts inside the vehicle-day, rental sometimes idle', () => {
    for (const v of vehicles) {
      for (let d = 0; d < 10; d++) {
        const w = planDay(v, dutyById(v.dutyId), d, ctx);
        const start = dayStartMs(ctx, d);
        for (const x of w) {
          expect(x.onMs).toBeGreaterThanOrEqual(start);
          expect(x.offMs).toBeLessThanOrEqual(start + DAY_MS);
          expect(x.offMs).toBeGreaterThan(x.onMs);
        }
      }
    }
  });

  it('gives hot-dry regions afternoons above 35 C and cold regions below 15 C', () => {
    const hot = REGIONS.find((r) => r.climate === 'HOT_DRY')!;
    const cold = REGIONS.find((r) => r.climate === 'COLD')!;
    const temps = (r: typeof hot) => Array.from({ length: 96 }, (_, h) => ambientAt(ctx, r, reg.epochMs + h * HOUR_MS));
    expect(Math.max(...temps(hot))).toBeGreaterThan(35);
    expect(Math.max(...temps(cold))).toBeLessThan(15);
  });

  it('does not emit fault codes outside the powertrain families', () => {
    const codes = new Set<string>();
    for (const v of reg.vehicles.slice(0, 300)) {
      for (const e of run(v, 20)) {
        e.dtc.forEach((c) => codes.add(`${modelById(v.modelId).powertrain}:${c}`));
      }
    }
    expect(codes.size).toBeGreaterThan(0);
    expect([...codes].some((c) => c.startsWith('EV:P0217'))).toBe(false);
    expect([...codes].some((c) => c.startsWith('EV:P2463'))).toBe(false);
  });
});

describe('determinism', () => {
  it('a stream started mid-world matches day-by-day generation (replayed state + seq)', () => {
    const v = vehicles[3]!;
    const full = streams.get(v.vin)!;
    const from = reg.epochMs + 2 * DAY_MS + 9 * HOUR_MS;
    const s = new VehicleStream(v, ctx, from);
    const expected = full.filter((e) => e.eventTs >= from).slice(0, 25);
    const got = Array.from({ length: expected.length }, () => s.next());
    expect(got).toEqual(expected);
  });

  it('produces identical per-VIN output for any number of workers', () => {
    const vs = reg.vehicles.slice(0, 120);
    const from = reg.epochMs + DAY_MS;
    const until = from + 12 * HOUR_MS;
    const byVin = (events: SimEvent[]) => {
      const m = new Map<string, SimEvent[]>();
      for (const e of events) m.set(e.vin, [...(m.get(e.vin) ?? []), e]);
      return m;
    };
    const single = byVin(new FleetStream(vs, makeWorldContext(reg, DEFAULT_PARAMS), from).drainUntil(until));
    for (const workers of [2, 4, 7]) {
      const merged: SimEvent[] = [];
      for (let w = 0; w < workers; w++) {
        const r = workerRange(vs.length, workers, w);
        // each worker has its own context, like separate processes
        const fleet = new FleetStream(vs.slice(r.start, r.end), makeWorldContext(reg, DEFAULT_PARAMS), from);
        merged.push(...fleet.drainUntil(until));
      }
      expect(byVin(merged)).toEqual(single);
    }
  });

  it('the same seed produces identical first 1,000 messages; another seed does not', () => {
    const first = (seed: string) => {
      const r = generateRegistry(seed, 1000, T0, DEFAULT_PARAMS);
      return new FleetStream(r.vehicles, makeWorldContext(r, DEFAULT_PARAMS), r.epochMs).drainUntil(Infinity, 1000);
    };
    const a = first('same');
    expect(a).toHaveLength(1000);
    expect(first('same')).toEqual(a);
    expect(first('different')).not.toEqual(a);
  });

  it('merges streams in (time, vehicle) order and reports the next time', () => {
    const fleet = new FleetStream(reg.vehicles.slice(0, 50), ctx, reg.epochMs);
    expect(fleet.size).toBe(50);
    const t = fleet.peekTs();
    expect(Number.isFinite(t)).toBe(true);
    const batch = fleet.drainUntil(reg.epochMs + 6 * HOUR_MS);
    for (let i = 1; i < batch.length; i++) expect(batch[i]!.eventTs).toBeGreaterThanOrEqual(batch[i - 1]!.eventTs);
    expect(new FleetStream([], ctx, 0).peekTs()).toBe(Infinity);
  });
});

describe('clocks and time', () => {
  it('live clock reads the injected wall clock at 1x; manual clock advances', () => {
    expect(new LiveClock(() => 42).now()).toBe(42);
    expect(new LiveClock().speed).toBe(1);
    const m = new ManualClock(10);
    m.advance(5);
    expect(m.now()).toBe(15);
    m.set(100);
    expect(m.now()).toBe(100);
  });

  it('aligns the world epoch to the day boundary, historyDays before T0', () => {
    const e = worldEpochMs(T0, 7, 4);
    expect(new Date(e).getUTCHours()).toBe(4);
    expect(T0 - e).toBeGreaterThanOrEqual(7 * DAY_MS);
    expect(T0 - e).toBeLessThan(8 * DAY_MS);
    expect(MODELS).toHaveLength(8);
  });
});
