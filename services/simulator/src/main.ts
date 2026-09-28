import { fork, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  TelemetryProducer,
  consumeTopic,
  createLogger,
  loadSimulatorConfigFile,
  type Logger,
  type SimulatorConfig,
} from '@cw/common';
import { HOUR_MS, SimClock, workerRange } from '@cw/domain';
import pg from 'pg';
import { configPath } from './config-path.js';
import { dtOf, manifestKey, type HistoryManifest, type HistorySpec } from './history.js';
import {
  BENCH_SPEC_ENV,
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
import { SimMetrics } from './metrics.js';
import { applyPlants, recordRepairOutcome } from './plants-db.js';
import { REPAIRS_TOPIC, parseRepair, repairMessage } from './repairs.js';
import { seedRegistry } from './seed.js';
import { buildWorld, type World } from './world.js';

type Mode = 'demo' | 'live' | 'history' | 'bench' | 'reset';

interface Args {
  mode: Mode;
  reset: boolean;
  burst: boolean;
  durationS: number;
  days: number | null;
  intervalMin: number | null;
}

export function parseArgs(argv: string[], defaultMode: 'demo' | 'live'): Args {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : null;
  };
  const first = argv.find((a) => !a.startsWith('--') && Number.isNaN(Number(a)));
  const mode = (['demo', 'live', 'history', 'bench', 'reset'].includes(first ?? '') ? first : defaultMode) as Mode;
  return {
    mode,
    reset: flag('reset'),
    burst: flag('burst'),
    durationS: value('duration') ?? 120,
    days: value('days'),
    intervalMin: value('interval-min'),
  };
}

const WORKER_FILE = fileURLToPath(new URL('./worker.js', import.meta.url));

function forkWorkers(cfg: SimulatorConfig, mode: string, env: Record<string, string>): ChildProcess[] {
  return Array.from({ length: cfg.workers }, (_, i) =>
    fork(WORKER_FILE, [], {
      env: { ...process.env, ...env, [WORKER_INDEX_ENV]: String(i), [WORKER_MODE_ENV]: mode },
    }),
  );
}

const sinceT0 = (world: World, t: number) =>
  `T0${t >= world.registry.t0Ms ? '+' : ''}${((t - world.registry.t0Ms) / HOUR_MS).toFixed(1)}h`;

// ------------------------------------------------------------------------------------------------
// History

async function ensureHistory(
  cfg: SimulatorConfig,
  world: World,
  lake: Lake,
  spec: HistorySpec,
  log: Logger,
  force: boolean,
): Promise<void> {
  const want = { seed: cfg.seed, n: cfg.scale, t0: cfg.t0, days: spec.days, intervalMin: spec.intervalMin };
  const existing = await lake.getJson<HistoryManifest>(manifestKey(spec.prefix));
  if (
    !force &&
    existing &&
    existing.registryHash === world.registryHash &&
    existing.days === want.days &&
    existing.intervalMin === want.intervalMin
  ) {
    log.info(
      { prefix: spec.prefix, rows: existing.rows, files: existing.files },
      'history already in the lake; skipping',
    );
    return;
  }
  const removed = await lake.deletePrefix(spec.prefix);
  const started = Date.now();
  log.info({ ...spec, bucket: lake.bucket, removedObjects: removed, workers: cfg.workers }, 'writing history');
  const workers = forkWorkers(cfg, 'history', { [HISTORY_SPEC_ENV]: JSON.stringify(spec) });
  let rows = 0;
  let files = 0;
  const progress = new Map<number, number>();
  await Promise.all(
    workers.map(
      (w, i) =>
        new Promise<void>((resolve, reject) => {
          w.on('message', (m: WorkerMessage) => {
            if (m.type === 'history-progress') {
              progress.set(i, m.day);
              rows += m.rows;
            } else if (m.type === 'history-done') files += m.files;
          });
          w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`history worker ${i} exited ${code}`))));
        }),
    ),
  );
  const t0 = Date.parse(cfg.t0);
  const manifest: HistoryManifest = {
    ...want,
    registryHash: world.registryHash,
    rows,
    files,
    fromTs: new Date(world.registry.epochMs).toISOString(),
    toTs: new Date(t0).toISOString(),
    generatedAt: new Date().toISOString(),
    wallSeconds: Math.round((Date.now() - started) / 1000),
    plants: 'none (history is plant-free)',
  };
  await lake.putJson(manifestKey(spec.prefix), manifest);
  log.info(
    { rows, files, wallSeconds: manifest.wallSeconds, days: `${dtOf(world.registry.epochMs)}..${dtOf(t0 - 1)}` },
    'history written',
  );
}

