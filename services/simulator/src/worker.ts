import { setTimeout as sleep } from 'node:timers/promises';
import { TelemetryProducer, createLogger, loadSimulatorConfigFile, type SimulatorConfig } from '@cw/common';
import {
  FleetStream,
  SimClock,
  VehicleStream,
  encodeForOem,
  makeWorldContext,
  messUp,
  workerRange,
  type OutMessage,
  type SimEvent,
  type SimParams,
} from '@cw/domain';
import { configPath } from './config-path.js';
import { writeHistoryRange, type HistorySpec } from './history.js';
import {
  BENCH_SPEC_ENV,
  BENCH_TOPIC,
  HISTORY_SPEC_ENV,
  REPAIRS_ENV,
  SIM_START_ENV,
  SPEED_ENV,
  WORKER_INDEX_ENV,
  WORKER_MODE_ENV,
  type BenchSpec,
  type MainMessage,
  type WorkerMessage,
} from './ipc.js';
import { Lake } from './lake.js';
import { buildWorld } from './world.js';

const index = Number(process.env[WORKER_INDEX_ENV]);
const send = (m: WorkerMessage) => process.send?.(m);

/** Min-heap of outgoing messages by release time (sim ms), FIFO among equal times. */
class ReleaseQueue {
  private heap: { m: OutMessage; n: number }[] = [];
  private counter = 0;
  get size(): number {
    return this.heap.length;
  }
  push(m: OutMessage): void {
    const h = this.heap;
    h.push({ m, n: this.counter++ });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  popUntil(t: number, max: number): OutMessage[] {
    const out: OutMessage[] = [];
    const h = this.heap;
    while (h.length && out.length < max && h[0]!.m.releaseMs <= t) {
      out.push(h[0]!.m);
      const last = h.pop()!;
      if (h.length) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
          if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
          if (m === i) break;
          [h[i], h[m]] = [h[m]!, h[i]!];
          i = m;
        }
      }
    }
    return out;
  }
  private less(a: { m: OutMessage; n: number }, b: { m: OutMessage; n: number }): boolean {
    return a.m.releaseMs < b.m.releaseMs || (a.m.releaseMs === b.m.releaseMs && a.n < b.n);
  }
}

function waitFor<T extends MainMessage['type']>(type: T): Promise<Extract<MainMessage, { type: T }>> {
  return new Promise((resolve) => {
    const on = (m: MainMessage) => {
      if (m.type === type) {
        process.off('message', on);
        resolve(m as Extract<MainMessage, { type: T }>);
      }
    };
    process.on('message', on);
  });
}

function producerFor(cfg: SimulatorConfig): TelemetryProducer {
  return new TelemetryProducer({
    brokers: cfg.kafka.brokers,
    clientId: `${cfg.kafka.clientId}-${index}`,
    lingerMs: cfg.kafka.lingerMs,
  });
}

// ------------------------------------------------------------------------------------------------
// Stream mode (demo 360x / live 1x): plants, mess, repairs

async function stream(cfg: SimulatorConfig): Promise<void> {
  const log = createLogger(`simulator.worker-${index}`, cfg.logLevel);
  const started = Date.now();
  const world = buildWorld(cfg);
  const { registry, params, scenario, mess } = world;
  const simStart = Number(process.env[SIM_START_ENV]);
  const speed = Number(process.env[SPEED_ENV]);
  const ctx = makeWorldContext(registry, params, scenario.enabled ? scenario : undefined);
  for (const [vin, at] of JSON.parse(process.env[REPAIRS_ENV] ?? '[]') as [string, number][]) ctx.repairs.set(vin, at);
  const { start, end } = workerRange(registry.n, cfg.workers, index);
  const fleet = new FleetStream(registry.vehicles.slice(start, end), ctx, simStart);
  const producer = producerFor(cfg);
  await producer.connect();

  const pendingRepairs: { vin: string; repairedAtMs: number }[] = [];
  let clock: SimClock | null = null;
  let pausedAt: number | null = null; // a pause that arrives before 'start' is applied at start
  process.on('message', (m: MainMessage) => {
    if (m.type === 'repair') pendingRepairs.push(m);
    else if (m.type === 'pause') {
      if (clock) clock.pause(m.atWallMs);
      else pausedAt = m.atWallMs;
    } else if (m.type === 'resume') {
      if (clock) clock.resume(m.atWallMs);
      else pausedAt = null;
    }
  });

  send({ type: 'ready', worker: index, vehicles: end - start, startupMs: Date.now() - started });
  const { wallStartMs } = await waitFor('start');
  clock = new SimClock(simStart, speed, wallStartMs);
  if (pausedAt !== null) clock.pause(Math.max(pausedAt, wallStartMs));
  log.info(
    { vins: [start, end], startupMs: Date.now() - started, simStart: new Date(simStart).toISOString(), speed },
    'worker streaming',
  );

  const queue = new ReleaseQueue();
  let running = true;
  const stop = () => (running = false);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('disconnect', stop);
  const MAX_GEN = 50_000;

  while (running) {
    while (pendingRepairs.length) {
      const r = pendingRepairs.shift()!;
      const effectiveMs = fleet.repair(r.vin, r.repairedAtMs);
      if (effectiveMs !== null) send({ type: 'repair-applied', worker: index, vin: r.vin, effectiveMs });
    }
    const simNow = clock.now();
    const due = fleet.drainUntil(simNow, MAX_GEN);
    const messCounts: Record<string, number> = {};
    for (const e of due) {
      for (const m of messUp(e, mess)) {
        queue.push(m);
        for (const k of m.kinds) {
          // count each mess kind once per original message (duplicates counted by the copy)
          if (k !== 'duplicate' && m.kinds.includes('duplicate')) continue;
          messCounts[k] = (messCounts[k] ?? 0) + 1;
        }
      }
    }
    const next = fleet.peekTs();
    const lagS = next < simNow ? (simNow - next) / speed / 1000 : 0;
    const release = queue.popUntil(simNow, 200_000);
    const counts: Record<string, number> = {};
    for (let i = 0; i < release.length; i += 20_000) {
      const batch = release.slice(i, i + 20_000);
      try {
        await producer.send(batch);
      } catch (err) {
        send({ type: 'send-error', worker: index, error: String(err) });
        log.error({ err }, 'kafka send failed');
        throw err;
      }
      for (const m of batch) counts[`${m.topic}|${m.format}`] = (counts[`${m.topic}|${m.format}`] ?? 0) + 1;
    }
    send({ type: 'sent', worker: index, counts, mess: messCounts, simTs: simNow, lagS, queued: queue.size });
    if (due.length < MAX_GEN) await sleep(cfg.tickMs);
  }
  await producer.disconnect();
}

