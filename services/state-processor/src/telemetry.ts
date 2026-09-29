import { qualifyingValue, type DetectParams, type Metric } from '@cw/domain';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import type { StateMetrics } from './metrics.js';
import type { InEvent } from './processor.js';

/**
 * Telemetry writer (S3, ADR 0008): down-samples canonical readings to one row per van per bucket
 * (TELEMETRY_BUCKET_MIN sim-minutes, default 60) in the core.telemetry hypertable, for the "van vs its own
 * normal" chart. Temperatures and 12 V are means of the readings detection uses (driving, unflagged), so the
 * chart and the baseline band compare like with like.
 *
 * A bucket closes when the van's next reading falls in a later bucket, or when the partition's event time has
 * moved a full bucket past it (a parked van). Closed rows are written by COPY into a staging table and
 * `INSERT … ON CONFLICT DO NOTHING`, so a replay after a restart never duplicates a row. Open buckets are not
 * checkpointed: after a restart or a partition move the bucket in progress is rebuilt from the replay.
 */

interface Bucket {
  start: number;
  n: number;
  sums: Record<Metric, number>;
  counts: Record<Metric, number>;
  maxCoolant: number | null;
  maxBatt: number | null;
  soc: number | null;
  ambSum: number;
  ambN: number;
  spdSum: number;
  spdN: number;
  dtc: number;
}

const newBucket = (start: number): Bucket => ({
  start,
  n: 0,
  sums: { coolant_c: 0, batt_temp_c: 0, lv_batt_v: 0 },
  counts: { coolant_c: 0, batt_temp_c: 0, lv_batt_v: 0 },
  maxCoolant: null,
  maxBatt: null,
  soc: null,
  ambSum: 0,
  ambN: 0,
  spdSum: 0,
  spdN: 0,
  dtc: 0,
});

const mean = (b: Bucket, m: Metric) => (b.counts[m] > 0 ? b.sums[m] / b.counts[m] : null);
const cell = (x: number | null) => (x === null || !Number.isFinite(x) ? '\\N' : String(Math.round(x * 1000) / 1000));

function row(vin: string, b: Bucket): string {
  return [
    vin,
    new Date(b.start).toISOString(),
    String(Math.min(b.n, 32767)),
    cell(mean(b, 'coolant_c')),
    cell(b.maxCoolant),
    cell(mean(b, 'batt_temp_c')),
    cell(b.maxBatt),
    cell(mean(b, 'lv_batt_v')),
    cell(b.soc),
    cell(b.ambN > 0 ? b.ambSum / b.ambN : null),
    cell(b.spdN > 0 ? b.spdSum / b.spdN : null),
    String(Math.min(b.dtc, 32767)),
  ].join('\t');
}

const COLUMNS =
  'vin, ts, readings, coolant_c, coolant_max_c, batt_temp_c, batt_temp_max_c, lv_batt_v, soc_pct, ambient_c, speed_kmh, dtc_count';

export class TelemetryWriter {
  private readonly open = new Map<number, Map<string, Bucket>>();
  private readonly watermark = new Map<number, number>();
  private queue: string[] = [];
  private writing: Promise<void> | null = null;
  private readonly timer: NodeJS.Timeout;
  private readonly bucketMs: number;

  constructor(
    private readonly pool: pg.Pool,
    bucketMin: number,
    private readonly params: DetectParams,
    private readonly metrics: StateMetrics,
    flushMs: number,
    private readonly onError: (err: unknown) => void,
  ) {
    this.bucketMs = bucketMin * 60_000;
    this.timer = setInterval(() => void this.flush(), flushMs);
  }

  /** Closed rows waiting to be written (back-pressure signal). */
  pending(): number {
    return this.queue.length;
  }

  add(partition: number, events: readonly InEvent[]): void {
    let open = this.open.get(partition);
    if (!open) this.open.set(partition, (open = new Map()));
    let wm = this.watermark.get(partition) ?? 0;
    for (const { event: e } of events) {
      const ts = Date.parse(e.event_ts);
      if (!Number.isFinite(ts)) continue;
      const start = Math.floor(ts / this.bucketMs) * this.bucketMs;
      let b = open.get(e.vin);
      if (b && start > b.start) {
        this.queue.push(row(e.vin, b));
        b = undefined;
      } else if (b && start < b.start) continue; // older than the open bucket (late): the chart keeps its row
      if (!b) open.set(e.vin, (b = newBucket(start)));
      if (ts > wm) wm = ts;
      b.n++;
      const ev = {
        evt: e.evt,
        ignition: e.ignition,
        charging: e.charging,
        speedKmh: e.speed_kmh,
        ts,
        flags: e.quality_flags,
        values: { coolant_c: e.coolant_c, batt_temp_c: e.batt_temp_c, lv_batt_v: e.lv_batt_v },
      } as Parameters<typeof qualifyingValue>[0];
      for (const m of ['coolant_c', 'batt_temp_c', 'lv_batt_v'] as const) {
        const y = qualifyingValue(ev, m, -1, this.params); // PERIODIC readings start a cadence after ignition
        if (y === null) continue;
        b.sums[m] += y;
        b.counts[m]++;
        if (m === 'coolant_c') b.maxCoolant = Math.max(b.maxCoolant ?? y, y);
        if (m === 'batt_temp_c') b.maxBatt = Math.max(b.maxBatt ?? y, y);
      }
      if (e.soc_pct !== null) b.soc = e.soc_pct;
      if (e.ambient_c !== null) {
        b.ambSum += e.ambient_c;
        b.ambN++;
      }
      if (e.speed_kmh !== null && e.ignition) {
        b.spdSum += e.speed_kmh;
        b.spdN++;
      }
      b.dtc += e.dtc.length;
    }
    this.watermark.set(partition, wm);
    // parked vans: close buckets the partition's event time has left behind
    for (const [vin, b] of open) {
      if (b.start + 2 * this.bucketMs <= wm) {
        this.queue.push(row(vin, b));
        open.delete(vin);
      }
    }
    this.metrics.telemetryPending.set(this.queue.length);
  }

  /** A revoked partition's open buckets are rebuilt by its new owner from the replay. */
  dropPartition(partition: number): void {
    this.open.delete(partition);
    this.watermark.delete(partition);
  }

  flush(): Promise<void> {
    if (this.writing || this.queue.length === 0) return this.writing ?? Promise.resolve();
    const rows = this.queue;
    this.queue = [];
    this.writing = this.write(rows)
      .then(() => {
        this.metrics.telemetryRows.inc(rows.length);
      })
      .catch((err: unknown) => {
        this.queue = rows.concat(this.queue); // retry next round
        this.onError(err);
      })
      .finally(() => {
        this.writing = null;
        this.metrics.telemetryPending.set(this.queue.length);
      });
    return this.writing;
  }

  private async write(rows: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE tel_stage (LIKE core.telemetry) ON COMMIT DROP');
      await new Promise<void>((resolve, reject) => {
        const stream = client.query(copyFrom(`COPY tel_stage (${COLUMNS}) FROM STDIN`));
        stream.on('finish', resolve).on('error', reject);
        stream.end(rows.join('\n') + '\n');
      });
      await client.query(
        `INSERT INTO core.telemetry (${COLUMNS}) SELECT ${COLUMNS} FROM tel_stage ON CONFLICT DO NOTHING`,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Crash emulation: stop flushing, keep nothing. */
  abort(): void {
    clearInterval(this.timer);
    this.queue = [];
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const [p, open] of this.open) {
      for (const [vin, b] of open) this.queue.push(row(vin, b));
      this.open.delete(p);
    }
    await this.writing;
    await this.flush();
  }
}