// ------------------------------------------------------------------------------------------------
// Streaming (demo / live)

async function runStream(cfg: SimulatorConfig, world: World, mode: 'demo' | 'live', client: pg.Client, log: Logger) {
  const t0 = world.registry.t0Ms;
  const speed = mode === 'demo' ? cfg.speed : 1;
  const state = await client.query<{
    scenario_hash: string;
    mode: string;
    sim_ts: Date;
    auto_repairs_done: boolean;
    transfers_done: boolean;
  }>('SELECT * FROM sim.run_state');
  const prev = state.rows[0];
  let simStart: number;
  if (mode === 'live') simStart = Date.now();
  else if (prev && prev.scenario_hash === world.scenarioHash && prev.mode === 'demo') simStart = prev.sim_ts.getTime();
  else simStart = t0;
  let autoRepairsDone = prev?.scenario_hash === world.scenarioHash ? prev.auto_repairs_done : false;
  let transfersDone = prev?.scenario_hash === world.scenarioHash ? prev.transfers_done : false;
  await client.query(
    `INSERT INTO sim.run_state (id, scenario_hash, mode, speed, sim_ts, auto_repairs_done, transfers_done)
     VALUES (true, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET scenario_hash = $1, mode = $2, speed = $3, sim_ts = $4, updated_at = now()`,
    [world.scenarioHash, mode, speed, new Date(simStart).toISOString(), autoRepairsDone, transfersDone],
  );
  const repairs = (
    await client.query<{ vin: string; effective_at: Date }>('SELECT vin, effective_at FROM sim.repair_log')
  ).rows.map((r) => [r.vin, r.effective_at.getTime()] as [string, number]);
  log.info(
    {
      mode,
      speed,
      resumeAt: sinceT0(world, simStart),
      repairsReplayed: repairs.length,
      plants: cfg.plants,
      mess: cfg.mess,
    },
    'starting stream',
  );

  const metrics = new SimMetrics();
  metrics.vehicles.set(world.registry.n);
  const ready = new Set<number>();
  let clock: SimClock | null = null;
  const lagByWorker = new Map<number, number>();
  const queuedByWorker = new Map<number, number>();
  const server = metrics.serve(
    cfg.metricsPort,
    () => ready.size === cfg.workers && clock !== null,
    () => {
      const now = clock?.now() ?? simStart;
      return {
        mode,
        speed,
        simTs: now,
        simIso: new Date(now).toISOString(),
        t0: new Date(t0).toISOString(),
        sinceT0H: (now - t0) / HOUR_MS,
        scenarioEnd: new Date(world.scenario.scenarioEndMs).toISOString(),
      };
    },
  );

  const workers = forkWorkers(cfg, 'stream', {
    [SIM_START_ENV]: String(simStart),
    [SPEED_ENV]: String(speed),
    [REPAIRS_ENV]: JSON.stringify(repairs),
  });
  const ownerOf = (vin: string) => {
    const idx = world.registry.vehicles.findIndex((v) => v.vin === vin);
    if (idx < 0) return -1;
    for (let w = 0; w < cfg.workers; w++) {
      const r = workerRange(world.registry.n, cfg.workers, w);
      if (idx >= r.start && idx < r.end) return w;
    }
    return -1;
  };
  let shuttingDown = false;

  workers.forEach((child, i) => {
    child.on('message', async (m: WorkerMessage) => {
      if (m.type === 'ready') {
        ready.add(m.worker);
        metrics.workersReady.set(ready.size);
        log.info({ worker: m.worker, vehicles: m.vehicles, startupMs: m.startupMs }, 'worker ready');
        if (ready.size === cfg.workers) {
          const wallStartMs = Date.now();
          clock = new SimClock(simStart, speed, wallStartMs);
          for (const w of workers) w.send({ type: 'start', wallStartMs } satisfies MainMessage);
        }
      } else if (m.type === 'sent') {
        metrics.add(m.counts);
        for (const [k, n] of Object.entries(m.mess)) metrics.mess.inc({ kind: k }, n);
        metrics.simTime.set(Math.floor(m.simTs / 1000));
        lagByWorker.set(m.worker, m.lagS);
        queuedByWorker.set(m.worker, m.queued);
      } else if (m.type === 'send-error') {
        metrics.sendErrors.inc();
      } else if (m.type === 'repair-applied') {
        await client.query('UPDATE sim.repair_log SET effective_at = $3 WHERE vin = $1 AND repaired_at = $2', [
          m.vin,
          pendingRepairAt.get(m.vin),
          new Date(m.effectiveMs).toISOString(),
        ]);
        await recordRepairOutcome(client, world, m.vin, cfg.simPrivateDir);
        log.info({ vin: m.vin, effective: sinceT0(world, m.effectiveMs) }, 'repair applied');
      }
    });
    child.on('exit', (code) => {
      ready.delete(i);
      metrics.workersReady.set(ready.size);
      if (!shuttingDown) {
        log.error({ worker: i, code }, 'worker exited unexpectedly; stopping simulator');
        void shutdown(1);
      }
    });
  });

  // Repairs: workshop.repairs.v1 -> repair_log (idempotent) -> owning worker.
  const pendingRepairAt = new Map<string, string>();
  const repairsConsumer = await consumeTopic(
    {
      brokers: cfg.kafka.brokers,
      clientId: `${cfg.kafka.clientId}-repairs`,
      groupId: 'cw-simulator-repairs',
      fromBeginning: true,
    },
    REPAIRS_TOPIC,
    async (_key, value) => {
      const r = parseRepair(value);
      if (!r) {
        metrics.repairs.inc({ outcome: 'rejected' });
        log.warn({ value }, 'ignored malformed repair message');
        return;
      }
      const iso = new Date(r.repairedAtMs).toISOString();
      const ins = await client.query(
        `INSERT INTO sim.repair_log (vin, repaired_at, effective_at) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING`,
        [r.vin, iso],
      );
      if (ins.rowCount === 0) return; // redelivery or replay: already applied
      const w = ownerOf(r.vin);
      if (w < 0) {
        metrics.repairs.inc({ outcome: 'unknown_vin' });
        return;
      }
      const plant = world.scenario.plants.get(r.vin);
      metrics.repairs.inc({ outcome: plant?.badRepair ? 'bad_repair' : 'applied' });
      pendingRepairAt.set(r.vin, iso);
      workers[w]!.send({ type: 'repair', vin: r.vin, repairedAtMs: r.repairedAtMs } satisfies MainMessage);
    },
  );
  const producer = new TelemetryProducer({
    brokers: cfg.kafka.brokers,
    clientId: `${cfg.kafka.clientId}-main`,
    lingerMs: 5,
  });
  await producer.connect();

  let announcedEnd = false;
  const timer = setInterval(() => {
    void (async () => {
      const r = metrics.roll();
      const lagS = Math.max(0, ...lagByWorker.values());
      metrics.lag.set(lagS);
      metrics.queued.set([...queuedByWorker.values()].reduce((a, b) => a + b, 0));
      if (!clock) {
        log.info({ workersReady: ready.size }, 'waiting for workers');
        return;
      }
      const now = clock.now();
      log.info(
        {
          msgsPerSec: r.msgsPerSec,
          totalSent: r.total,
          sim: sinceT0(world, now),
          lagS: Math.round(lagS * 10) / 10,
          byStream: r.byStream,
        },
        'throughput',
      );
      await client.query('UPDATE sim.run_state SET sim_ts = $1, updated_at = now()', [new Date(now).toISOString()]);
      if (!announcedEnd && now >= world.scenario.scenarioEndMs) {
        announcedEnd = true;
        log.info({ sim: sinceT0(world, now) }, 'scenario complete (T0+72h); simulator keeps running');
      }
      if (cfg.autoRepairs === 'on' && !autoRepairsDone && now >= world.scenario.autoRepairAtMs) {
        autoRepairsDone = true;
        const msgs = world.scenario.s1.sisters.map((vin) => repairMessage(vin, now));
        await producer.send(
          msgs.map((m) => ({ topic: REPAIRS_TOPIC, key: m.vin, value: JSON.stringify(m), format: 'repair.v1' })),
        );
        await client.query('UPDATE sim.run_state SET auto_repairs_done = true');
        log.info(
          { repairs: msgs.length, sim: sinceT0(world, now) },
          'AUTO_REPAIRS: repairs published for the S1 sisters',
        );
      }
      if (!transfersDone && world.scenario.transfers.length && now >= world.scenario.transfers[0]!.atMs) {
        transfersDone = true;
        for (const t of world.scenario.transfers) {
          const at = new Date(t.atMs).toISOString();
          await client.query(
            `UPDATE core.vehicle_depot_assignment SET valid = tstzrange(lower(valid), $2)
             WHERE vin = $1 AND upper_inf(valid)`,
            [t.vin, at],
          );
          await client.query(
            'INSERT INTO core.vehicle_depot_assignment (vin, depot_id, valid) VALUES ($1, $2, tstzrange($3, NULL))',
            [t.vin, t.toDepotId, at],
          );
        }
        await client.query('UPDATE sim.run_state SET transfers_done = true');
        log.info({ transfers: world.scenario.transfers.length }, 'depot transfers recorded (history kept)');
      }
    })().catch((err: unknown) => log.error({ err }, 'tick failed'));
  }, 5_000);

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    if (clock)
      await client
        .query('UPDATE sim.run_state SET sim_ts = $1', [new Date(clock.now()).toISOString()])
        .catch(() => undefined);
    for (const w of workers) w.kill('SIGTERM');
    await Promise.all(
      workers.map((w) => new Promise((res) => (w.exitCode !== null ? res(null) : w.once('exit', res)))),
    );
    await repairsConsumer.stop().catch(() => undefined);
    await producer.disconnect().catch(() => undefined);
    server.close();
    await client.end().catch(() => undefined);
    log.info('simulator stopped');
    process.exit(code);
  }
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
}

