import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createLogger } from '@cw/common';
import { CanonicalEventSchema, DEFAULT_VALIDATION, IngestClock, type CanonicalEvent } from '@cw/domain';
import { encodeCanonical, registerCanonicalSchema } from './avro.js';
import { loadConfig, type NormaliserConfig } from './config.js';
import { NormaliserMetrics } from './metrics.js';
import { classifyBatch, decodeBatch, vinsOf, type BatchResult, type DlqOut, type RawRecord } from './pipeline.js';
import { StateStore } from './state-store.js';

/**
 * S2 normaliser: raw.oem-a.v1 + raw.oem-b.v1 → telemetry.canonical.v1 (Avro) + telemetry.dlq.v1.
 *
 * Per partition batch: decode → read VIN states (1 MGET) → classify → produce and await acks →
 * write states (1 Lua compare-and-set) → commit offsets. Nothing is committed before it is durably produced
 * (at-least-once, never loss). A crash between produce and the state write can re-produce events; they keep
 * the same event_id (uuid5 of vin:seq), so consumers dedupe. See docs/adr/0001-normaliser-anti-replay-and-delivery.md.
 */

const cfg = loadConfig();
const log = createLogger('normaliser', cfg.LOG_LEVEL);

function headersOf(h: KafkaJS.IHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const x = Array.isArray(v) ? v[0] : v;
    if (x !== undefined) out[k] = x.toString();
  }
  return out;
}

const srcHeaders = (r: RawRecord) => ({
  'x-src-topic': r.topic,
  'x-src-partition': String(r.partition),
  'x-src-offset': r.offset,
});

/** Consistent snapshot for `normaliser:reconcile` (plain JSON, updated synchronously at commit). */
interface Ledger {
  committed: Record<string, Record<string, string>>;
  in: number;
  out: number;
  dlq: number;
  duplicates: number;
}

