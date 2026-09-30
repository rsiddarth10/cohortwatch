import { DEFAULT_DETECT, type CanonicalEvent } from '@cw/domain';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { StateMetrics } from './metrics.js';
import { TelemetryWriter } from './telemetry.js';

const T0 = Date.UTC(2026, 8, 28, 4);
const MIN = 60_000;

function ev(vin: string, min: number, coolant: number | null, x: Partial<CanonicalEvent> = {}) {
  return {
    event: {
      vin,
      seq: min,
      event_ts: new Date(T0 + min * MIN).toISOString(),
      evt: 'PERIODIC',
      speed_kmh: 40,
      ambient_c: 30,
      coolant_c: coolant,
      batt_temp_c: null,
      soc_pct: null,
      lv_batt_v: 14.1,
      ignition: true,
      charging: false,
      dtc: [],
      harsh_brake: null,
      harsh_accel: null,
      idle_s: null,
      quality_flags: [],
      ...x,
    } as unknown as CanonicalEvent,
    sentAt: null,
  };
}

const failingPool = () => ({ connect: () => Promise.reject(new Error('db down')) }) as unknown as pg.Pool;

describe('TelemetryWriter bucketing', () => {
  it('closes a van bucket when its next reading is in a later bucket, and parked vans by event time', async () => {
    const errors: unknown[] = [];
    const w = new TelemetryWriter(failingPool(), 60, DEFAULT_DETECT, new StateMetrics(), 60_000, (e) => errors.push(e));
    w.add(0, [ev('A', 0, 90), ev('A', 30, 92), ev('B', 10, 88, { evt: 'HEARTBEAT', ignition: false })]);
    expect(w.pending()).toBe(0);
    w.add(0, [ev('A', 65, 91)]); // A moves to the next hour → its first hour closes
    expect(w.pending()).toBe(1);
    w.add(0, [ev('A', 190, 91)]); // event time 2 buckets past B's → B (parked) closes too, and A's second hour
    expect(w.pending()).toBe(3);
    w.add(0, [ev('A', 100, 99)]); // older than A's open bucket: ignored
    expect(w.pending()).toBe(3);
    await w.flush();
    expect(errors).toHaveLength(1);
    expect(w.pending()).toBe(3); // failed rows are kept for the next round
    w.dropPartition(0);
    await w.close();
    expect(w.pending()).toBe(3);
  });

  it('writes rows through COPY + insert-on-conflict', async () => {
    const queries: string[] = [];
    const end = vi.fn();
    const client = {
      query: vi.fn((q: unknown) => {
        if (typeof q === 'string') {
          queries.push(q);
          return Promise.resolve({});
        }
        // COPY stream: emulate pg-copy-streams' writable
        const stream = { on: (e: string, f: () => void) => (e === 'finish' && setTimeout(f, 0), stream), end };
        return stream;
      }),
      release: vi.fn(),
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
    const w = new TelemetryWriter(pool, 60, DEFAULT_DETECT, new StateMetrics(), 60_000, () => undefined);
    const score = [{ metric: 'coolant_c' as const, ts: T0, adjDev: 1.5, zLevel: 2, zSlope: 0.5 }];
    w.add(1, [ev('A', 0, 90), ev('A', 70, 91)], [score]);
    await w.flush();
    expect(w.pending()).toBe(0);
    expect(queries.some((q) => q.includes('ON CONFLICT DO NOTHING'))).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT');
    const line = String(end.mock.calls[0]![0]).split('\n')[0]!.split('\t');
    expect(line).toHaveLength(23); // 12 values + 9 score columns + harsh + idle
    expect(line.slice(21)).toEqual(['\\N', '0']); // this OEM reports no harsh counts: unknown, not 0
    expect(line.slice(12, 15)).toEqual(['1.5', '2', '0.5']); // coolant dev, z, zs
    await w.close();
  });
});
