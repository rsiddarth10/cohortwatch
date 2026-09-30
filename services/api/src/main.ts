import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createLogger } from '@cw/common';
import pg from 'pg';
import { createApp, type LiveEvent, type Publisher } from './app.js';
import { remoteVerifier } from './auth.js';
import { loadConfig, type ApiConfig } from './config.js';
import { Leader, OutboxRelay } from './relay.js';

/**
 * S7 API process: the Express app + a Kafka publisher (repairs) + the SSE feed (queue, campaign and proposal topics,
 * plus new cards polled per tenant) + the outbox relay for audit.v1 and agent.proposals.v1 (advisory-lock leader).
 */
const log = createLogger('api', process.env.LOG_LEVEL ?? 'info');

export async function startApi(c: ApiConfig): Promise<{ stop(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: c.DATABASE_URL, max: 10, connectionTimeoutMillis: 10_000, query_timeout: 30_000, keepAlive: true }); // prettier-ignore
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: c.KAFKA_BROKERS.split(','), clientId: 'cw-api', logLevel: KafkaJS.logLevel.WARN },
  });
  const producer = kafka.producer({ 'linger.ms': 5, kafkaJS: { idempotent: true, acks: -1 } });
  await producer.connect();
  const publisher: Publisher = {
    publish: async (topic, key, value) => {
      await producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(value), headers: { 'x-sent-at': String(Date.now()) } }],
      });
    },
  };
  const bus = new EventEmitter();
  bus.setMaxListeners(1000);

  // ---- SSE feed ----------------------------------------------------------------------------------
  const depotTenant = new Map<number, number>();
  const tenantOfDepot = async (depot: number): Promise<number | null> => {
    if (!depotTenant.has(depot)) {
      const r = await pool.query<{ t: number | null }>('SELECT core.depot_tenant($1) AS t', [depot]);
      if (r.rows[0]?.t != null) depotTenant.set(depot, r.rows[0].t);
    }
    return depotTenant.get(depot) ?? null;
  };
  const consumer = kafka.consumer({
    kafkaJS: { groupId: `cg.api.sse.${randomUUID()}`, fromBeginning: false, autoCommit: true },
  });
  await consumer.connect();
  await consumer.subscribe({ topics: c.SSE_TOPICS.split(',') });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const v = JSON.parse(message.value?.toString() ?? '{}') as Record<string, unknown>;
        let depot: number | null = null;
        let type = topic;
        if (topic.startsWith('queue.')) {
          depot = Number(v.depot_id);
          type = 'queue';
        } else if (topic.startsWith('campaign.')) {
          depot = Number(String(v.familyKey ?? '').split('|')[3]);
          type = 'campaign';
        } else if (topic.startsWith('agent.')) {
          depot = v.depot_id == null ? null : Number(v.depot_id);
          type = 'proposal';
        }
        const tenantId =
          depot !== null && Number.isFinite(depot) ? await tenantOfDepot(depot) : Number(v.tenant_id ?? NaN);
        if (tenantId === null || !Number.isFinite(tenantId)) return;
        bus.emit('event', { tenantId, type, data: v } satisfies LiveEvent);
      } catch (err) {
        log.debug({ err: String(err) }, 'sse feed: skipped a message');
      }
    },
  });
  // cards are rows (written by the workshop): poll new ones per tenant
  let lastCard = new Date();
  const cardTimer = setInterval(() => {
    void (async () => {
      const since = lastCard;
      lastCard = new Date();
      const tenants = (await pool.query<{ id: number }>('SELECT id FROM core.tenant')).rows;
      for (const t of tenants) {
        const cl = await pool.connect();
        try {
          await cl.query('BEGIN');
          await cl.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(t.id)]);
          const r = await cl.query(`SELECT id, card_type, depot_id, vin::text AS vin, campaign_id, title, created_at FROM core.alert_card WHERE created_at > $1 ORDER BY created_at`, [since]); // prettier-ignore
          await cl.query('COMMIT');
          for (const card of r.rows)
            bus.emit('event', { tenantId: t.id, type: 'card', data: card } satisfies LiveEvent);
        } finally {
          cl.release();
        }
      }
    })().catch((err: unknown) => log.debug({ err: String(err) }, 'card poll failed'));
  }, 2000);

  // ---- outbox relay (audit.v1, agent.proposals.v1) ------------------------------------------------
  const relay = new OutboxRelay(pool, producer, 500, [c.AUDIT_TOPIC, c.PROPOSALS_TOPIC]);
  const leader = new Leader(pool, 0x5c7);
  let relaying = false;
  const relayTimer = setInterval(() => {
    if (relaying) return;
    relaying = true;
    void (async () => {
      try {
        if (!(await leader.isLeader())) return;
        while ((await relay.publishOnce()).published > 0);
      } catch (err) {
        log.warn({ err: String(err) }, 'outbox relay round failed');
        leader.release();
      } finally {
        relaying = false;
      }
    })();
  }, 250);

  const app = createApp({
    pool,
    verify: remoteVerifier(c.OIDC_JWKS_URL, c.OIDC_ISSUER, c.API_AUDIENCE),
    publisher,
    bus,
    topics: { audit: c.AUDIT_TOPIC, repairs: c.REPAIRS_TOPIC, proposals: c.PROPOSALS_TOPIC },
    rateLimitPerMin: c.RATE_LIMIT_PER_MIN,
  });
  const server = app.listen(c.PORT);
  log.info({ port: c.PORT, issuer: c.OIDC_ISSUER }, 'api running');
  return {
    stop: async () => {
      clearInterval(cardTimer);
      clearInterval(relayTimer);
      leader.release();
      await new Promise((r) => server.close(r));
      await consumer.disconnect().catch(() => undefined);
      await producer.disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApi(loadConfig())
    .then((s) => {
      const exit = () => void s.stop().then(() => process.exit(0));
      process.on('SIGTERM', exit);
      process.on('SIGINT', exit);
    })
    .catch((err: unknown) => {
      log.fatal({ err }, 'api failed');
      process.exit(1);
    });
}
