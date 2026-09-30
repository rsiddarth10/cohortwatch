import { pathToFileURL } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createLogger } from '@cw/common';
import { IncidentMessageSchema, type CampaignEvent } from '@cw/domain';
import pg from 'pg';
import { loadConfig, type EngineConfig } from './config.js';
import { CampaignEngine } from './engine.js';
import { EngineMetrics } from './metrics.js';
import { EngineRegistry } from './registry.js';
import { Leader, OutboxRelay, seedPastCampaigns } from './relay.js';

/**
 * S5 campaign engine: incidents.v1 (key = family key, so one key lives in one partition = one writer) →
 * campaigns in Postgres + outbox → campaign.events.v1 (via the relay).
 *
 * Per record: one transaction (idempotency row, book, members, clues, at-risk, outbox). Offsets are committed after
 * the batch's transactions. The leader (advisory lock) runs the outbox relay and the hourly (event-time) at-risk
 * refresh. S3 lessons: batch watchdog, Postgres timeouts, stale-batch rule, crash-only exit after retries.
 */
let log = createLogger('campaign-engine', process.env.LOG_LEVEL ?? 'info');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn({ err: String(err), attempt: i }, `${what} failed; retrying`);
      await sleep(300 * i);
    }
  }
}

function header(h: KafkaJS.IHeaders | undefined, name: string): number | null {
  const v = h?.[name];
  const x = Array.isArray(v) ? v[0] : v;
  const n = x === undefined ? NaN : Number(x.toString());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface EngineHooks {
  onFatal?: (err: unknown) => void;
}

export interface RunningEngine {
  engine: CampaignEngine;
  stats: { applied: number; duplicates: number; events: number; published: number };
  stop(): Promise<void>;
  /** Crash emulation (tests): disconnect without finishing anything. */
  kill(): Promise<void>;
}

export async function startCampaignEngine(c: EngineConfig, hooks: EngineHooks = {}): Promise<RunningEngine> {
  log = createLogger('campaign-engine', c.LOG_LEVEL);
  const fatal = hooks.onFatal ?? (() => process.exit(1));
  const metrics = new EngineMetrics();
  const stats = { applied: 0, duplicates: 0, events: 0, published: 0 };
  let healthy = false;
  const server = metrics.serve(c.METRICS_PORT, () => healthy);

  const pool = new pg.Pool({
    connectionString: c.DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
    keepAlive: true,
  });
  const registry = new EngineRegistry(pool);
  await retry('registry load', () => registry.load(), 30);
  const seeded = await retry('past campaigns', () => seedPastCampaigns(pool));
  log.info({ vans: registry.size, pastCampaignsSeeded: seeded, alpha: c.campaign.alpha }, 'registry loaded');
  const refreshTimer = setInterval(() => {
    registry.load().catch((err: unknown) => log.warn({ err: String(err) }, 'registry refresh failed'));
  }, c.REGISTRY_REFRESH_MS);

  const engine = new CampaignEngine(pool, registry, c.campaign, c.OUTPUT_TOPIC);
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: c.KAFKA_BROKERS.split(','), clientId: 'cw-campaign-engine', logLevel: KafkaJS.logLevel.WARN },
  });
  const producer = kafka.producer({ 'linger.ms': 5, kafkaJS: { idempotent: true, acks: -1 } });
  await producer.connect();
  const relay = new OutboxRelay(pool, producer, c.OUTBOX_BATCH);
  const leader = new Leader(pool);

  const countEvents = (events: readonly CampaignEvent[]) => {
    for (const e of events) metrics.events.inc({ type: e.type });
    stats.events += events.length;
  };

  // ---- leader: outbox relay + hourly at-risk refresh (event time) --------------------------------
  let relaying = false;
  let stopping = false;
  const relayTimer = setInterval(() => {
    if (relaying || stopping) return;
    relaying = true;
    void (async () => {
      try {
        const lead = await leader.isLeader();
        metrics.leader.set(lead ? 1 : 0);
        if (!lead) return;
        for (;;) {
          const r = await relay.publishOnce();
          if (r.published === 0) break;
          stats.published += r.published;
          metrics.published.inc(r.published);
          for (const d of r.delaysMs) metrics.publishDelaySeconds.observe(d / 1000);
        }
        metrics.outboxBacklog.set(await relay.backlog());
      } catch (err) {
        log.warn({ err: String(err) }, 'outbox relay round failed');
        leader.release();
      } finally {
        relaying = false;
      }
    })();
  }, c.OUTBOX_POLL_MS);

  let lastHour = -1;
  let refreshing = false;
  const atRiskTimer = setInterval(() => {
    if (refreshing || stopping) return;
    refreshing = true;
    void (async () => {
      try {
        if (!(await leader.isLeader())) return;
        const r = await pool.query<{ ts: Date | null }>('SELECT max(ts) AS ts FROM core.telemetry');
        if (!r.rows[0]!.ts) return;
        const simNow = r.rows[0]!.ts.getTime() + HOUR; // the newest closed hourly bucket ends here
        const step = Math.floor(simNow / (c.campaign.atRisk.everySimH * HOUR));
        if (step <= lastHour) return;
        const end = metrics.atRiskSeconds.startTimer();
        const events = await engine.refreshOpen(simNow);
        end();
        countEvents(events);
        lastHour = step;
      } catch (err) {
        log.warn({ err: String(err) }, 'at-risk refresh failed');
      } finally {
        refreshing = false;
      }
    })();
  }, c.AT_RISK_POLL_MS);

  // ---- consumer ----------------------------------------------------------------------------------
  const consumer = kafka.consumer({
    'js.consumer.max.batch.size': 500,
    kafkaJS: {
      groupId: c.GROUP_ID,
      fromBeginning: c.FROM_BEGINNING === 'true',
      autoCommit: false,
      partitionAssigners: [KafkaJS.PartitionAssigners.cooperativeSticky],
    },
  });
  const admin = kafka.admin();
  await Promise.all([consumer.connect(), admin.connect()]);
  await consumer.subscribe({ topics: [c.INPUT_TOPIC] });
  const owned = (p: number) => consumer.assignment().some((a) => a.topic === c.INPUT_TOPIC && a.partition === p);
  const processed = new Map<number, bigint>();

  // back-pressure: pause while the outbox backlog is large (the relay or Kafka is behind)
  let paused = false;
  const bpTimer = setInterval(() => {
    void relay
      .backlog()
      .then((n) => {
        metrics.outboxBacklog.set(n);
        if (!paused && n > c.MAX_OUTBOX_BACKLOG) {
          consumer.pause([{ topic: c.INPUT_TOPIC }]);
          paused = true;
          metrics.paused.set(1);
          log.warn({ backlog: n }, 'back-pressure: paused');
        } else if (paused && n < c.MAX_OUTBOX_BACKLOG / 2) {
          consumer.resume([{ topic: c.INPUT_TOPIC }]);
          paused = false;
          metrics.paused.set(0);
          log.info({ backlog: n }, 'back-pressure: resumed');
        }
      })
      .catch(() => undefined);
  }, 1000);
  const lagTimer = setInterval(() => {
    void admin
      .fetchTopicOffsets(c.INPUT_TOPIC)
      .then((offsets) => {
        metrics.lag.reset();
        for (const o of offsets) {
          const done = processed.get(o.partition);
          if (done !== undefined && owned(o.partition))
            metrics.lag.set({ partition: String(o.partition) }, Number(BigInt(o.high) - done));
        }
      })
      .catch(() => undefined);
  }, 10_000);

  await consumer.run({
    eachBatchAutoResolve: false,
    partitionsConsumedConcurrently: 8,
    eachBatch: async ({ batch, resolveOffset, isStale }) => {
      if (batch.messages.length === 0) return;
      const end = metrics.batchSeconds.startTimer();
      const p = batch.partition;
      const last = batch.messages[batch.messages.length - 1]!.offset;
      const watchdog = setTimeout(() => {
        log.fatal({ partition: p, timeoutMs: c.BATCH_TIMEOUT_MS }, 'batch stuck; exiting');
        fatal(new Error('batch timeout'));
      }, c.BATCH_TIMEOUT_MS);
      try {
        for (const msg of batch.messages) {
          const parsed = IncidentMessageSchema.safeParse(msg.value ? JSON.parse(msg.value.toString()) : null);
          if (!parsed.success) {
            metrics.incidents.inc({ action: 'unknown', result: 'bad' });
            continue;
          }
          const m = parsed.data;
          const r = await retry('campaign transaction', () => engine.onIncident(m));
          metrics.incidents.inc({ action: m.action, result: r.duplicate ? 'duplicate' : 'applied' });
          if (r.duplicate) stats.duplicates++;
          else stats.applied++;
          countEvents(r.events);
          const now = Date.now();
          for (const e of r.events.filter((x) => x.type === 'OPENED')) {
            const incAt = header(msg.headers, 'x-incident-at');
            const sentAt = header(msg.headers, 'x-sent-at');
            if (incAt) metrics.openLatencySeconds.observe({ from: 'incident' }, (now - incAt) / 1000);
            if (sentAt) metrics.openLatencySeconds.observe({ from: 'reading' }, (now - sentAt) / 1000);
            log.info({ campaign: e.campaignId, key: e.familyKey, members: e.members }, 'campaign OPENED');
          }
        }
      } catch (err) {
        log.fatal({ partition: p, err: String(err) }, 'batch failed after retries; exiting');
        fatal(err);
        return;
      } finally {
        clearTimeout(watchdog);
      }
      // A pause() also marks batches stale; only a revoke means the position must not move.
      if (isStale() && !owned(p)) return;
      const next = (BigInt(last) + 1n).toString();
      await consumer.commitOffsets([{ topic: batch.topic, partition: p, offset: next }]).catch((err: unknown) => {
        log.info({ partition: p, err: String(err) }, 'commit failed (partition moved?)');
      });
      resolveOffset(last);
      processed.set(p, BigInt(next));
      end();
    },
  });
  healthy = true;
  log.info({ topic: c.INPUT_TOPIC, group: c.GROUP_ID }, 'campaign engine running');

  const stop = async (crash = false) => {
    healthy = false;
    stopping = true;
    for (const t of [refreshTimer, relayTimer, atRiskTimer, bpTimer, lagTimer]) clearInterval(t);
    log.info({ crash }, 'shutting down');
    leader.release();
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await new Promise((r) => server.close(r));
  };
  return { engine, stats, stop: () => stop(false), kill: () => stop(true) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCampaignEngine(loadConfig())
    .then((s) => {
      const exit = () => void s.stop().then(() => process.exit(0));
      process.on('SIGTERM', exit);
      process.on('SIGINT', exit);
    })
    .catch((err: unknown) => {
      log.fatal({ err }, 'campaign engine failed');
      process.exit(1);
    });
}