async function registerWithRetry(url: string): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await registerCanonicalSchema(url);
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn({ err: String(err), attempt }, 'schema registry not ready; retrying');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main(c: NormaliserConfig): Promise<void> {
  const metrics = new NormaliserMetrics();
  const ledger: Ledger = { committed: {}, in: 0, out: 0, dlq: 0, duplicates: 0 };
  let healthy = false;
  const server = metrics.serve(c.METRICS_PORT, () => healthy, { '/ledger': () => ledger });

  const store = new StateStore(c.REDIS_URL, c.STATE_TTL_S);
  await store.connect();
  const schemaId = c.ENCODING === 'avro' ? await registerWithRetry(c.SCHEMA_REGISTRY_URL) : 0;
  const encode = (ev: CanonicalEvent): Buffer =>
    c.ENCODING === 'avro'
      ? encodeCanonical(schemaId, ev)
      : Buffer.from(JSON.stringify(CanonicalEventSchema.parse(ev)), 'utf8');

  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: c.KAFKA_BROKERS.split(','), clientId: 'cw-normaliser', logLevel: KafkaJS.logLevel.WARN },
  });
  const producer = kafka.producer({
    'linger.ms': 5,
    'batch.size': 262_144,
    kafkaJS: { idempotent: true, acks: -1, compression: KafkaJS.CompressionTypes.ZSTD },
  });
  const consumer = kafka.consumer({
    'js.consumer.max.batch.size': c.BATCH_SIZE,
    kafkaJS: {
      groupId: c.GROUP_ID,
      fromBeginning: c.FROM_BEGINNING === 'true',
      autoCommit: false,
      partitionAssigners: [KafkaJS.PartitionAssigners.cooperativeSticky],
    },
  });
  const admin = kafka.admin();
  await Promise.all([producer.connect(), consumer.connect(), admin.connect()]);
  await consumer.subscribe({ topics: c.INPUT_TOPICS });
  log.info({ encoding: c.ENCODING, schemaId, topics: c.INPUT_TOPICS, batch: c.BATCH_SIZE }, 'normaliser starting');

  // ---- back-pressure: pause every input partition while acks or Redis fall behind -------------------
  let inflight = 0;
  let redisEwma = 0;
  let paused = false;
  const observeRedis = (ms: number) => {
    redisEwma = redisEwma === 0 ? ms : 0.8 * redisEwma + 0.2 * ms;
    metrics.redisMs.set(redisEwma);
  };
  const topicsAll = () => c.INPUT_TOPICS.map((topic) => ({ topic }));
  const bpTimer = setInterval(() => {
    const tooMany = inflight > c.MAX_INFLIGHT_EVENTS;
    const slowRedis = redisEwma > c.MAX_REDIS_MS;
    if (!paused && (tooMany || slowRedis)) {
      consumer.pause(topicsAll());
      paused = true;
      metrics.paused.set(1);
      metrics.pauses.inc({ reason: tooMany ? 'inflight' : 'redis' });
      log.warn({ inflight, redisMs: Math.round(redisEwma) }, 'back-pressure: paused');
    } else if (paused && inflight < c.MAX_INFLIGHT_EVENTS / 2 && redisEwma < c.MAX_REDIS_MS / 2) {
      consumer.resume(topicsAll());
      paused = false;
      metrics.paused.set(0);
      log.info({ inflight, redisMs: Math.round(redisEwma) }, 'back-pressure: resumed');
    }
    // decay the Redis estimate while idle so a pause cannot latch forever
    if (paused && inflight === 0) observeRedis(redisEwma * 0.5);
  }, 200);

  // ---- consumer lag per owned partition (high watermark − committed) ---------------------------------
  const lagTimer = setInterval(() => {
    void (async () => {
      try {
        const owned = consumer.assignment();
        for (const topic of new Set(owned.map((a) => a.topic))) {
          const offsets = await admin.fetchTopicOffsets(topic);
          for (const o of offsets) {
            if (!owned.some((a) => a.topic === topic && a.partition === o.partition)) continue;
            const committed = ledger.committed[topic]?.[o.partition];
            if (committed === undefined) continue;
            metrics.lag.set({ topic, partition: o.partition }, Number(BigInt(o.high) - BigInt(committed)));
          }
        }
      } catch (err) {
        log.debug({ err: String(err) }, 'lag poll failed');
      }
    })();
  }, 10_000);

  const clocks = new Map<string, IngestClock>();

  async function handle(records: RawRecord[]): Promise<BatchResult> {
    const decoded = decodeBatch(records, DEFAULT_VALIDATION, () => new Date());
    const t = performance.now();
    const read = await store.read(vinsOf(decoded));
    observeRedis(performance.now() - t);
    const key = `${records[0]!.topic}:${records[0]!.partition}`;
    let clock = clocks.get(key);
    if (!clock) clocks.set(key, (clock = new IngestClock(c.INGEST_CLOCK_SPEED)));
    const res = classifyBatch(decoded, read.states, clock, { skewMs: c.SKEW_MS });

    // Encode; an event the Avro contract rejects goes to the DLQ instead of failing the batch.
    const now = String(Date.now());
    const canonicalMsgs: KafkaJS.Message[] = [];
    const sentAt: number[] = [];
    for (const ce of res.canonical) {
      let value: Buffer;
      try {
        value = encode(ce.event);
      } catch (err) {
        res.counts.out--;
        res.counts.dlq.SCHEMA_INVALID = (res.counts.dlq.SCHEMA_INVALID ?? 0) + 1;
        res.dlq.push(schemaReject(ce.src, err));
        continue;
      }
      canonicalMsgs.push({
        key: ce.event.vin,
        value,
        headers: {
          ...srcHeaders(ce.src),
          'x-source-format': ce.event.source_format,
          'x-sent-at': ce.src.headers['x-sent-at'] ?? '',
          'x-normalised-at': now,
          'x-event-id': ce.event.event_id,
        },
      });
      const s = Number(ce.src.headers['x-sent-at']);
      if (Number.isFinite(s) && s > 0) sentAt.push(s);
    }
    const dlqMsgs: KafkaJS.Message[] = res.dlq.map((d) => ({
      key: d.key,
      value: JSON.stringify(d.envelope),
      headers: { ...srcHeaders(d.src), 'x-error-code': d.envelope.error_code },
    }));
    const n = canonicalMsgs.length + dlqMsgs.length;
    inflight += n;
    metrics.inflight.set(inflight);
    try {
      const topicMessages = [
        { topic: c.OUTPUT_TOPIC, messages: canonicalMsgs },
        { topic: c.DLQ_TOPIC, messages: dlqMsgs },
      ].filter((x) => x.messages.length > 0);
      if (topicMessages.length > 0) await producer.sendBatch({ topicMessages });
    } finally {
      inflight -= n;
      metrics.inflight.set(inflight);
    }
    const acked = Date.now();
    for (const s of sentAt) metrics.e2eSeconds.observe((acked - s) / 1000);

    const t2 = performance.now();
    const conflicts = await store.write(res.states, read);
    observeRedis(performance.now() - t2);
    if (conflicts.length > 0) {
      metrics.casConflicts.inc(conflicts.length);
      log.warn({ conflicts: conflicts.length }, 'VIN state changed by another writer (rebalance); kept theirs');
    }
    return res;
  }

  await consumer.run({
    eachBatchAutoResolve: false,
    partitionsConsumedConcurrently: c.CONCURRENCY,
    eachBatch: async ({ batch, resolveOffset, isStale }) => {
      if (batch.messages.length === 0) return;
      const end = metrics.batchSeconds.startTimer();
      const records: RawRecord[] = batch.messages.map((m) => ({
        topic: batch.topic,
        partition: batch.partition,
        offset: m.offset,
        timestampMs: Number(m.timestamp),
        key: m.key ? m.key.toString() : null,
        value: m.value,
        headers: headersOf(m.headers),
      }));
      const res = await handle(records);
      const last = batch.messages[batch.messages.length - 1]!.offset;
      if (isStale()) {
        // partition was revoked mid-batch: the new owner re-reads from the last commit (duplicates dedupe)
        log.info({ topic: batch.topic, partition: batch.partition }, 'batch stale after revoke; not committing');
        return;
      }
      const next = (BigInt(last) + 1n).toString();
      await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: next }]);
      resolveOffset(last);
      // ledger + metrics move together, synchronously, right after the commit
      (ledger.committed[batch.topic] ??= {})[batch.partition] = next;
      ledger.in += res.counts.in;
      ledger.out += res.counts.out;
      ledger.dlq += Object.values(res.counts.dlq).reduce((a, b) => a + b, 0);
      ledger.duplicates += res.counts.replay.DUPLICATE;
      metrics.committed.set({ topic: batch.topic, partition: batch.partition }, Number(next));
      metrics.recordBatch(batch.topic, res.counts);
      end();
    },
  });
  healthy = true;

  const shutdown = async (code: number) => {
    healthy = false;
    clearInterval(bpTimer);
    clearInterval(lagTimer);
    log.info('shutting down');
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
    await store.close().catch(() => undefined);
    server.close();
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
}

function schemaReject(src: RawRecord, err: unknown): DlqOut {
  return {
    key: src.key,
    src,
    envelope: {
      source_topic: src.topic,
      partition: src.partition,
      offset: src.offset,
      error_code: 'SCHEMA_INVALID',
      error_detail: `canonical contract: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      raw_payload_b64: (src.value ?? Buffer.alloc(0)).toString('base64'),
      first_seen: new Date().toISOString(),
    },
  };
}

main(cfg).catch((err: unknown) => {
  log.fatal({ err }, 'normaliser failed');
  process.exit(1);
});
