import { FAULT_CODES, dutyById, familiesFor, modelById, regionById, type DutyProfile, type Region } from './catalog.js';
import type { SimParams } from './params.js';
import { firmwareAt, type Depot, type Registry, type Vehicle } from './registry.js';
import { Rng, clamp } from './rng.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';

export type EventType =
  | 'IGNITION_ON'
  | 'TRIP_START'
  | 'PERIODIC'
  | 'HARSH_BRAKE'
  | 'HARSH_ACCEL'
  | 'DTC'
  | 'TRIP_END'
  | 'IGNITION_OFF'
  | 'HEARTBEAT';

/** One simulated vehicle message in canonical units (SI, °C). Formats convert from this. */
export interface SimEvent {
  vin: string;
  oemId: number;
  /** Per-vehicle, contiguous from 1 at the world epoch: total events this VIN has emitted. */
  seq: number;
  /** Simulated event time, epoch ms. */
  eventTs: number;
  evt: EventType;
  lat: number;
  lon: number;
  /** Mean speed over the interval since the previous message; odometer delta = speed × interval. */
  speedKmh: number;
  odoKm: number;
  ambientC: number;
  coolantC: number | null;
  rpm: number | null;
  battTempC: number | null;
  socPct: number | null;
  fuelPct: number | null;
  lvBattV: number;
  ignition: boolean;
  charging: boolean;
  harshBrake: number;
  harshAccel: number;
  idleS: number;
  dtc: string[];
  firmware: string;
}

/** State carried across vehicle-days (the only thing a day needs from the past). */
export interface VehicleState {
  seq: number;
  lastEventMs: number;
  odoKm: number;
  socPct: number;
  fuelPct: number;
  lat: number;
  lon: number;
  atDepot: boolean;
  /** Start of the current parked period (heartbeats are every heartbeatH from here). */
  parkedSinceMs: number;
  lastCoolantC: number;
  lastOffMs: number;
}

/** Plant hooks (implemented by scenario.ts). Absent = healthy fleet. */
export interface ScenarioHooks {
  ambientDeltaC(regionId: number, t: number): number;
  cadenceMs(t: number, baseMs: number): number;
  overrideWindows(v: Vehicle, day: number, dayStart: number, windows: IgnitionWindow[]): IgnitionWindow[];
  coolantDeltaC(vin: string, t: number, repairAtMs: number | undefined): number;
  extraDtc(v: Vehicle, w: IgnitionWindow, repairAtMs: number | undefined): { t: number; codes: string[] }[];
  styleFactor(vin: string, day: number): number;
  glitchDay(vin: string): number | null;
  homeDepotId(v: Vehicle, t: number): number;
}

export interface WorldContext {
  seed: string;
  epochMs: number;
  params: SimParams;
  depotsById: Map<number, Depot>;
  /** Memo of daily weather offsets per (region, day); pure cache. */
  weather: Map<string, number>;
  /** Plants (step 1b). Undefined for a plant-free world (history, PLANTS=off). */
  scenario?: ScenarioHooks;
  /** Repairs received so far: VIN -> repaired_at (sim ms). External input, applied from that time on. */
  repairs: Map<string, number>;
}

export function makeWorldContext(registry: Registry, params: SimParams, scenario?: ScenarioHooks): WorldContext {
  return {
    seed: registry.seed,
    epochMs: registry.epochMs,
    params,
    depotsById: new Map(registry.depots.map((d) => [d.id, d])),
    weather: new Map(),
    scenario,
    repairs: new Map(),
  };
}

// ---------------------------------------------------------------------------------------------
// Ambient

function dayOffset(ctx: WorldContext, region: Region, day: number): number {
  const key = `${region.id}:${day}`;
  let v = ctx.weather.get(key);
  if (v === undefined) {
    v = Rng.of(ctx.seed, 'weather', region.id, day).normal(0, 1.5);
    ctx.weather.set(key, v);
  }
  return v;
}

