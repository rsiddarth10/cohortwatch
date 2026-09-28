import { TelemetryProducer, loadSimulatorConfigFile } from '@cw/common';
import { configPath } from '../config-path.js';
import { REPAIRS_TOPIC, repairMessage } from '../repairs.js';

/**
 * npm run sim:repair -- --vin <VIN> [--at <ISO sim time>] [--clock-url http://localhost:9464/clock]
 * Publishes {vin, repaired_at} to workshop.repairs.v1. Without --at, uses the simulator's current sim time.
 * (The UI publishes the same message in S6/S8.)
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const vin = arg('vin');
  if (!vin) throw new Error('usage: npm run sim:repair -- --vin <VIN> [--at <ISO time>]');
  const cfg = loadSimulatorConfigFile(configPath());
  let simTs: number;
  const at = arg('at');
  if (at) simTs = Date.parse(at);
  else {
    const url = arg('clock-url') ?? `http://localhost:${cfg.metricsPort}/clock`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`simulator clock not reachable at ${url} (is the simulator running?)`);
    simTs = ((await res.json()) as { simTs: number }).simTs;
  }
  const msg = repairMessage(vin, simTs);
  const producer = new TelemetryProducer({ brokers: cfg.kafka.brokers, clientId: 'cw-sim-repair-cli', lingerMs: 0 });
  await producer.connect();
  await producer.send([{ topic: REPAIRS_TOPIC, key: vin, value: JSON.stringify(msg), format: 'repair.v1' }]);
  await producer.disconnect();
  console.log(`published to ${REPAIRS_TOPIC}: ${JSON.stringify(msg)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
