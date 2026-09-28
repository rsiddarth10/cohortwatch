import { KafkaJS } from '@confluentinc/kafka-javascript';
import { loadSimulatorConfigFile } from '@cw/common';
import { configPath } from '../config-path.js';

/**
 * npm run sim:watch -- --vin <VIN> [--vin <VIN> ...] [--seconds 300] [--every-h 2]
 * Follows vans on the raw topics (both OEM formats) and prints their mean driving coolant per sim window.
 * Used to show a repair working (drift stops) and the bad repair not working.
 */
const DRIVING = new Set(['PERIODIC', 'P', 'HARSH_BRAKE', 'XB', 'HARSH_ACCEL', 'XA', 'DTC', 'D', 'TRIP_END', 'TE']);

export interface Reading {
  vin: string;
  ts: number;
  coolantC: number | null;
  driving: boolean;
}

/** Parse any of the three raw formats (Aurex v1 °F, Aurex v2 °C, Kestrel °C); null if unusable. */
export function readRaw(value: string): Reading | null {
  try {
    const b: unknown = JSON.parse(value);
    if (typeof b !== 'object' || b === null) return null;
    if ('id' in b) {
      const k = b as unknown as { id: string; ts: number; e: string; ct?: number };
      return { vin: k.id, ts: k.ts, coolantC: k.ct ?? null, driving: DRIVING.has(k.e) };
    }
    if ('seqNo' in b) {
      const a = b as unknown as {
        vehicle: { vin: string };
        time: string;
        event: string;
        engine: { coolant: { tempC: number | null } };
      };
      return {
        vin: a.vehicle.vin,
        ts: Date.parse(a.time),
        coolantC: a.engine.coolant.tempC,
        driving: DRIVING.has(a.event),
      };
    }
    const a = b as unknown as {
      vehicle: { vin: string };
      t: string;
      evt: string;
      eng: { coolantTempF: number | null };
    };
    const f = a.eng.coolantTempF;
    return {
      vin: a.vehicle.vin,
      ts: Date.parse(a.t),
      coolantC: f === null ? null : ((f - 32) * 5) / 9,
      driving: DRIVING.has(a.evt),
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const vins = argv.flatMap((a, i) => (a === '--vin' && argv[i + 1] ? [argv[i + 1]!] : []));
  const num = (name: string, d: number) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? Number(argv[i + 1]) : d;
  };
  const seconds = num('seconds', 300);
  const everyH = num('every-h', 2);
  if (vins.length === 0) throw new Error('usage: npm run sim:watch -- --vin <VIN> [--vin <VIN>] [--seconds 300]');
  const cfg = loadSimulatorConfigFile(configPath());
  const t0 = Date.parse(cfg.t0);
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: cfg.kafka.brokers.split(','), clientId: 'cw-sim-watch', logLevel: KafkaJS.logLevel.ERROR },
  });
  const consumer = kafka.consumer({ kafkaJS: { groupId: `cw-watch-${Date.now()}`, fromBeginning: false } });
  const want = new Set(vins);
  const buckets = new Map<string, { sum: number; n: number }>();
  await consumer.connect();
  await consumer.subscribe({ topics: ['raw.oem-a.v1', 'raw.oem-b.v1'] });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const key = message.key?.toString();
      if (!key || !want.has(key)) return;
      const r = readRaw(message.value?.toString() ?? '');
      if (!r || !r.driving || r.coolantC === null) return;
      const h = Math.floor((r.ts - t0) / 3_600_000 / everyH) * everyH;
      const k = `${r.vin}|${h}`;
      const b = buckets.get(k) ?? { sum: 0, n: 0 };
      b.sum += r.coolantC;
      b.n++;
      buckets.set(k, b);
    },
  });
  console.log(`watching ${vins.join(', ')} for ${seconds} s (mean driving coolant per ${everyH} sim-h)`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await consumer.disconnect();
  const hours = [...new Set([...buckets.keys()].map((k) => Number(k.split('|')[1])))].sort((a, b) => a - b);
  console.log(['sim time'.padEnd(12), ...vins.map((v) => v.padStart(19))].join(' '));
  for (const h of hours) {
    const row = vins.map((v) => {
      const b = buckets.get(`${v}|${h}`);
      return (b ? `${(b.sum / b.n).toFixed(1)} C (n=${b.n})` : '-').padStart(19);
    });
    console.log([`T0+${h}h`.padEnd(12), ...row].join(' '));
  }
}

if (process.argv[1]?.endsWith('watch.js')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