// ------------------------------------------------------------------------------------------------
// Bench

async function runBench(cfg: SimulatorConfig, world: World, args: Args, log: Logger): Promise<void> {
  const phases = args.burst
    ? [
        { seconds: 60, multiplier: 1 },
        { seconds: 300, multiplier: 3 },
        { seconds: 60, multiplier: 1 },
      ]
    : [{ seconds: args.durationS, multiplier: 1 }];
  const hw = `${os.cpus()[0]?.model ?? 'cpu'} x${os.cpus().length} threads, ${Math.round(os.totalmem() / 2 ** 30)} GiB visible`;
  log.info(
    { n: world.registry.n, workers: cfg.workers, phases, hardware: hw },
    'bench starting (every vehicle every wall-second x multiplier)',
  );
  const wallStartMs = Date.now() + 15_000; // time for workers to build templates and connect
  const spec: BenchSpec = { phases, wallStartMs };
  const workers = forkWorkers(cfg, 'bench', { [BENCH_SPEC_ENV]: JSON.stringify(spec) });
  const perSecond = new Map<number, number>();
  const lat: number[] = [];
  for (const w of workers) {
    w.on('message', (m: WorkerMessage) => {
      if (m.type !== 'bench') return;
      const s = Math.floor((Date.now() - wallStartMs) / 1000);
      perSecond.set(s, (perSecond.get(s) ?? 0) + m.sent);
      lat.push(...m.batchMs);
    });
  }
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - wallStartMs) / 1000);
    let sum = 0;
    for (let k = s - 5; k < s; k++) sum += perSecond.get(k) ?? 0;
    if (s > 0) log.info({ second: s, msgsPerSec: Math.round(sum / 5) }, 'bench');
  }, 5_000);
  await Promise.all(workers.map((w) => new Promise((res) => w.once('exit', res))));
  clearInterval(timer);

  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0;
  let acc = 0;
  const summary = phases.map((p) => {
    let sent = 0;
    for (let k = acc; k < acc + p.seconds; k++) sent += perSecond.get(k) ?? 0;
    const r = {
      multiplier: p.multiplier,
      seconds: p.seconds,
      target: world.registry.n * p.multiplier,
      achieved: Math.round(sent / p.seconds),
    };
    acc += p.seconds;
    return r;
  });
  const total = [...perSecond.values()].reduce((a, b) => a + b, 0);
  log.info(
    {
      hardware: hw,
      workers: cfg.workers,
      n: world.registry.n,
      phases: summary,
      totalSent: total,
      peak1s: Math.max(...perSecond.values()),
      batchAckMs: { p50: Math.round(pct(lat, 0.5)), p99: Math.round(pct(lat, 0.99)), batch: 5000 },
    },
    'bench result',
  );
}

