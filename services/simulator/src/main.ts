import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger, loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from './config-path.js';
import { WORKER_INDEX_ENV, type WorkerMessage } from './ipc.js';
import { SimMetrics } from './metrics.js';
import { seedRegistry } from './seed.js';
import { buildWorld } from './world.js';

/**
 * Simulator supervisor: seeds the registry (idempotent COPY), then forks worker processes that
 * each own a VIN range. Aggregates their counters into Prometheus metrics and a 5 s throughput log.
 */
async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const log = createLogger('simulator', cfg.logLevel);
  log.info({ scale: cfg.scale, seed: cfg.seed, workers: cfg.workers, t0: cfg.t0, plants: cfg.plants }, 'starting');

  const { registry } = buildWorld(cfg);
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    await seedRegistry(client, registry, log);
  } finally {
    await client.end();
  }

  const metrics = new SimMetrics();
  metrics.vehicles.set(registry.n);
  const ready = new Set<number>();
  const server = metrics.serve(cfg.metricsPort, () => ready.size === cfg.workers);
  log.info({ port: cfg.metricsPort }, 'metrics on /metrics, health on /healthz');

  const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url));
  const workers: ChildProcess[] = [];
  let shuttingDown = false;

  for (let i = 0; i < cfg.workers; i++) {
    const child = fork(workerFile, [], { env: { ...process.env, [WORKER_INDEX_ENV]: String(i) } });
    child.on('message', (m: WorkerMessage) => {
      if (m.type === 'ready') {
        ready.add(m.worker);
        metrics.workersReady.set(ready.size);
      } else if (m.type === 'sent') {
        metrics.add(m.counts);
        metrics.simTime.set(Math.floor(m.simTs / 1000));
      } else if (m.type === 'send-error') {
        metrics.sendErrors.inc();
      }
    });
    child.on('exit', (code) => {
      ready.delete(i);
      metrics.workersReady.set(ready.size);
      if (!shuttingDown) {
        // Fail fast; the container restart policy brings the whole simulator back.
        log.error({ worker: i, code }, 'worker exited unexpectedly; stopping simulator');
        void shutdown(1);
      }
    });
    workers.push(child);
  }

  const timer = setInterval(() => {
    const r = metrics.roll();
    log.info(
      { msgsPerSec: r.msgsPerSec, totalSent: r.total, byStream: r.byStream, workersReady: ready.size },
      'throughput',
    );
  }, 5_000);

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    for (const w of workers) w.kill('SIGTERM');
    await Promise.all(
      workers.map((w) => new Promise((res) => (w.exitCode !== null ? res(null) : w.once('exit', res)))),
    );
    server.close();
    log.info('simulator stopped');
    process.exit(code);
  }
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
