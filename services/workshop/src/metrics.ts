import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics for the workshop service (GET /metrics, GET /healthz). */
export class WorkshopMetrics {
  readonly registry = new Registry();
  readonly consumed: Counter<'source' | 'result'>;
  readonly queueVersions: Counter;
  readonly outcomes: Counter<'outcome'>;
  readonly published: Counter;
  readonly outboxBacklog: Gauge;
  readonly leader: Gauge;
  readonly paused: Gauge;
  readonly updateLatencySeconds: Histogram;
  readonly criticalToTopSeconds: Histogram;
  readonly rebuildSeconds: Histogram;
  readonly tickSeconds: Histogram;
  readonly publishDelaySeconds: Histogram;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'cw_ws_' });
    const registers = [this.registry];
    const buckets = [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 30, 60, 120, 300];
    this.consumed = new Counter({
      name: 'cw_ws_consumed_total',
      help: 'Events consumed, by source (incident, campaign, repair) and result (applied, duplicate, bad)',
      labelNames: ['source', 'result'],
      registers,
    });
    this.queueVersions = new Counter({
      name: 'cw_ws_queue_versions_total',
      help: 'Depot queue versions written',
      registers,
    });
    this.outcomes = new Counter({
      name: 'cw_ws_outcomes_total',
      help: 'Repair outcomes decided',
      labelNames: ['outcome'],
      registers,
    });
    this.published = new Counter({ name: 'cw_ws_published_total', help: 'Outbox rows published', registers });
    this.outboxBacklog = new Gauge({
      name: 'cw_ws_outbox_backlog',
      help: 'Unpublished outbox rows (own topics)',
      registers,
    });
    this.leader = new Gauge({
      name: 'cw_ws_leader',
      help: '1 while this replica runs the relay and the hourly tick',
      registers,
    });
    this.paused = new Gauge({ name: 'cw_ws_paused', help: '1 while consumption is paused', registers });
    this.updateLatencySeconds = new Histogram({
      name: 'cw_ws_queue_update_latency_seconds',
      help: 'Incident written upstream (x-incident-at) → its depot queue version committed',
      buckets,
      registers,
    });
    this.criticalToTopSeconds = new Histogram({
      name: 'cw_ws_critical_to_top_seconds',
      help: 'Runaway incident written upstream (x-incident-at) → the van at rank 1 of its depot queue (committed)',
      buckets,
      registers,
    });
    this.rebuildSeconds = new Histogram({
      name: 'cw_ws_event_seconds',
      help: 'Wall time per consumed event (transaction incl. rebuild)',
      buckets,
      registers,
    });
    this.tickSeconds = new Histogram({
      name: 'cw_ws_tick_seconds',
      help: 'Wall time of one hourly tick (fix confirmation + all depots)',
      buckets,
      registers,
    });
    this.publishDelaySeconds = new Histogram({
      name: 'cw_ws_publish_delay_seconds',
      help: 'Outbox row created → published',
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
