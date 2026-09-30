import { pathToFileURL } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createLogger } from '@cw/common';
import { IncidentMessageSchema } from '@cw/domain';
import pg from 'pg';
import { loadConfig, type WorkshopConfig } from './config.js';
import { WorkshopMetrics } from './metrics.js';
import { WorkshopRegistry } from './registry.js';
import { Leader, OutboxRelay } from './relay.js';
import { Workshop, type CampaignEventMsg, type RepairMsg } from './workshop.js';

/**
 * S4 + S6 workshop service: incidents.v1 + campaign.events.v1 + workshop.repairs.v1 → the daily queue per depot
 * (core.queue_item, versioned + snapshots), runaway/campaign cards, repairs and their confirmed outcomes; changes
 * leave through the outbox (queue.events.v1, workshop.outcomes.v1). The advisory-lock leader runs the relay and
 * the hourly event-time tick. S3/S5 lessons: batch watchdog, Postgres timeouts, stale-batch rule, crash-only.
 */
let log = createLogger('workshop', process.env.LOG_LEVEL ?? 'info');
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

export interface WorkshopHooks {
  onFatal?: (err: unknown) => void;
}

export interface RunningWorkshop {
  workshop: Workshop;
  stats: { applied: number; duplicates: number; versions: number; outcomes: number; published: number };
  /** Run the hourly tick now (tests). */
  tick(simNow: number): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

export async function startWorkshop(c: WorkshopConfig, hooks: WorkshopHooks = {}): Promise<RunningWorkshop> {
  log = createLogger('workshop', c.LOG_LEVEL);
  const fatal = hooks.onFatal ?? (() => process.exit(1));
  const metrics = new WorkshopMetrics();
  const stats = { applied: 0, duplicates: 0, versions: 0, outcomes: 0, published: 0 };
  let healthy = false;
  const server = metrics.serve(c.METRICS_PORT, () => healthy);

  const pool = new pg.Pool({ connectionString: c.DATABASE_URL, max: 6, connectionTimeoutMillis: 10_000, query_timeout: 60_000, keepAlive: true }); // prettier-ignore
  const registry = new WorkshopRegistry(pool);
  await retry('registry load', () => registry.load(), 30);
  log.info({ vans: registry.size, depots: registry.depots().length }, 'registry loaded');
  const refreshTimer = setInterval(() => {
    registry.load().catch((err: unknown) => log.warn({ err: String(err) }, 'registry refresh failed'));
  }, c.REGISTRY_REFRESH_MS);

  const workshop = new Workshop(pool, registry, c.queue, c.fix, { queue: c.QUEUE_TOPIC, outcomes: c.OUTCOMES_TOPIC });
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: c.KAFKA_BROKERS.split(','), clientId: 'cw-workshop', logLevel: KafkaJS.logLevel.WARN },
  });
  const producer = kafka.producer({ 'linger.ms': 5, kafkaJS: { idempotent: true, acks: -1 } });
  await producer.connect();
  const relay = new OutboxRelay(pool, producer, c.OUTBOX_BATCH, [c.QUEUE_TOPIC, c.OUTCOMES_TOPIC]);
  const leader = new Leader(pool);
  let stopping = false;

  // ---- leader: outbox relay ----------------------------------------------------------------------
  let relaying = false;
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
      } catch (err) {
        log.warn({ err: String(err) }, 'outbox relay round failed');
        leader.release();
      } finally {
        relaying = false;
      }
    })();
  }, c.OUTBOX_POLL_MS);

  // ---- leader: hourly tick in event time (fix confirmation, then every depot) ---------------------
  const tick = async (simNow: number) => {
    const end = metrics.tickSeconds.startTimer();
    const decided = await workshop.judgeRepairs(simNow);
    for (const o of decided) {
      metrics.outcomes.inc({ outcome: o.outcome });
      log.info({ vin: o.vin, outcome: o.outcome, text: o.text }, 'repair outcome');
    }
    stats.outcomes += decided.length;
    const rebuilt = await workshop.refreshAll(simNow);
    const changed = rebuilt.filter((r) => r.changed).length;
    stats.versions += changed;
    metrics.queueVersions.inc(changed);
    end();
  };
  let lastStep = -1;
  let ticking = false;
  const tickTimer = setInterval(() => {
    if (ticking || stopping) return;
    ticking = true;
    void (async () => {
      try {
        if (!(await leader.isLeader())) return;
        const r = await pool.query<{ ts: Date | null }>('SELECT max(ts) AS ts FROM core.telemetry');
        if (!r.rows[0]!.ts) return;
        const simNow = r.rows[0]!.ts.getTime() + HOUR; // the newest closed hourly bucket ends here
        const step = Math.floor(simNow / HOUR);
        if (step <= lastStep) return;
        await tick(simNow);
        lastStep = step;
      } catch (err) {
        log.warn({ err: String(err) }, 'hourly tick failed');
      } finally {
        ticking = false;
      }
    })();
  }, c.TICK_POLL_MS);

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
  await consumer.connect();
  await consumer.subscribe({ topics: [c.INCIDENT_TOPIC, c.CAMPAIGN_TOPIC, c.REPAIRS_TOPIC, c.PROPOSALS_TOPIC] });
  const owned = (topic: string, p: number) => consumer.assignment().some((a) => a.topic === topic && a.partition === p);

  let paused = false;
  const bpTimer = setInterval(() => {
    void relay
      .backlog()
      .then((n) => {
        metrics.outboxBacklog.set(n);
        const topics = [c.INCIDENT_TOPIC, c.CAMPAIGN_TOPIC, c.REPAIRS_TOPIC, c.PROPOSALS_TOPIC].map((topic) => ({
          topic,
        }));
        if (!paused && n > c.MAX_OUTBOX_BACKLOG) {
          consumer.pause(topics);
          paused = true;
          metrics.paused.set(1);
          log.warn({ backlog: n }, 'back-pressure: paused');
        } else if (paused && n < c.MAX_OUTBOX_BACKLOG / 2) {
          consumer.resume(topics);
          paused = false;
          metrics.paused.set(0);
          log.info({ backlog: n }, 'back-pressure: resumed');
        }
      })
      .catch(() => undefined);
  }, 1000);

  await consumer.run({
    eachBatchAutoResolve: false,
    partitionsConsumedConcurrently: 8,
    eachBatch: async ({ batch, resolveOffset, isStale }) => {
      if (batch.messages.length === 0) return;
      const p = batch.partition;
      const last = batch.messages[batch.messages.length - 1]!.offset;
      const watchdog = setTimeout(() => {
        log.fatal({ topic: batch.topic, partition: p, timeoutMs: c.BATCH_TIMEOUT_MS }, 'batch stuck; exiting');
        fatal(new Error('batch timeout'));
      }, c.BATCH_TIMEOUT_MS);
      try {
        for (const msg of batch.messages) {
          const end = metrics.rebuildSeconds.startTimer();
          let raw: unknown = null;
          try {
            raw = msg.value ? JSON.parse(msg.value.toString()) : null;
          } catch {
            raw = null;
          }
          if (batch.topic === c.INCIDENT_TOPIC) {
            const m = IncidentMessageSchema.safeParse(raw);
            if (!m.success) {
              metrics.consumed.inc({ source: 'incident', result: 'bad' });
              continue;
            }
            const incAt = header(msg.headers, 'x-incident-at');
            const r = await retry('incident transaction', () => workshop.onIncident(m.data, incAt));
            metrics.consumed.inc({ source: 'incident', result: r ? 'applied' : 'duplicate' });
            if (r?.changed) {
              stats.versions++;
              metrics.queueVersions.inc();
              if (incAt) metrics.updateLatencySeconds.observe((Date.now() - incAt) / 1000);
            }
            if (r && m.data.runaway && r.top === m.data.vin && incAt) {
              metrics.criticalToTopSeconds.observe((Date.now() - incAt) / 1000);
              log.info({ vin: m.data.vin, depot: r.depotId }, 'runaway at the top of its depot queue');
            }
            if (r) stats.applied++;
            else stats.duplicates++;
          } else if (batch.topic === c.CAMPAIGN_TOPIC) {
            const e = raw as CampaignEventMsg | null;
            if (!e || typeof e.eventId !== 'string' || typeof e.campaignId !== 'string') {
              metrics.consumed.inc({ source: 'campaign', result: 'bad' });
              continue;
            }
            const r = await retry('campaign transaction', () => workshop.onCampaignEvent(e));
            metrics.consumed.inc({ source: 'campaign', result: r ? 'applied' : 'duplicate' });
            if (r?.changed) {
              stats.versions++;
              metrics.queueVersions.inc();
            }
          } else if (batch.topic === c.PROPOSALS_TOPIC) {
            const e = raw as { type?: string; proposal_id?: string; depot_id?: number | null } | null;
            if (!e || typeof e.type !== 'string' || typeof e.proposal_id !== 'string') {
              metrics.consumed.inc({ source: 'proposal', result: 'bad' });
              continue;
            }
            const r = await retry('proposal transaction', () =>
              workshop.onProposalDecision({ type: e.type!, proposal_id: e.proposal_id!, depot_id: e.depot_id ?? null }),
            );
            metrics.consumed.inc({ source: 'proposal', result: r ? 'applied' : 'duplicate' });
            if (r?.changed) {
              stats.versions++;
              metrics.queueVersions.inc();
              log.info(
                { depot: r.depotId, proposal: e.proposal_id, type: e.type },
                'proposal decision applied to the queue',
              );
            }
          } else {
            const rp = raw as RepairMsg | null;
            if (!rp || typeof rp.vin !== 'string' || typeof rp.repaired_at !== 'string') {
              metrics.consumed.inc({ source: 'repair', result: 'bad' });
              continue;
            }
            const r = await retry('repair transaction', () => workshop.onRepair(rp));
            metrics.consumed.inc({ source: 'repair', result: r ? 'applied' : 'duplicate' });
            if (r)
              log.info({ vin: rp.vin, repaired_at: rp.repaired_at }, 'repair recorded; watching its next driven hours');
          }
          end();
        }
      } catch (err) {
        log.fatal({ topic: batch.topic, partition: p, err: String(err) }, 'batch failed after retries; exiting');
        fatal(err);
        return;
      } finally {
        clearTimeout(watchdog);
      }
      if (isStale() && !owned(batch.topic, p)) return;
      const next = (BigInt(last) + 1n).toString();
      await consumer.commitOffsets([{ topic: batch.topic, partition: p, offset: next }]).catch((err: unknown) => {
        log.info({ partition: p, err: String(err) }, 'commit failed (partition moved?)');
      });
      resolveOffset(last);
    },
  });
  healthy = true;
  log.info({ group: c.GROUP_ID }, 'workshop running');

  const stop = async (crash = false) => {
    healthy = false;
    stopping = true;
    for (const t of [refreshTimer, relayTimer, tickTimer, bpTimer]) clearInterval(t);
    log.info({ crash }, 'shutting down');
    leader.release();
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await new Promise((r) => server.close(r));
  };
  return { workshop, stats, tick, stop: () => stop(false), kill: () => stop(true) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorkshop(loadConfig())
    .then((s) => {
      const exit = () => void s.stop().then(() => process.exit(0));
      process.on('SIGTERM', exit);
      process.on('SIGINT', exit);
    })
    .catch((err: unknown) => {
      log.fatal({ err }, 'workshop failed');
      process.exit(1);
    });
}
