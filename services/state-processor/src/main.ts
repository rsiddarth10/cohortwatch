import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createLogger } from '@cw/common';
import { CanonicalEventSchema, PeerContext, type CanonicalEvent } from '@cw/domain';
import pg from 'pg';
import { CanonicalDecoder } from './avro.js';
import { CheckpointStore } from './checkpoint.js';
import { loadConfig, type StateConfig } from './config.js';
import { StateMetrics } from './metrics.js';
import { PartitionState, processBatch, type InEvent } from './processor.js';
import { RegistryCache } from './registry.js';
import { IncidentSink } from './sink.js';
import { TelemetryWriter } from './telemetry.js';

/**
 * S3 state processor: telemetry.canonical.v1 → per-van "vs its own normal, minus peers" → incidents.v1 +
 * core.incident, runaway flags, and the down-sampled telemetry hypertable.
 *
 * Per-VIN state lives in memory per owned partition (ADR 0005). Per batch: decode → detect → write incidents
 * (Postgres, then Kafka; awaited) → resolve the offset. Every CHECKPOINT_MS each changed partition's state is
 * serialised (between batches), written to Redis with its offset, and only then the offset is committed. On
 * revoke the checkpoint is written before the partition is handed over; on assign it is loaded. A restart
 * replays from the committed offset and the per-VIN last-seq guard skips what the checkpoint already holds.
 * A batch that still fails after retries stops the process (crash-only): the restart recovers exactly.
 */

let log = createLogger('state-processor', process.env.LOG_LEVEL ?? 'info');

const ERR_ASSIGN = -175; // librdkafka ERR__ASSIGN_PARTITIONS
const ERR_REVOKE = -174; // librdkafka ERR__REVOKE_PARTITIONS

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn({ err: String(err), attempt: i }, `${what} failed; retrying`);
      await sleep(500 * i);
    }
  }
}

function header(h: KafkaJS.IHeaders | undefined, name: string): string | undefined {
  const v = h?.[name];
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined ? undefined : x.toString();
}

/** Test seams (integration test): fault injection after a batch is fully applied and written. */
export interface StateHooks {
  afterBatch?: (b: { partition: number; lastOffset: string }) => void | Promise<void>;
  /** A batch failed after retries. Default: exit the process (crash-only). */
  onFatal?: (err: unknown) => void;
}

export interface RunningStateProcessor {
  stats: { applied: number; skipped: number; incidents: number };
  /** Write every partition's checkpoint and commit (e.g. before a planned stop). */
  checkpointAll(): Promise<void>;
  stop(): Promise<void>;
  /** Emulate a crash: disconnect without writing checkpoints or committing (tests). */
  kill(): Promise<void>;
}

