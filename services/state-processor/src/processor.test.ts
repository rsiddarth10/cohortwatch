import { DEFAULT_DETECT, IncidentMessageSchema, PeerContext, type CanonicalEvent } from '@cw/domain';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { detectParamsFrom } from './config.js';
import { PartitionState, processBatch, type InEvent } from './processor.js';
import { RegistryCache, placementAt, type VanInfo } from './registry.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 28, 4);
const SICK = 'SICKVAN0000000001';
const WELL = 'WELLVAN0000000002';

function registry(): RegistryCache {
  const r = new RegistryCache(null as unknown as pg.Pool);
  const van = (depotLater: boolean): VanInfo => ({
    modelId: 6,
    dutyId: 1,
    assignments: depotLater
      ? [
          { depotId: 10, regionId: 3, from: -Infinity, to: T0 + 30 * HOUR },
          { depotId: 11, regionId: 3, from: T0 + 30 * HOUR, to: Infinity },
        ]
      : [{ depotId: 10, regionId: 3, from: -Infinity, to: Infinity }],
    baseline: {
      metrics: { coolant_c: { median: 90, mad: 0.4, slopeMedian: 0, slopeMad: 0.1, source: 'VAN' } },
      dtcPerDay: {},
    },
  });
  r.vans.set(SICK, van(true));
  r.vans.set(WELL, van(false));
  return r;
}

function ev(vin: string, seq: number, h: number, coolant: number): InEvent {
  const event: CanonicalEvent = {
    event_id: '00000000-0000-5000-8000-000000000000',
    vin,
    seq,
    event_ts: new Date(T0 + h * HOUR).toISOString(),
    evt: 'PERIODIC',
    lat: null,
    lon: null,
    speed_kmh: 45,
    odo_km: null,
    ambient_c: 30,
    coolant_c: coolant,
    rpm: null,
    batt_temp_c: null,
    soc_pct: null,
    fuel_pct: null,
    lv_batt_v: 14.1,
    ignition: true,
    charging: false,
    harsh_brake: null,
    harsh_accel: null,
    idle_s: null,
    dtc: [],
    fault_families: [],
    firmware: '4.2.1',
    source_format: 'kestrel.v1',
    quality_flags: [],
  };
  return { event, sentAt: 1000 };
}

function stream(): InEvent[] {
  const out: InEvent[] = [];
  for (let i = 0; i < 120; i++) {
    const h = i / 2;
    out.push(ev(SICK, i + 1, h, 90 + Math.min(Math.max(0, h - 6) * 0.4, 12) + Math.sin(i) * 0.3));
    out.push(ev(WELL, i + 1, h, 90 + Math.sin(i * 1.3) * 0.3));
    out.push(ev('NOTINREGISTRY0000', i + 1, h, 90));
  }
  return out;
}

describe('processBatch', () => {
  const env = () => ({ params: DEFAULT_DETECT, registry: registry(), peers: new PeerContext(2, 10) });

  it('one incident for the sick van only, with family key, snapshot fields and a valid message', () => {
    const ps = new PartitionState();
    const out = processBatch(ps, stream(), env());
    const opens = out.incidents.filter((i) => i.message.action === 'OPEN');
    expect(opens).toHaveLength(1);
    const m = opens[0]!.message;
    expect(IncidentMessageSchema.parse(m)).toEqual(m);
    expect(m).toMatchObject({ vin: SICK, fault_family: 'COOLING', family_key: 'COOLING|6|1|10', depot_id: 10 });
    expect(m.firmware).toBe('4.2.1');
    expect(m.baseline_source).toBe('VAN');
    expect(m.last_code).toBeNull();
    expect(out.scores.filter(Boolean).length).toBeGreaterThan(100);
    expect(out.unknownVin).toBe(120);
    expect(ps.dirty).toBe(true);
  });

  it('a replay of the same events (after a restart from a checkpoint) adds nothing', () => {
    const ps = new PartitionState();
    const e = env();
    const events = stream();
    processBatch(ps, events.slice(0, 150), e);
    const restored = new PartitionState();
    const snap = JSON.parse(ps.snapshot()) as { vans: Record<string, never> };
    for (const [vin, st] of Object.entries(snap.vans)) restored.vans.set(vin, st);
    const replay = processBatch(restored, events.slice(0, 150), e);
    expect(replay.applied).toBe(0);
    expect(replay.incidents).toEqual([]);
    const rest = processBatch(restored, events.slice(150), e);
    expect(rest.applied).toBeGreaterThan(0);
  });

  it('serialises batch and checkpoint work per partition', async () => {
    const ps = new PartitionState();
    const order: string[] = [];
    const a = ps.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('batch');
    });
    const b = ps.run(() => order.push('checkpoint'));
    await Promise.all([a, b]);
    expect(order).toEqual(['batch', 'checkpoint']);
    await expect(ps.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await ps.run(() => 7)).toBe(7);
  });
});

describe('repair resets the trend (S6)', () => {
  it('after a repair the van is judged on post-repair readings only', () => {
    const env0 = { params: DEFAULT_DETECT, registry: registry(), peers: new PeerContext(2, 10) };
    const ps = new PartitionState();
    processBatch(ps, stream().slice(0, 150), env0); // the sick van is +8 °C by now
    const before = ps.vans.get(SICK)!.m.coolant_c!.slow;
    expect(before.Sy / before.S).toBeGreaterThan(93);
    const repairs = new Map([[SICK, T0 + 30 * HOUR]]);
    const healthy = Array.from({ length: 10 }, (_, i) => ev(SICK, 500 + i, 31 + i / 2, 90));
    processBatch(ps, healthy, { ...env0, repairs });
    const after = ps.vans.get(SICK)!;
    expect(after.repairTs).toBe(T0 + 30 * HOUR);
    expect(after.m.coolant_c!.slow.Sy / after.m.coolant_c!.slow.S).toBeCloseTo(90, 0);
  });
});

describe('registry placement and config', () => {
  it('depot at event time follows the assignment ranges', () => {
    const v = registry().get(SICK)!;
    expect(placementAt(v, T0)!.depotId).toBe(10);
    expect(placementAt(v, T0 + 31 * HOUR)!.depotId).toBe(11);
    expect(placementAt({ ...v, assignments: [] }, T0)).toBeUndefined();
  });

  it('detection thresholds are overridable from env', () => {
    const p = detectParamsFrom({ DETECT_K: '3', DETECT_N: '5', GLOBAL_COOLANT_THRESHOLD_C: '99' });
    expect([p.k, p.n, p.metrics.coolant_c.globalThreshold]).toEqual([3, 5, 99]);
    expect(detectParamsFrom({}).tauH).toBe(12);
  });
});
