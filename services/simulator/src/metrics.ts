import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics for the simulator (served by the main process, fed by workers over IPC). */
export class SimMetrics {
  readonly registry = new Registry();
  readonly sent: Counter<'topic' | 'format'>;
  readonly rate: Gauge<'topic' | 'format'>;
  readonly rateTotal: Gauge;
  readonly sendErrors: Counter;
  readonly vehicles: Gauge;
  readonly workersReady: Gauge;
  readonly simTime: Gauge;
  readonly mess: Counter<'kind'>;
  readonly lag: Gauge;
  readonly queued: Gauge;
  readonly repairs: Counter<'outcome'>;

  private readonly totals = new Map<string, number>();
  private window: { at: number; totals: Map<string, number> } = { at: Date.now(), totals: new Map() };

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'cw_sim_' });
    const registers = [this.registry];
    this.sent = new Counter({
      name: 'cw_sim_messages_sent_total',
      help: 'Messages acknowledged by Kafka, by topic and payload format',
      labelNames: ['topic', 'format'],
      registers,
    });
    this.rate = new Gauge({
      name: 'cw_sim_messages_per_second',
      help: 'Send rate over the last 5 s window (wall clock), by topic and format',
      labelNames: ['topic', 'format'],
      registers,
    });
    this.rateTotal = new Gauge({
      name: 'cw_sim_messages_per_second_total',
      help: 'Total send rate over the last 5 s window (wall clock)',
      registers,
    });
    this.sendErrors = new Counter({ name: 'cw_sim_send_errors_total', help: 'Failed Kafka send batches', registers });
    this.vehicles = new Gauge({ name: 'cw_sim_vehicles', help: 'Simulated vehicles (configured N)', registers });
    this.workersReady = new Gauge({ name: 'cw_sim_workers_ready', help: 'Worker processes streaming', registers });
    this.simTime = new Gauge({ name: 'cw_sim_clock_seconds', help: 'Current simulated time (epoch s)', registers });
    this.mess = new Counter({
      name: 'cw_sim_mess_total',
      help: 'Messages given each kind of mess (brief 5.5), counted when generated',
      labelNames: ['kind'],
      registers,
    });
    this.lag = new Gauge({
      name: 'cw_sim_clock_lag_seconds',
      help: 'Max wall seconds any worker is behind the simulated clock (0 = keeping up)',
      registers,
    });
    this.queued = new Gauge({ name: 'cw_sim_release_queue', help: 'Messages held for delayed release', registers });
    this.repairs = new Counter({
      name: 'cw_sim_repairs_total',
      help: 'Repairs received on workshop.repairs.v1',
      labelNames: ['outcome'],
      registers,
    });
  }

  /** Record acknowledged messages; key is "topic|format". */
  add(counts: Record<string, number>): void {
    for (const [key, n] of Object.entries(counts)) {
      const [topic = '', format = ''] = key.split('|');
      this.sent.inc({ topic, format }, n);
      this.totals.set(key, (this.totals.get(key) ?? 0) + n);
    }
  }

  /** Close the current window: update rate gauges and return a summary for the 5 s log line. */
  roll(now = Date.now()): { msgsPerSec: number; total: number; byStream: Record<string, number> } {
    const secs = Math.max(0.001, (now - this.window.at) / 1000);
    let rateSum = 0;
    let total = 0;
    const byStream: Record<string, number> = {};
    for (const [key, t] of this.totals) {
      const [topic = '', format = ''] = key.split('|');
      const r = (t - (this.window.totals.get(key) ?? 0)) / secs;
      this.rate.set({ topic, format }, r);
      byStream[`${topic} ${format}`] = Math.round(r * 10) / 10;
      rateSum += r;
      total += t;
    }
    this.rateTotal.set(rateSum);
    this.window = { at: now, totals: new Map(this.totals) };
    return { msgsPerSec: Math.round(rateSum * 10) / 10, total, byStream };
  }

  serve(port: number, isHealthy: () => boolean, clock: () => object = () => ({})): Server {
    const server = createServer((req, res) => {
      if (req.url === '/metrics') {
        this.registry
          .metrics()
          .then((body) => {
            res.writeHead(200, { 'content-type': this.registry.contentType });
            res.end(body);
          })
          .catch((err: unknown) => {
            res.writeHead(500);
            res.end(String(err));
          });
      } else if (req.url === '/clock') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(clock()));
      } else if (req.url === '/healthz') {
        const ok = isHealthy();
        res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
        res.end(ok ? 'ok' : 'starting');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(port);
    return server;
  }
}
