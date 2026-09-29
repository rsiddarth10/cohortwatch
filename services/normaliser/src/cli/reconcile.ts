import { KafkaJS } from '@confluentinc/kafka-javascript';

/**
 * npm run normaliser:reconcile [-- --seconds 300] [--ledger http://localhost:9465/ledger,...]
 *
 * Over a wall-clock window, checks that every raw record the normaliser committed is accounted for:
 *   raw in = canonical out + DLQ + duplicates dropped.
 * - in: committed offset ranges per raw partition, from each replica's /ledger (updated in the same step
 *   as the Kafka commit, so offsets and the duplicate counter are one consistent snapshot).
 * - out / DLQ: counted in Kafka itself. Every canonical and DLQ record carries x-src-topic/partition/offset,
 *   so we count the distinct source offsets inside the window's ranges (a re-produced event counts once).
 * - duplicates: from the ledger (dropped records leave nothing in Kafka to count).
 */

interface Ledger {
  committed: Record<string, Record<string, string>>;
  duplicates: number;
  in: number;
  out: number;
  dlq: number;
}

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1]! : def;
};
const seconds = Number(arg('seconds', '300'));
const ledgerUrls = arg('ledger', process.env.NORMALISER_LEDGER_URLS ?? 'http://localhost:9465/ledger').split(',');
const brokers = arg('brokers', process.env.KAFKA_BROKERS ?? 'localhost:19092');
const outTopic = arg('out', 'telemetry.canonical.v1');
const dlqTopic = arg('dlq', 'telemetry.dlq.v1');

async function snapshot(): Promise<{ committed: Map<string, bigint>; duplicates: number; at: number }> {
  const committed = new Map<string, bigint>();
  let duplicates = 0;
  for (const url of ledgerUrls) {
    const l = (await (await fetch(url)).json()) as Ledger;
    duplicates += l.duplicates;
    for (const [topic, parts] of Object.entries(l.committed)) {
      for (const [p, off] of Object.entries(parts)) {
        const k = `${topic}:${p}`;
        const v = BigInt(off);
        if (!committed.has(k) || committed.get(k)! < v) committed.set(k, v);
      }
    }
  }
  return { committed, duplicates, at: Date.now() };
}

/** Count distinct x-src offsets inside [from, to) per raw partition, reading a topic from `startMs` to its end. */
async function countBySource(
  kafka: KafkaJS.Kafka,
  topic: string,
  startMs: number,
  ranges: Map<string, [bigint, bigint]>,
): Promise<number> {
  const admin = kafka.admin();
  await admin.connect();
  const starts = await admin.fetchTopicOffsetsByTimestamp(topic, startMs);
  const ends = await admin.fetchTopicOffsets(topic);
  await admin.disconnect();
  const endBy = new Map(ends.map((e) => [e.partition, BigInt(e.high)]));
  const todo = starts.filter((s) => BigInt(s.offset) < (endBy.get(s.partition) ?? 0n));
  if (todo.length === 0) return 0;

  const startBy = new Map(todo.map((s) => [s.partition, BigInt(s.offset)]));
  const seeked = new Set<number>();
  const seen = new Set<string>();
  const done = new Set<number>();
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `cw-reconcile-${Date.now()}`, fromBeginning: true, autoCommit: false },
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  let resolveAll: () => void;
  const finished = new Promise<void>((r) => (resolveAll = r));
  const timer = setTimeout(() => resolveAll(), 10 * 60_000);
  await consumer.run({
    eachMessage: async ({ partition, message }) => {
      const start = startBy.get(partition);
      if (start === undefined) return; // nothing in the window on this partition
      const offset = BigInt(message.offset);
      if (offset < start) {
        // partitions are assigned asynchronously, so seek on first sight rather than up front
        if (!seeked.has(partition)) {
          seeked.add(partition);
          consumer.seek({ topic, partition, offset: start.toString() });
        }
        return;
      }
      const end = endBy.get(partition) ?? 0n;
      if (offset >= end - 1n) done.add(partition);
      const h = message.headers ?? {};
      const val = (k: string) => {
        const v = h[k];
        return (Array.isArray(v) ? v[0] : v)?.toString();
      };
      const src = `${val('x-src-topic')}:${val('x-src-partition')}`;
      const r = ranges.get(src);
      if (r) {
        const off = BigInt(val('x-src-offset') ?? '-1');
        if (off >= r[0] && off < r[1]) seen.add(`${src}:${off}`);
      }
      if (done.size >= todo.length) resolveAll();
    },
  });
  await finished;
  clearTimeout(timer);
  await consumer.disconnect();
  return seen.size;
}

async function main(): Promise<void> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: brokers.split(','), clientId: 'cw-reconcile', logLevel: KafkaJS.logLevel.ERROR },
  });
  const a = await snapshot();
  console.log(`window start: ${a.committed.size} partitions; waiting ${seconds} s ...`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const b = await snapshot();

  const ranges = new Map<string, [bigint, bigint]>();
  let rawIn = 0n;
  for (const [k, to] of b.committed) {
    const from = a.committed.get(k);
    if (from === undefined || to <= from) continue; // partition gained mid-window: not in this ledger range
    ranges.set(k, [from, to]);
    rawIn += to - from;
  }
  const readFrom = a.at - 60_000; // records for offsets ≥ from may have been produced just before t0
  const out = await countBySource(kafka, outTopic, readFrom, ranges);
  const dlq = await countBySource(kafka, dlqTopic, readFrom, ranges);
  const dups = b.duplicates - a.duplicates;
  const diff = Number(rawIn) - out - dlq - dups;
  const report = [
    `normaliser reconcile  window ${seconds}s  ${new Date(a.at).toISOString()} → ${new Date(b.at).toISOString()}`,
    `partitions            ${ranges.size}`,
    `raw in (committed)    ${rawIn}`,
    `canonical out         ${out}   (distinct source offsets found in ${outTopic})`,
    `DLQ                   ${dlq}   (distinct source offsets found in ${dlqTopic})`,
    `duplicates dropped    ${dups}   (normaliser ledger)`,
    `difference            ${diff}   ${diff === 0 ? 'BALANCED' : 'NOT BALANCED'}`,
  ].join('\n');
  console.log(report);
  process.exit(diff === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
