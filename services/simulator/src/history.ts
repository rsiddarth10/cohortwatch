import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayIndexAt, dayStartMs, generateVehicleDay, initialState, makeWorldContext, workerRange } from '@cw/domain';
import type { World } from './world.js';
import type { Lake } from './lake.js';
import { EVENT_SELECT, EVENT_TABLE_DDL, appendEvent, copyToParquet, openDuck } from './parquet.js';

export interface HistorySpec {
  /** Key prefix in the lake, e.g. "history/" (default) or "history-big/". */
  prefix: string;
  days: number;
  intervalMin: number;
}

export interface HistoryManifest {
  seed: string;
  n: number;
  t0: string;
  days: number;
  intervalMin: number;
  registryHash: string;
  rows: number;
  files: number;
  fromTs: string;
  toTs: string;
  generatedAt: string;
  wallSeconds: number;
  plants: 'none (history is plant-free)';
}

export const manifestKey = (prefix: string) => `${prefix}_manifest.json`;
export const dtOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One history worker: its VIN range, day by day (bounded memory), plant-free and mess-free,
 * written as Parquet per sim-day and uploaded to s3://<bucket>/<prefix>dt=YYYY-MM-DD/part-wNN.parquet.
 */
export async function writeHistoryRange(
  world: World,
  lake: Lake,
  spec: HistorySpec,
  worker: number,
  workers: number,
  progress: (day: number, rows: number) => void,
): Promise<{ rows: number; files: number }> {
  const { registry, params } = world;
  // History is plant-free: no scenario hooks (the firmware rollout is registry data and stays).
  const ctx = makeWorldContext(registry, params);
  const { start, end } = workerRange(registry.n, workers, worker);
  const vehicles = registry.vehicles.slice(start, end);
  const states = vehicles.map((v) => initialState(v, ctx));
  const t0 = registry.t0Ms;
  const lastDay = dayIndexAt(ctx, t0 - 1);
  const dir = mkdtempSync(join(tmpdir(), `cw-history-w${worker}-`));
  const { instance, conn } = await openDuck();
  let rows = 0;
  let files = 0;
  try {
    await conn.run(EVENT_TABLE_DDL);
    for (let day = 0; day <= lastDay; day++) {
      await conn.run('DELETE FROM ev');
      const a = await conn.createAppender('ev');
      let dayRows = 0;
      for (let i = 0; i < vehicles.length; i++) {
        const r = generateVehicleDay(vehicles[i]!, day, states[i]!, ctx);
        states[i] = r.end;
        for (const e of r.events) {
          if (e.eventTs >= t0) break; // history ends at T0
          appendEvent(a, e);
          dayRows++;
        }
      }
      a.closeSync();
      if (dayRows > 0) {
        const dt = dtOf(dayStartMs(ctx, day));
        const local = join(dir, `dt=${dt}`);
        mkdirSync(local, { recursive: true });
        const file = join(local, `part-w${String(worker).padStart(2, '0')}.parquet`);
        await copyToParquet(conn, `${EVENT_SELECT} ORDER BY vin, seq`, file);
        await lake.uploadFile(`${spec.prefix}dt=${dt}/part-w${String(worker).padStart(2, '0')}.parquet`, file);
        rmSync(file);
        files++;
      }
      rows += dayRows;
      progress(day, dayRows);
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
    rmSync(dir, { recursive: true, force: true });
  }
  return { rows, files };
}
