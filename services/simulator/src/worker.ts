import { setTimeout as sleep } from 'node:timers/promises';
import { TelemetryProducer, createLogger, loadSimulatorConfigFile, type OutboundMessage } from '@cw/common';
import { FleetStream, LiveClock, encodeForOem, makeWorldContext, workerRange } from '@cw/domain';
import { configPath } from './config-path.js';
import { WORKER_INDEX_ENV, type WorkerMessage } from './ipc.js';
import { buildWorld } from './world.js';

/**
 * One worker process: owns a contiguous VIN range, replays its vehicles up to "now",
 * then streams every due event to its OEM's raw topic. Each worker has its own producer.
 */
async function main(): Promise<void> {
  const index = Number(process.env[WORKER_INDEX_ENV]);
  const cfg = loadSimulatorConfigFile(configPath());
  const log = createLogger(`simulator.worker-${index}`, cfg.logLevel);
  const send = (m: WorkerMessage) => process.send?.(m);

  const started = Date.now();
  const { registry, params } = buildWorld(cfg);
  const { start, end } = workerRange(registry.n, cfg.workers, index);
  const vehicles = registry.vehicles.slice(start, end);
  const clock = new LiveClock();
  const fleet = new FleetStream(vehicles, makeWorldContext(registry, params), clock.now());

  const producer = new TelemetryProducer({
    brokers: cfg.kafka.brokers,
    clientId: `${cfg.kafka.clientId}-${index}`,
    lingerMs: cfg.kafka.lingerMs,
  });
  await producer.connect();
  send({ type: 'ready', worker: index, vehicles: vehicles.length, startupMs: Date.now() - started });
  log.info({ vins: [start, end], vehicles: vehicles.length, startupMs: Date.now() - started }, 'worker streaming');

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('disconnect', stop);

  while (running) {
    const simNow = clock.now();
    const due = fleet.drainUntil(simNow, 20_000);
    if (due.length > 0) {
      const batch: OutboundMessage[] = due.map(encodeForOem);
      try {
        await producer.send(batch);
        const counts: Record<string, number> = {};
        for (const m of batch) counts[`${m.topic}|${m.format}`] = (counts[`${m.topic}|${m.format}`] ?? 0) + 1;
        send({ type: 'sent', worker: index, counts, simTs: simNow });
      } catch (err) {
        // At-least-once: the events are already drained, so fail loudly and let the supervisor restart us.
        send({ type: 'send-error', worker: index, error: String(err) });
        log.error({ err }, 'kafka send failed');
        throw err;
      }
    }
    if (due.length < 20_000) await sleep(cfg.tickMs);
  }

  await producer.disconnect();
  log.info('worker stopped');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