// ------------------------------------------------------------------------------------------------
// History mode

async function history(cfg: SimulatorConfig): Promise<void> {
  const spec = JSON.parse(process.env[HISTORY_SPEC_ENV]!) as HistorySpec;
  const overrides: Partial<SimParams> = { historyDays: spec.days, cadenceMin: spec.intervalMin };
  const world = buildWorld(cfg, overrides);
  const lake = new Lake(cfg.lake);
  const r = await writeHistoryRange(world, lake, spec, index, cfg.workers, (day, rows) =>
    send({ type: 'history-progress', worker: index, day, rows }),
  );
  send({ type: 'history-done', worker: index, ...r });
}

// ------------------------------------------------------------------------------------------------
// Bench mode: every vehicle once per wall second (x multiplier); realism ignored, throughput measured.

async function bench(cfg: SimulatorConfig): Promise<void> {
  const spec = JSON.parse(process.env[BENCH_SPEC_ENV]!) as BenchSpec;
  const world = buildWorld(cfg);
  const { registry, params } = world;
  const { start, end } = workerRange(registry.n, cfg.workers, index);
  const ctx = makeWorldContext(registry, params);
  // One realistic template event per vehicle; bench then mutates seq/time/signals cheaply.
  const templates: SimEvent[] = registry.vehicles
    .slice(start, end)
    .map((v) => ({ ...new VehicleStream(v, ctx, registry.t0Ms).peek(), evt: 'PERIODIC' }));
  const producer = producerFor(cfg);
  await producer.connect();
  send({ type: 'ready', worker: index, vehicles: templates.length, startupMs: 0 });

  const totalS = spec.phases.reduce((a, p) => a + p.seconds, 0);
  const multiplierAt = (s: number) => {
    let acc = 0;
    for (const p of spec.phases) if (s < (acc += p.seconds)) return p.multiplier;
    return 0;
  };
  let cursor = 0;
  let owed = 0;
  let lastSecond = -1;
  const BATCH = 5_000;
  const inflight: Promise<void>[] = [];
  while (true) {
    const elapsedS = (Date.now() - spec.wallStartMs) / 1000;
    if (elapsedS >= totalS) break;
    if (elapsedS < 0) {
      // not started yet: nothing is owed before the common start time
      await sleep(20);
      continue;
    }
    const second = Math.floor(elapsedS);
    if (second !== lastSecond) {
      owed += Math.round(templates.length * multiplierAt(second));
      lastSecond = second;
    }
    if (owed <= 0) {
      await sleep(5);
      continue;
    }
    const n = Math.min(owed, BATCH);
    const now = Date.now();
    const batch = [];
    for (let k = 0; k < n; k++) {
      const t = templates[cursor]!;
      cursor = (cursor + 1) % templates.length;
      t.seq += 1;
      t.eventTs = now;
      t.odoKm += 0.01;
      batch.push({ ...encodeForOem(t), topic: BENCH_TOPIC });
    }
    const t0 = performance.now();
    owed -= n;
    const p = producer.send(batch).then(() => {
      send({ type: 'bench', worker: index, sent: n, batchMs: [performance.now() - t0] });
    });
    inflight.push(p);
    // keep up to 8 batches in flight per worker (acks are awaited, never dropped)
    if (inflight.length >= 8) await inflight.shift();
  }
  await Promise.all(inflight);
  await producer.disconnect();
}

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const mode = process.env[WORKER_MODE_ENV];
  if (mode === 'history') await history(cfg);
  else if (mode === 'bench') await bench(cfg);
  else await stream(cfg);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
