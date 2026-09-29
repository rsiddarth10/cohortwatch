import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics for the state processor (GET /metrics, GET /healthz). */
export class StateMetrics {
  readonly registry = new Registry();
  readonly events: Counter<'result'>;
  readonly incidents: Counter<'action' | 'family'>;
  readonly globalHits: Counter;
  readonly checkpoints: Counter<'reason'>;
  readonly checkpointBytes: Gauge;
  readonly checkpointSeconds: Histogram;
  readonly batchErrors: Counter;
  readonly pauses: Counter<'reason'>;
  readonly paused: Gauge;
  readonly vans: Gauge;
  readonly peerEntries: Gauge;
  readonly lag: Gauge<'partition'>;
  readonly batchSeconds: Histogram;
  readonly e2eSeconds: Histogram;
  readonly incidentLatencySeconds: Histogram;
  readonly telemetryRows: Counter;
  readonly telemetryPending: Gauge;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'cw_state_' });
    const registers = [this.registry];
    const c = <L extends string>(name: string, help: string, labelNames: L[] = []) =>
      new Counter<L>({ name, help, labelNames, registers });
    const g = <L extends string>(name: string, help: string, labelNames: L[] = []) =>
      new Gauge<L>({ name, help, labelNames, registers });
    this.events = c('cw_state_events_total', 'Canonical events by result (applied, skipped_seq, unknown_vin, bad)', [
      'result',
    ]);
    this.incidents = c('cw_state_incidents_total', 'Incident actions written (Postgres + Kafka)', ['action', 'family']);
    this.globalHits = c('cw_state_global_rule_hits_total', 'Vans the simple global-threshold rule fired on (shadow)');
    this.checkpoints = c('cw_state_checkpoints_total', 'Partition checkpoints written to Redis', ['reason']);
    this.checkpointBytes = g('cw_state_checkpoint_bytes', 'Size of the last checkpoint written (bytes)');
    this.checkpointSeconds = new Histogram({
      name: 'cw_state_checkpoint_seconds',
      help: 'Wall time to serialise + write one partition checkpoint',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers,
    });
    this.batchErrors = c('cw_state_batch_errors_total', 'Batches that failed (state reset to the checkpoint)');
    this.pauses = c('cw_state_pauses_total', 'Times consumption was paused for back-pressure', ['reason']);
    this.paused = g('cw_state_paused', '1 while consumption is paused');
    this.vans = g('cw_state_vans', 'Vans held in memory by this replica');
    this.peerEntries = g('cw_state_peer_entries', 'Peer-context entries held by this replica');
    this.lag = g('cw_state_consumer_lag', 'High watermark minus processed offset, per owned partition', ['partition']);
    this.batchSeconds = new Histogram({
      name: 'cw_state_batch_seconds',
      help: 'Wall time to process one batch (decode → detect → incident writes)',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    const latencyBuckets = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 60, 120];
    this.e2eSeconds = new Histogram({
      name: 'cw_state_e2e_seconds',
      help: 'Wall time from x-sent-at (simulator send) to the event being applied here',
      buckets: latencyBuckets,
      registers,
    });
    this.incidentLatencySeconds = new Histogram({
      name: 'cw_state_incident_latency_seconds',
      help: 'Wall time from x-sent-at of the confirming reading to the incident written (Postgres + Kafka)',
      buckets: latencyBuckets,
      registers,
    });
    this.telemetryRows = c('cw_state_telemetry_rows_total', 'Down-sampled telemetry rows written');
    this.telemetryPending = g('cw_state_telemetry_pending_rows', 'Closed telemetry buckets waiting to be written');
  }

  serve(port: number, healthy: () => boolean, json: Record<string, () => unknown> = {}): Server {
    const server = createServer((req, res) => {
      if (req.url === '/metrics') {
        this.registry
          .metrics()
          .then((body) => {
            res.writeHead(200, { 'content-type': this.registry.contentType });
            res.end(body);
          })
          .catch(() => res.writeHead(500).end());
      } else if (req.url === '/healthz') {
        const ok = healthy();
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok }));
      } else if (req.url && json[req.url]) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json[req.url]()));
      } else res.writeHead(404).end();
    });
    return server.listen(port);
  }
}
