import {
  DEFAULT_MESS,
  DEFAULT_PARAMS,
  DEFAULT_VALIDATION,
  FleetStream,
  HOUR_MS,
  IngestClock,
  generateRegistry,
  makeWorldContext,
  messUp,
  type VinState,
} from '@cw/domain';
import { encodeCanonical } from '../avro.js';
import { classifyBatch, decodeBatch, vinsOf, type RawRecord } from '../pipeline.js';

/**
 * npm run normaliser:bench-cpu: CPU cost of the normaliser's pure path per event (decode → validate →
 * anti-replay → jumps → Avro encode), without Kafka or Redis. Gives the single-thread ceiling per replica.
 */
const T0 = Date.parse('2026-09-28T04:00:00Z');
const reg = generateRegistry('bench-cpu', 2000, T0, DEFAULT_PARAMS);
const ctx = {
  seed: reg.seed,
  epochMs: reg.epochMs,
  cfg: DEFAULT_MESS,
  enabled: true,
  aurexV2FromMs: T0 + 12 * HOUR_MS,
};
const records: RawRecord[] = new FleetStream(reg.vehicles, makeWorldContext(reg, DEFAULT_PARAMS), T0)
  .drainUntil(T0 + 24 * HOUR_MS)
  .flatMap((e) => messUp(e, ctx))
  .map((m, i) => ({
    topic: m.topic,
    partition: 0,
    offset: String(i),
    timestampMs: m.releaseMs,
    key: m.key,
    value: Buffer.from(m.value),
    headers: { 'x-sent-at': '0' },
  }));
console.log(`${records.length} records`);

const BATCH = 2000;
const time = (label: string, fn: () => void) => {
  const t = process.hrtime.bigint();
  fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(
    `${label.padEnd(28)} ${((ms / records.length) * 1000).toFixed(2).padStart(7)} µs/event  ${Math.round(records.length / (ms / 1000)).toLocaleString('en')} events/s`,
  );
};

for (let round = 0; round < 2; round++) {
  const decoded = records.length ? decodeBatch(records, DEFAULT_VALIDATION, () => new Date()) : [];
  time('decode + validate', () => {
    for (let i = 0; i < records.length; i += BATCH)
      decodeBatch(records.slice(i, i + BATCH), DEFAULT_VALIDATION, () => new Date());
  });
  const states = new Map<string, VinState | undefined>();
  const clock = new IngestClock(360);
  let canonical: ReturnType<typeof classifyBatch>['canonical'] = [];
  time('classify (replay/jumps/skew)', () => {
    for (let i = 0; i < decoded.length; i += BATCH) {
      const slice = decoded.slice(i, i + BATCH);
      const res = classifyBatch(slice, states, clock, { skewMs: 120_000 });
      for (const [k, v] of res.states) states.set(k, v);
      canonical = canonical.concat(res.canonical);
      vinsOf(slice);
    }
  });
  time('avro encode', () => {
    for (const c of canonical) encodeCanonical(1, c.event);
  });
  time('all three', () => {
    const st = new Map<string, VinState | undefined>();
    for (let i = 0; i < records.length; i += BATCH) {
      const res = classifyBatch(
        decodeBatch(records.slice(i, i + BATCH), DEFAULT_VALIDATION, () => new Date()),
        st,
        clock,
        {
          skewMs: 120_000,
        },
      );
      for (const [k, v] of res.states) st.set(k, v);
      for (const c of res.canonical) encodeCanonical(1, c.event);
    }
  });
  console.log('');
}