export async function startStateProcessor(c: StateConfig, hooks: StateHooks = {}): Promise<RunningStateProcessor> {
  log = createLogger('state-processor', c.LOG_LEVEL);
  const metrics = new StateMetrics();
  const stats = { applied: 0, skipped: 0, incidents: 0 };
  let healthy = false;
  const server = metrics.serve(c.METRICS_PORT, () => healthy, { '/stats': () => stats });

  // Timeouts everywhere: a call that hangs on a dead connection must fail (and be retried or crash the process),
  // never stall a partition forever. Found in the 100K run after a Docker network glitch.
  const pool = new pg.Pool({
    connectionString: c.DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
    keepAlive: true,
  });
  const registry = new RegistryCache(pool);
  await retry('registry load', () => registry.load(), 30);
  log.info(
    { vans: registry.vans.size, withOwnBaseline: registry.vansWithOwnBaseline, baselineRun: registry.baselineRunId },
    'registry and baselines loaded',
  );
  const refreshTimer = setInterval(() => {
    registry.load().catch((err: unknown) => log.warn({ err: String(err) }, 'registry refresh failed'));
  }, c.REGISTRY_REFRESH_MS);

  const store = new CheckpointStore(c.REDIS_URL, c.STATE_PREFIX, c.STATE_TTL_S);
  await store.connect();
  const decoder = new CanonicalDecoder(c.SCHEMA_REGISTRY_URL);
  const peers = new PeerContext(c.detect.peerWindowH, c.detect.minPeers);
  const repairs = new Map<string, number>();
  const env = { params: c.detect, registry, peers, repairs };

  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: c.KAFKA_BROKERS.split(','), clientId: 'cw-state-processor', logLevel: KafkaJS.logLevel.WARN },
  });
  const producer = kafka.producer({
    'linger.ms': 5,
    kafkaJS: { idempotent: true, acks: -1, compression: KafkaJS.CompressionTypes.ZSTD },
  });
  await producer.connect();
  const sink = new IncidentSink(pool, producer, c.INCIDENT_TOPIC);
  const telemetry =
    c.TELEMETRY === 'on'
      ? new TelemetryWriter(pool, c.TELEMETRY_BUCKET_MIN, c.detect, metrics, c.TELEMETRY_FLUSH_MS, (err) =>
          log.warn({ err: String(err) }, 'telemetry write failed; retrying next round'),
        )
      : null;

  const topic = c.INPUT_TOPIC;
  const parts = new Map<number, PartitionState>();
  let crashing = false;
  const loading = new Map<number, Promise<PartitionState>>();
  const processed = new Map<number, bigint>();

  async function partition(p: number): Promise<PartitionState> {
    const have = parts.get(p);
    if (have) return have;
    let l = loading.get(p);
    if (!l) {
      l = (async () => {
        try {
          const ps = new PartitionState();
          const ck = await retry('checkpoint load', () => store.load(topic, p));
          if (ck) {
            for (const [vin, st] of Object.entries(ck.vans)) ps.vans.set(vin, st);
            ps.offset = ck.offset;
          }
          log.info({ partition: p, vans: ps.vans.size, offset: ps.offset }, 'partition state loaded');
          parts.set(p, ps);
          return ps;
        } finally {
          loading.delete(p); // a failed load is retried by the next batch, never cached
        }
      })();
      loading.set(p, l);
    }
    return l;
  }

  /** Serialise one partition between batches, write it, then commit its offset. */
  async function checkpoint(p: number, ps: PartitionState, reason: 'timer' | 'revoke' | 'stop', commit: boolean) {
    const end = metrics.checkpointSeconds.startTimer();
    const snap = await ps.run(() => {
      ps.dirty = false;
      return { json: ps.snapshot(), offset: ps.offset };
    });
    if (snap.offset === null) return;
    await retry('checkpoint write', () => store.save(topic, p, snap.json));
    metrics.checkpointBytes.set(snap.json.length);
    metrics.checkpoints.inc({ reason });
    end();
    if (commit) {
      await consumer.commitOffsets([{ topic, partition: p, offset: snap.offset }]).catch((err: unknown) => {
        log.info({ partition: p, err: String(err) }, 'commit after checkpoint failed (partition moved?)');
      });
    }
  }

  const consumer = kafka.consumer({
    'js.consumer.max.batch.size': 2000,
    rebalance_cb: async (err: { code: number }, assignment: { topic: string; partition: number }[]) => {
      if (err.code === ERR_REVOKE) {
        if (crashing) return; // crash emulation: a dead process writes nothing
        for (const a of assignment) {
          const ps = parts.get(a.partition);
          if (a.topic !== topic || !ps) continue;
          await checkpoint(a.partition, ps, 'revoke', false).catch((e: unknown) =>
            log.warn({ partition: a.partition, err: String(e) }, 'checkpoint on revoke failed'),
          );
          parts.delete(a.partition);
          processed.delete(a.partition);
          telemetry?.dropPartition(a.partition);
        }
        log.info({ revoked: assignment.map((a) => a.partition) }, 'partitions revoked (checkpointed)');
      } else if (err.code === ERR_ASSIGN) {
        log.info({ assigned: assignment.map((a) => a.partition) }, 'partitions assigned');
      }
    },
    kafkaJS: {
      groupId: c.GROUP_ID,
      fromBeginning: c.FROM_BEGINNING === 'true',
      autoCommit: false,
      partitionAssigners: [KafkaJS.PartitionAssigners.cooperativeSticky],
    },
  } as KafkaJS.ConsumerConstructorConfig);
  const admin = kafka.admin();
  await Promise.all([consumer.connect(), admin.connect()]);

  // Repairs (S6): every replica reads the tiny repairs topic in full (its own throwaway group, never committed)
  // into vin → repair time; processBatch resets a van's trend before its next reading (ADR 0016).
  const repairConsumer = kafka.consumer({
    kafkaJS: { groupId: `cg.state.repairs.${randomUUID()}`, fromBeginning: true, autoCommit: false },
  });
  await repairConsumer.connect();
  await repairConsumer.subscribe({ topics: [c.REPAIRS_TOPIC] });
  await repairConsumer.run({
    eachMessage: async ({ message }) => {
      try {
        const m = JSON.parse(message.value?.toString() ?? '') as { vin?: unknown; repaired_at?: unknown };
        const ts = typeof m.repaired_at === 'string' ? Date.parse(m.repaired_at) : NaN;
        if (typeof m.vin !== 'string' || !Number.isFinite(ts)) return;
        if ((repairs.get(m.vin) ?? -Infinity) < ts) {
          repairs.set(m.vin, ts);
          log.info({ vin: m.vin, repaired_at: m.repaired_at }, 'repair: the van trend restarts');
        }
      } catch {
        // malformed repair message: ignored (the simulator's own consumer logs it)
      }
    },
  });
  await consumer.subscribe({ topics: [topic] });
  const owned = (p: number) => consumer.assignment().some((a) => a.topic === topic && a.partition === p);

  // ---- checkpoints -------------------------------------------------------------------------------
  let checkpointing = false;
  async function checkpointAll(reason: 'timer' | 'stop' = 'timer') {
    if (checkpointing) return;
    checkpointing = true;
    try {
      for (const [p, ps] of parts) {
        if (!ps.dirty) continue;
        if (!owned(p)) {
          parts.delete(p);
          continue;
        }
        await checkpoint(p, ps, reason, true);
      }
    } finally {
      checkpointing = false;
    }
  }
  const ckTimer = setInterval(() => {
    checkpointAll().catch((err: unknown) => log.error({ err: String(err) }, 'checkpoint round failed'));
  }, c.CHECKPOINT_MS);

  // ---- back-pressure: pause input while telemetry writes fall behind ----------------------------
  let paused = false;
  const bpTimer = setInterval(() => {
    const pending = telemetry?.pending() ?? 0;
    if (!paused && pending > c.MAX_PENDING_WRITES) {
      consumer.pause([{ topic }]);
      paused = true;
      metrics.paused.set(1);
      metrics.pauses.inc({ reason: 'telemetry' });
      log.warn({ pending }, 'back-pressure: paused');
    } else if (paused && pending < c.MAX_PENDING_WRITES / 2) {
      consumer.resume([{ topic }]);
      paused = false;
      metrics.paused.set(0);
      log.info({ pending }, 'back-pressure: resumed');
    }
  }, 200);

  // ---- lag + gauges ------------------------------------------------------------------------------
  const lagTimer = setInterval(() => {
    let vans = 0;
    for (const ps of parts.values()) vans += ps.vans.size;
    metrics.vans.set(vans);
    metrics.peerEntries.set(peers.size());
    void (async () => {
      try {
        const offsets = await admin.fetchTopicOffsets(topic);
        metrics.lag.reset(); // only partitions this replica owns now
        for (const o of offsets) {
          const done = processed.get(o.partition);
          if (done !== undefined && owned(o.partition)) {
            metrics.lag.set({ partition: String(o.partition) }, Number(BigInt(o.high) - done));
          }
        }
      } catch (err) {
        log.debug({ err: String(err) }, 'lag poll failed');
      }
    })();
  }, 10_000);

  // ---- the loop ----------------------------------------------------------------------------------
  function decode(buf: Buffer): CanonicalEvent {
    return c.ENCODING === 'avro' ? decoder.decode(buf) : CanonicalEventSchema.parse(JSON.parse(buf.toString('utf8')));
  }

  await consumer.run({
    eachBatchAutoResolve: false,
    partitionsConsumedConcurrently: c.CONCURRENCY,
    eachBatch: async ({ batch, resolveOffset, isStale }) => {
      if (batch.messages.length === 0) return;
      const end = metrics.batchSeconds.startTimer();
      const p = batch.partition;
      const last = batch.messages[batch.messages.length - 1]!.offset;
      // watchdog: a batch that neither finishes nor fails in BATCH_TIMEOUT_MS is a hang; crash-only recovers it
      const watchdog = setTimeout(() => {
        log.fatal({ partition: p, timeoutMs: c.BATCH_TIMEOUT_MS }, 'batch stuck; exiting');
        (hooks.onFatal ?? (() => process.exit(1)))(new Error('batch timeout'));
      }, c.BATCH_TIMEOUT_MS);
      try {
        const ps = await partition(p);
        await ps.run(async () => {
          if (c.ENCODING === 'avro') await decoder.load(decoder.unknownIds(batch.messages.map((m) => m.value)));
          const events: InEvent[] = [];
          let bad = 0;
          for (const m of batch.messages) {
            try {
              if (!m.value) throw new Error('empty');
              const s = Number(header(m.headers, 'x-sent-at'));
              events.push({ event: decode(m.value), sentAt: Number.isFinite(s) && s > 0 ? s : null });
            } catch {
              bad++;
            }
          }
          const out = processBatch(ps, events, env);
          const latencies = await retry('incident write', () => sink.write(out.incidents, out.globalHits));
          telemetry?.add(p, events, out.scores);
          ps.offset = (BigInt(last) + 1n).toString();

          const now = Date.now();
          for (const e of events) if (e.sentAt) metrics.e2eSeconds.observe((now - e.sentAt) / 1000);
          for (const l of latencies) metrics.incidentLatencySeconds.observe(l / 1000);
          for (const i of out.incidents)
            metrics.incidents.inc({ action: i.message.action, family: i.message.fault_family });
          metrics.globalHits.inc(out.globalHits.length);
          metrics.events.inc({ result: 'applied' }, out.applied);
          metrics.events.inc({ result: 'skipped_seq' }, out.skipped);
          metrics.events.inc({ result: 'unknown_vin' }, out.unknownVin);
          metrics.events.inc({ result: 'bad' }, bad);
          stats.applied += out.applied;
          stats.skipped += out.skipped;
          stats.incidents += out.incidents.length;
          for (const i of out.incidents) {
            const m = i.message;
            if (m.action !== 'CLOSE') {
              log.info(
                { vin: m.vin, family: m.fault_family, action: m.action, severity: m.severity, event_ts: m.event_ts },
                'incident',
              );
            }
          }
          await hooks.afterBatch?.({ partition: p, lastOffset: last });
        });
      } catch (err) {
        // crash-only: the restart reloads the checkpoint and replays from the committed offset
        metrics.batchErrors.inc();
        log.fatal({ partition: p, err: String(err) }, 'batch failed after retries; exiting');
        (hooks.onFatal ?? (() => process.exit(1)))(err);
        return;
      } finally {
        clearTimeout(watchdog);
      }
      // A pause() (our back-pressure) also marks batches stale; only a revoke means the position must not move.
      if (isStale() && !owned(p)) return;
      resolveOffset(last);
      processed.set(p, BigInt(last) + 1n);
      end();
    },
  });
  healthy = true;
  log.info(
    { topic, group: c.GROUP_ID, telemetry: c.TELEMETRY, bucketMin: c.TELEMETRY_BUCKET_MIN },
    'state processor running',
  );

  const stop = async (crash = false) => {
    healthy = false;
    for (const t of [refreshTimer, ckTimer, bpTimer, lagTimer]) clearInterval(t);
    log.info({ crash }, 'shutting down');
    crashing = crash;
    if (!crash) {
      await checkpointAll('stop').catch(() => undefined);
      await telemetry?.close().catch(() => undefined);
    } else telemetry?.abort();
    await consumer.disconnect().catch(() => undefined);
    await repairConsumer.disconnect().catch(() => undefined);
    await producer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
    await store.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await new Promise((r) => server.close(r));
  };
  return { stats, checkpointAll: () => checkpointAll('stop'), stop: () => stop(false), kill: () => stop(true) };
}

// Run only when executed directly (`node dist/main.js`), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStateProcessor(loadConfig())
    .then((s) => {
      const exit = () => void s.stop().then(() => process.exit(0));
      process.on('SIGTERM', exit);
      process.on('SIGINT', exit);
    })
    .catch((err: unknown) => {
      log.fatal({ err }, 'state processor failed');
      process.exit(1);
    });
}