/** Regional ambient temperature (no per-reading noise): daily curve + smoothly varying weather. */
export function ambientAt(ctx: WorldContext, region: Region, t: number): number {
  const hour = (((t / HOUR_MS) % 24) + 24) % 24;
  const curve = region.ambientMeanC + region.ambientAmpC * Math.cos((2 * Math.PI * (hour - 15)) / 24);
  const dayF = t / DAY_MS;
  const d = Math.floor(dayF);
  const frac = dayF - d;
  const weather = dayOffset(ctx, region, d) * (1 - frac) + dayOffset(ctx, region, d + 1) * frac;
  return curve + weather + (ctx.scenario?.ambientDeltaC(region.id, t) ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Day plan: ignition-on windows

export interface IgnitionWindow {
  onMs: number;
  offMs: number;
  /** True when the van returns to its home depot at the end of this window. */
  endsAtDepot: boolean;
}

export function dayStartMs(ctx: WorldContext, day: number): number {
  return ctx.epochMs + day * DAY_MS;
}

export function dayIndexAt(ctx: WorldContext, t: number): number {
  return Math.floor((t - ctx.epochMs) / DAY_MS);
}

const MIN_WINDOW_MS = 10 * MINUTE_MS;

export function planDay(v: Vehicle, duty: DutyProfile, day: number, ctx: WorldContext): IgnitionWindow[] {
  const rng = Rng.of(ctx.seed, v.vin, 'plan', day);
  const start = dayStartMs(ctx, day);
  const latestEnd = start + 23.5 * HOUR_MS;
  const windows: IgnitionWindow[] = [];

  if (duty.activeH === null) {
    // Rental: variable. Some days idle, otherwise 1-3 separate hires, each back at the depot.
    if (rng.chance(0.2)) return windows;
    const hires = rng.int(1, 3);
    let cursor = start + (duty.shiftStartH - ctx.params.dayStartHourUtc) * HOUR_MS + rng.uniform(0, 3) * HOUR_MS;
    const cutoff = start + 20 * HOUR_MS;
    for (let k = 0; k < hires; k++) {
      const on = cursor;
      const off = on + rng.uniform(0.5, 2.5) * HOUR_MS;
      if (off > cutoff) break;
      windows.push({ onMs: Math.round(on), offMs: Math.round(off), endsAtDepot: true });
      cursor = off + rng.uniform(0.5, 3) * HOUR_MS;
    }
    return windows;
  }

  const shiftStart =
    start + (duty.shiftStartH - ctx.params.dayStartHourUtc) * HOUR_MS + clamp(rng.normal(0, 0.4), -1, 1) * HOUR_MS;
  const total = duty.activeH * rng.uniform(0.92, 1.08) * HOUR_MS;
  const weights = Array.from({ length: duty.trips }, () => rng.uniform(0.8, 1.2));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const breaks = Array.from({ length: duty.trips - 1 }, () => rng.uniform(20, 60) * MINUTE_MS);
  const span = total + breaks.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, (latestEnd - shiftStart) / span);

  let cursor = shiftStart;
  for (let k = 0; k < duty.trips; k++) {
    const len = Math.max(MIN_WINDOW_MS, (total * weights[k]!) / wsum) * scale;
    const on = Math.round(cursor);
    const off = Math.round(cursor + len);
    windows.push({ onMs: on, offMs: off, endsAtDepot: k === duty.trips - 1 });
    cursor = off + (breaks[k] ?? 0) * scale;
  }
  return windows;
}

// ---------------------------------------------------------------------------------------------
// Vehicle-day generation

interface Planned {
  t: number;
  evt: EventType;
  window: number; // index into windows, -1 for parked events
  dtc?: string[];
  /** Sensor-glitch plant: impossible coolant value reported by this message. */
  coolantOverrideC?: number;
}

const ORDER: Record<EventType, number> = {
  HEARTBEAT: 0,
  IGNITION_ON: 1,
  TRIP_START: 2,
  PERIODIC: 3,
  HARSH_BRAKE: 4,
  HARSH_ACCEL: 5,
  DTC: 6,
  TRIP_END: 7,
  IGNITION_OFF: 8,
};

export function initialState(v: Vehicle, ctx: WorldContext): VehicleState {
  const depot = ctx.depotsById.get(v.homeDepotId)!;
  const rng = Rng.of(ctx.seed, v.vin, 'init');
  const pos = parkingSpot(depot, rng);
  const region = regionById(depot.regionId);
  return {
    seq: 0,
    lastEventMs: ctx.epochMs,
    odoKm: v.profile.odoBaseKm,
    socPct: v.profile.initialSocPct,
    fuelPct: v.profile.initialFuelPct,
    lat: pos.lat,
    lon: pos.lon,
    atDepot: true,
    parkedSinceMs: ctx.epochMs - Math.round(rng.uniform(0, ctx.params.heartbeatH) * HOUR_MS),
    lastCoolantC: ambientAt(ctx, region, ctx.epochMs),
    lastOffMs: ctx.epochMs - 12 * HOUR_MS,
  };
}

function parkingSpot(depot: Depot, rng: Rng): { lat: number; lon: number } {
  return { lat: depot.lat + rng.uniform(-0.002, 0.002), lon: depot.lon + rng.uniform(-0.002, 0.002) };
}

export interface DayResult {
  events: SimEvent[];
  end: VehicleState;
}

/**
 * All events of one vehicle on sim-day `day` (events with ts in [dayStart, dayStart + 24h)),
 * given the state at the start of that day. Pure and deterministic: depends only on
 * (seed, VIN, day, state), never on the worker, the wall clock or other vehicles.
 */
export function generateVehicleDay(v: Vehicle, day: number, start: VehicleState, ctx: WorldContext): DayResult {
  const p = ctx.params;
  const model = modelById(v.modelId);
  const duty = dutyById(v.dutyId);
  const sc = ctx.scenario;
  const d0 = dayStartMs(ctx, day);
  const d1 = d0 + DAY_MS;
  const depot = ctx.depotsById.get(sc ? sc.homeDepotId(v, d0) : v.homeDepotId)!;
  const region = regionById(depot.regionId);
  const pt = model.powertrain;
  const hasEngine = pt !== 'EV';
  const hasHvBattery = pt !== 'DIESEL';
  const repairAt = ctx.repairs.get(v.vin);
  const style = v.profile.style * (sc ? sc.styleFactor(v.vin, day) : 1);

  const planWindows = planDay(v, duty, day, ctx);
  const windows = sc ? sc.overrideWindows(v, day, d0, planWindows) : planWindows;
  const rng = Rng.of(ctx.seed, v.vin, 'events', day);

  // ---- 1. timeline -------------------------------------------------------------------------
  const planned: Planned[] = [];
  const hbMs = p.heartbeatH * HOUR_MS;
  const cadenceMs = p.cadenceMin * MINUTE_MS;

  const heartbeats = (parkedSince: number, from: number, to: number) => {
    const k0 = Math.max(1, Math.ceil((from - parkedSince) / hbMs));
    for (let t = parkedSince + k0 * hbMs; t < to; t += hbMs) planned.push({ t, evt: 'HEARTBEAT', window: -1 });
  };

  let parkedSince = start.parkedSinceMs;
  let cursor = d0;
  windows.forEach((w, i) => {
    heartbeats(parkedSince, cursor, w.onMs);
    planned.push({ t: w.onMs, evt: 'IGNITION_ON', window: i });
    planned.push({ t: w.onMs + MINUTE_MS, evt: 'TRIP_START', window: i });
    for (let t = w.onMs + cadenceMs; t < w.offMs - MINUTE_MS;) {
      planned.push({ t, evt: 'PERIODIC', window: i });
      t += sc ? sc.cadenceMs(t, cadenceMs) : cadenceMs;
    }
    const hours = (w.offMs - w.onMs) / HOUR_MS;
    const harsh = rng.poisson(duty.harshPerHour * style * hours);
    for (let k = 0; k < harsh; k++) {
      const t = Math.round(rng.uniform(w.onMs + 2 * MINUTE_MS, w.offMs - 2 * MINUTE_MS));
      planned.push({ t, evt: rng.chance(0.55) ? 'HARSH_BRAKE' : 'HARSH_ACCEL', window: i });
    }
    planned.push({ t: w.offMs - MINUTE_MS, evt: 'TRIP_END', window: i });
    planned.push({ t: w.offMs, evt: 'IGNITION_OFF', window: i });
    parkedSince = w.offMs;
    cursor = w.offMs;
  });
  heartbeats(parkedSince, cursor, d1);

  // Background fault codes (Poisson per vehicle-day), only while driving.
  const dtcCount = windows.length > 0 ? rng.poisson(p.dtcPerVehicleDay) : 0;
  for (let k = 0; k < dtcCount; k++) {
    const wi = rng.int(0, windows.length - 1);
    const w = windows[wi]!;
    const family = rng.pick(familiesFor(pt));
    const code = rng.pick(FAULT_CODES[family]);
    const t = Math.round(rng.uniform(w.onMs + 2 * MINUTE_MS, w.offMs - 2 * MINUTE_MS));
    planned.push({ t, evt: 'DTC', window: wi, dtc: [code] });
  }

  if (sc) {
    // Plant fault codes (own RNG streams, so plant-free vans are untouched).
    windows.forEach((w, i) => {
      for (const x of sc.extraDtc(v, w, repairAt)) planned.push({ t: x.t, evt: 'DTC', window: i, dtc: x.codes });
    });
    // Sensor glitch: 25 -> 140 -> 25 C within 10 s in the middle of the day's longest drive.
    if (sc.glitchDay(v.vin) === day && windows.length > 0) {
      const wi = windows.reduce((b, w, i) => (w.offMs - w.onMs > windows[b]!.offMs - windows[b]!.onMs ? i : b), 0);
      const w = windows[wi]!;
      const g = Math.round((w.onMs + w.offMs) / 2) + 7_000;
      [25, 140, 25].forEach((c, k) =>
        planned.push({ t: g + k * 5_000, evt: 'PERIODIC', window: wi, coolantOverrideC: c }),
      );
    }
  }

  planned.sort((a, b) => a.t - b.t || ORDER[a.evt] - ORDER[b.evt]);

  // ---- 2. signals --------------------------------------------------------------------------
  const s: VehicleState = { ...start };
  const events: SimEvent[] = [];
  type Phase = 'PARKED' | 'WARMUP' | 'DRIVING' | 'COOLDOWN';
  let phase: Phase = 'PARKED';
  let onMs = 0;
  let engineStartC = s.lastCoolantC;
  const lat0 = depot.lat;
  const lon0 = depot.lon;
  const kmPerDegLat = 111.2;
  const kmPerDegLon = 111.2 * Math.cos((lat0 * Math.PI) / 180);
  const cp = p.coolant;
  const energyScale = model.energyPctPerKm * v.profile.efficiency * Math.sqrt(v.profile.style);

  for (const e of planned) {
    const dtH = Math.max(0, e.t - s.lastEventMs) / HOUR_MS;
    const ambientBase = ambientAt(ctx, region, e.t);

    // interval since the previous message
    let speed = 0;
    let idleS = 0;
    if (phase === 'DRIVING') {
      speed = clamp(rng.normal(duty.speedKmh, duty.speedSdKmh), 0, duty.maxSpeedKmh);
      if (style < v.profile.style) speed *= 0.75; // gentle-driving day
      idleS = Math.round(dtH * 3600 * duty.idleFraction);
    } else if (phase === 'WARMUP' || phase === 'COOLDOWN') {
      idleS = Math.round(dtH * 3600);
    }
    const dist = speed * dtH;
    s.odoKm += dist;

    if (dist > 0) {
      // random walk around the depot, pulled back inside the duty radius
      const heading = rng.uniform(0, 2 * Math.PI);
      let dx = s.lon - lon0 + (Math.cos(heading) * dist * 0.3) / kmPerDegLon;
      let dy = s.lat - lat0 + (Math.sin(heading) * dist * 0.3) / kmPerDegLat;
      const rKm = Math.hypot(dx * kmPerDegLon, dy * kmPerDegLat);
      if (rKm > duty.radiusKm) {
        const f = (duty.radiusKm * rng.uniform(0.6, 0.95)) / rKm;
        dx *= f;
        dy *= f;
      }
      s.lon = lon0 + dx;
      s.lat = lat0 + dy;
      s.atDepot = false;
    }

    const penalty = 1 + 0.008 * Math.max(0, 15 - ambientBase) + 0.005 * Math.max(0, ambientBase - 30);
    if (pt === 'EV') {
      s.socPct = Math.max(5, s.socPct - dist * energyScale * penalty);
    } else if (pt === 'HYBRID' && phase !== 'PARKED') {
      s.socPct = clamp(s.socPct + 0.3 * (55 - s.socPct) + rng.normal(0, 1), 20, 90);
    } else if (pt === 'DIESEL') {
      s.fuelPct = Math.max(2, s.fuelPct - dist * energyScale);
    }
    let charging = false;
    if (phase === 'PARKED' && s.atDepot && pt === 'EV') {
      s.socPct = Math.min(100, s.socPct + p.chargeRatePctPerH * dtH);
    }

    // phase transition caused by this event
    if (e.evt === 'IGNITION_ON') {
      phase = 'WARMUP';
      onMs = e.t;
      const cool = Math.exp(-(e.t - s.lastOffMs) / (cp.cooldownTauMin * MINUTE_MS));
      engineStartC = ambientBase + (s.lastCoolantC - ambientBase) * cool;
    } else if (e.evt === 'TRIP_START') phase = 'DRIVING';
    else if (e.evt === 'TRIP_END') phase = 'COOLDOWN';

    const ignition = phase !== 'PARKED' && e.evt !== 'IGNITION_OFF';
    if (!ignition && pt === 'EV' && s.atDepot && s.socPct < 100) charging = true;
    if (e.evt === 'IGNITION_OFF' || e.evt === 'HEARTBEAT') {
      // at depot after the last window of the day
      if (e.evt === 'IGNITION_OFF' && windows[e.window]?.endsAtDepot) {
        const spot = parkingSpot(depot, rng);
        s.lat = spot.lat;
        s.lon = spot.lon;
        s.atDepot = true;
        charging = pt === 'EV' && s.socPct < 100;
      }
    }

    const ambientC = ambientBase + rng.normal(0, 0.3);

    let coolantC: number | null = null;
    let rpm: number | null = null;
    if (hasEngine && (ignition || e.evt === 'IGNITION_OFF')) {
      const target =
        cp.baseC +
        v.profile.coolantOffsetC +
        duty.load * cp.dutyLoadC +
        cp.ambientCoef * (ambientBase - 25) +
        cp.hotAmbientCoef * Math.max(0, ambientBase - cp.hotAmbientThresholdC) +
        (sc ? sc.coolantDeltaC(v.vin, e.t, repairAt) : 0);
      const warm = Math.exp(-(e.t - onMs) / (cp.warmupTauMin * MINUTE_MS));
      const engine = target + (engineStartC - target) * warm;
      if (ignition) {
        coolantC = clamp(engine + rng.normal(0, cp.noiseSdC), -40, 130);
        if (e.coolantOverrideC !== undefined) coolantC = e.coolantOverrideC;
        rpm = Math.round(phase === 'DRIVING' ? 900 + speed * 22 + rng.normal(0, 60) : 750 + rng.normal(0, 30));
      }
      if (e.evt === 'IGNITION_OFF') {
        s.lastCoolantC = engine;
        s.lastOffMs = e.t;
      }
    }

    let battTempC: number | null = null;
    if (hasHvBattery) {
      const offset = v.profile.battTempOffsetC;
      if (phase === 'DRIVING') {
        battTempC = ambientBase + 6 + duty.load * 2 * clamp(speed / duty.speedKmh, 0, 1.5) + offset;
      } else if (ignition) {
        battTempC = ambientBase + 4 + offset;
      } else {
        battTempC = ambientBase + 2 + offset + (charging ? 4 : 0);
      }
      battTempC += rng.normal(0, 0.5);
    }

    const lvBattV = ignition
      ? 14.1 + v.profile.lvOffsetV + rng.normal(0, 0.1)
      : 12.6 + v.profile.lvOffsetV + rng.normal(0, 0.07);

    s.seq += 1;
    s.lastEventMs = e.t;
    events.push({
      vin: v.vin,
      oemId: v.oemId,
      seq: s.seq,
      eventTs: e.t,
      evt: e.evt,
      lat: s.lat,
      lon: s.lon,
      speedKmh: speed,
      odoKm: s.odoKm,
      ambientC,
      coolantC,
      rpm,
      battTempC,
      socPct: hasHvBattery ? s.socPct : null,
      fuelPct: pt === 'DIESEL' ? s.fuelPct : null,
      lvBattV,
      ignition,
      charging,
      harshBrake: e.evt === 'HARSH_BRAKE' ? 1 : 0,
      harshAccel: e.evt === 'HARSH_ACCEL' ? 1 : 0,
      idleS,
      dtc: e.dtc ?? [],
      firmware: firmwareAt(v, e.t),
    });

    if (e.evt === 'IGNITION_OFF') {
      phase = 'PARKED';
      s.parkedSinceMs = e.t;
      // refuel at the stop / depot
      if (pt === 'DIESEL' && s.fuelPct < 50) s.fuelPct = 100;
    }
  }

  return { events, end: s };
}

// ---------------------------------------------------------------------------------------------
// Streams

/**
 * A vehicle's endless event stream starting at simulated time `fromMs`.
 * Days before `fromMs` are replayed (not emitted) so odometer, charge, fuel and seq carry over exactly.
 */
export class VehicleStream {
  private day: number;
  private state: VehicleState;
  private dayStartState: VehicleState;
  private events: SimEvent[] = [];
  private i = 0;

  constructor(
    readonly vehicle: Vehicle,
    private readonly ctx: WorldContext,
    fromMs: number,
  ) {
    const target = Math.max(0, dayIndexAt(ctx, fromMs));
    let state = initialState(vehicle, ctx);
    for (let d = 0; d < target; d++) state = generateVehicleDay(vehicle, d, state, ctx).end;
    this.state = state;
    this.dayStartState = state;
    this.day = target - 1;
    this.loadNextDay();
    // Skip events before fromMs: they happened in the simulated past, so they still count in seq.
    while (this.peek().eventTs < fromMs) this.i++;
  }

  private loadNextDay(): void {
    this.day += 1;
    this.dayStartState = this.state;
    const r = generateVehicleDay(this.vehicle, this.day, this.state, this.ctx);
    this.events = r.events;
    this.state = r.end;
    this.i = 0;
  }

  private ensure(): void {
    while (this.i >= this.events.length) this.loadNextDay();
  }

  peek(): SimEvent {
    this.ensure();
    return this.events[this.i]!;
  }

  next(): SimEvent {
    const e = this.peek();
    this.i++;
    return e;
  }

  /** Time of the last emitted event (or -Infinity before the first). */
  lastEmittedTs(): number {
    return this.i > 0 ? this.events[this.i - 1]!.eventTs : -Infinity;
  }

  /**
   * An external change (a repair) took effect: regenerate the rest of the current day.
   * The change only affects times after the last emitted event, and plant RNG streams are per hour,
   * so the already-emitted prefix is identical and seq stays contiguous.
   */
  regenerate(): void {
    const r = generateVehicleDay(this.vehicle, this.day, this.dayStartState, this.ctx);
    this.events = r.events;
    this.state = r.end;
  }
}

/** Min-heap merge of many vehicle streams by (eventTs, vehicle index). */
export class FleetStream {
  private readonly heap: VehicleStream[] = [];
  private readonly byVin = new Map<string, VehicleStream>();

  constructor(
    vehicles: readonly Vehicle[],
    private readonly ctx: WorldContext,
    fromMs: number,
  ) {
    for (const v of vehicles) {
      const s = new VehicleStream(v, ctx, fromMs);
      this.byVin.set(v.vin, s);
      this.push(s);
    }
  }

  has(vin: string): boolean {
    return this.byVin.has(vin);
  }

  /**
   * Apply a repair received at sim time `repairedAtMs`. It takes effect no earlier than the vehicle's
   * last emitted event (we cannot change what was already sent). Returns the effective time.
   */
  repair(vin: string, repairedAtMs: number): number | null {
    const s = this.byVin.get(vin);
    if (!s) return null;
    const effective = Math.max(repairedAtMs, s.lastEmittedTs());
    this.ctx.repairs.set(vin, effective);
    s.regenerate();
    // peek time may have changed: restore the heap property
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
    return effective;
  }

  get size(): number {
    return this.heap.length;
  }

  /** Earliest pending event time. */
  peekTs(): number {
    return this.heap.length ? this.heap[0]!.peek().eventTs : Infinity;
  }

  /** Emit every event with eventTs <= simTs, in (time, vehicle) order. */
  drainUntil(simTs: number, max = Infinity): SimEvent[] {
    const out: SimEvent[] = [];
    while (this.heap.length && out.length < max && this.heap[0]!.peek().eventTs <= simTs) {
      const top = this.heap[0]!;
      out.push(top.next());
      this.siftDown(0);
    }
    return out;
  }

  private less(a: VehicleStream, b: VehicleStream): boolean {
    const ta = a.peek().eventTs;
    const tb = b.peek().eventTs;
    return ta < tb || (ta === tb && a.vehicle.index < b.vehicle.index);
  }

  private push(s: VehicleStream): void {
    const h = this.heap;
    h.push(s);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
      if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
}