// ------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const args = parseArgs(process.argv.slice(2), cfg.mode);
  const log = createLogger('simulator', cfg.logLevel);
  log.info(
    {
      mode: args.mode,
      scale: cfg.scale,
      seed: cfg.seed,
      workers: cfg.workers,
      t0: cfg.t0,
      plants: cfg.plants,
      mess: cfg.mess,
      autoRepairs: cfg.autoRepairs,
    },
    'starting',
  );
  const world = buildWorld(cfg);
  const lake = new Lake(cfg.lake);

  if (args.mode === 'history' && (args.days !== null || args.intervalMin !== null)) {
    // Size-option run (e.g. history:big): its own world and prefix, independent of the live stream.
    const days = args.days ?? world.params.historyDays;
    const intervalMin = args.intervalMin ?? world.params.cadenceMin;
    const big = buildWorld(cfg, { historyDays: days, cadenceMin: intervalMin });
    await ensureHistory(cfg, big, lake, { prefix: `history-${days}d-${intervalMin}m/`, days, intervalMin }, log, true);
    return;
  }

  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  const excluded = new Set(world.scenario.firmware ? [world.scenario.firmware.releaseId] : []);
  await seedRegistry(client, world.registry, world.registryHash, log, excluded);
  if (world.scenario.enabled) await applyPlants(client, world, cfg.simPrivateDir, log);

  const defaultSpec: HistorySpec = {
    prefix: 'history/',
    days: world.params.historyDays,
    intervalMin: world.params.cadenceMin,
  };
  if (args.mode === 'reset' || args.reset) {
    await client.query('DELETE FROM sim.run_state');
    await client.query('DELETE FROM sim.repair_log');
    await client.query('UPDATE sim.ground_truth SET repair_outcome = NULL');
    const removed = await lake.deletePrefix(defaultSpec.prefix);
    log.info({ removedObjects: removed }, 'reset: run state, repairs and history cleared; next start replays from T0');
    if (args.mode === 'reset') {
      await client.end();
      return;
    }
  }
  if (args.mode === 'bench') {
    await client.end();
    await runBench(cfg, world, args, log);
    return;
  }
  await ensureHistory(cfg, world, lake, defaultSpec, log, false);
  if (args.mode === 'history') {
    await client.end();
    return;
  }
  await runStream(cfg, world, args.mode === 'live' ? 'live' : 'demo', client, log);
}

// Run only as the entry point (tests import parseArgs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
