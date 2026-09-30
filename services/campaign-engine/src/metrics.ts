import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics for the campaign engine (GET /metrics, GET /healthz). */
export class EngineMetrics {
  readonly registry = new Registry();
  readonly incidents: Counter<'action' | 'result'>;
  readonly events: Counter<'type'>;
  readonly published: Counter;
  readonly outboxBacklog: Gauge;
  readonly leader: Gauge;
  readonly paused: Gauge;
  readonly lag: Gauge<'partition'>;
  readonly batchSeconds: Histogram;
  readonly openLatencySeconds: Histogram<'from'>;
  readonly publishDelaySeconds: Histogram;
  readonly atRiskSeconds: Histogram;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'cw_camp_' });
    const registers = [this.registry];
    this.incidents = new Counter({
      name: 'cw_camp_incidents_total',
      help: 'Incident actions consumed, by result (applied, duplicate, bad)',
      labelNames: ['action', 'result'],
      registers,
    });
    this.events = new Counter({
      name: 'cw_camp_events_total',
      help: 'Campaign events written to the outbox',
      labelNames: ['type'],
      registers,
    });
    this.published = new Counter({
      name: 'cw_camp_published_total',
      help: 'Outbox rows published to Kafka',
      registers,
    });
    this.outboxBacklog = new Gauge({ name: 'cw_camp_outbox_backlog', help: 'Unpublished outbox rows', registers });
    this.leader = new Gauge({
      name: 'cw_camp_leader',
      help: '1 while this replica runs the relay and timers',
      registers,
    });
    this.paused = new Gauge({ name: 'cw_camp_paused', help: '1 while consumption is paused', registers });
    this.lag = new Gauge({
      name: 'cw_camp_consumer_lag',
      help: 'High watermark minus processed offset',
      labelNames: ['partition'],
      registers,
    });
    const buckets = [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 30, 60, 120, 300];
    this.batchSeconds = new Histogram({
      name: 'cw_camp_batch_seconds',
      help: 'Wall time per consumed batch',
      buckets,
      registers,
    });
    this.openLatencySeconds = new Histogram({
      name: 'cw_camp_open_latency_seconds',
      help: 'Wall time to a campaign OPENED commit, from the incident write (x-incident-at) or the reading (x-sent-at)',
      labelNames: ['from'],
      buckets,
      registers,
    });
    this.publishDelaySeconds = new Histogram({
      name: 'cw_camp_publish_delay_seconds',
      help: 'Outbox row created → published to Kafka',
      buckets,
      registers,
    });
    this.atRiskSeconds = new Histogram({
      name: 'cw_camp_at_risk_refresh_seconds',
      help: 'Wall time of one at-risk refresh round',
      buckets,
      registers,
    });
  }

  serve(port: number, healthy: () => boolean): Server {
    const server = createServer((req, res) => {
      if (req.url === '/metrics') {
        this.registry
          .metrics()
          .then((body) => res.writeHead(200, { 'content-type': this.registry.contentType }).end(body))
          .catch(() => res.writeHead(500).end());
      } else if (req.url === '/healthz') {
        const ok = healthy();
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }));
      } else res.writeHead(404).end();
    });
    return server.listen(port);
  }
}
