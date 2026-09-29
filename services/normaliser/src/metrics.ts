import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { BatchCounts } from './pipeline.js';

/** Prometheus metrics for the normaliser (GET /metrics, GET /healthz). */
export class NormaliserMetrics {
  readonly registry = new Registry();
  readonly in: Counter<'topic'>;
  readonly out: Counter;
  readonly dlq: Counter<'error_code'>;
  readonly duplicates: Counter;
  readonly late: Counter;
  readonly tooOld: Counter;
  readonly seqReset: Counter;
  readonly qualityFlags: Counter<'type'>;
  readonly casConflicts: Counter;
  readonly pauses: Counter<'reason'>;
  readonly revokedBatches: Counter;
  readonly paused: Gauge;
  readonly inflight: Gauge;
  readonly redisMs: Gauge;
  /** Last committed offset (next to read) per input partition: with `duplicates` this is the reconcile ledger. */
  readonly committed: Gauge<'topic' | 'partition'>;
  readonly lag: Gauge<'topic' | 'partition'>;
  readonly batchSeconds: Histogram;
  readonly e2eSeconds: Histogram;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'cw_norm_' });
    const registers = [this.registry];
    const c = <L extends string>(name: string, help: string, labelNames: L[] = []) =>
      new Counter<L>({ name, help, labelNames, registers });
    this.in = c('cw_norm_in_total', 'Raw records consumed and committed', ['topic']);
    this.out = c('cw_norm_out_total', 'Canonical events produced (committed batches)');
    this.dlq = c('cw_norm_dlq_total', 'Records sent to the DLQ, by reason', ['error_code']);
    this.duplicates = c('cw_norm_duplicates_total', 'Records dropped by the anti-replay window (already seen)');
    this.late = c('cw_norm_late_total', 'Out-of-order records forwarded (LATE_NEW, flagged OUT_OF_ORDER)');
    this.tooOld = c('cw_norm_too_old_total', 'Records older than the window, forwarded flagged LATE');
    this.seqReset = c('cw_norm_seq_reset_total', 'Sequence counter resets detected');
    this.qualityFlags = c('cw_norm_quality_flag_total', 'Quality flags set on canonical events', ['type']);
    this.casConflicts = c('cw_norm_state_cas_conflicts_total', 'VIN states another writer changed first');
    this.pauses = c('cw_norm_pauses_total', 'Times consumption was paused for back-pressure', ['reason']);
    this.revokedBatches = c('cw_norm_revoked_batches_total', 'Batches not committed because the partition was revoked');
    this.paused = new Gauge({ name: 'cw_norm_paused', help: '1 while consumption is paused', registers });
    this.inflight = new Gauge({ name: 'cw_norm_inflight_events', help: 'Produced, not yet acknowledged', registers });
    this.redisMs = new Gauge({ name: 'cw_norm_redis_ms', help: 'Redis round trip, EWMA (ms)', registers });
    this.committed = new Gauge({
      name: 'cw_norm_committed_offset',
      help: 'Committed offset (next record to read) per input partition',
      labelNames: ['topic', 'partition'],
      registers,
    });
    this.lag = new Gauge({
      name: 'cw_norm_consumer_lag',
      help: 'High watermark minus committed offset, per input partition',
      labelNames: ['topic', 'partition'],
      registers,
    });
    this.batchSeconds = new Histogram({
      name: 'cw_norm_batch_seconds',
      help: 'Wall time to process one batch (decode → produce ack → state write → commit)',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.e2eSeconds = new Histogram({
      name: 'cw_norm_e2e_seconds',
      help: 'Wall time from x-sent-at (simulator send) to canonical produce ack',
      // fine enough to read p50/p95/p99 by interpolation within a bucket
      buckets: [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 30, 60],
      registers,
    });
  }

  /** Record one committed batch (called after the offsets commit, together with `committed`). */
  recordBatch(topic: string, counts: BatchCounts): void {
    this.in.inc({ topic }, counts.in);
    this.out.inc(counts.out);
    for (const [code, n] of Object.entries(counts.dlq)) this.dlq.inc({ error_code: code }, n);
    this.duplicates.inc(counts.replay.DUPLICATE);
    this.late.inc(counts.replay.LATE_NEW);
    this.tooOld.inc(counts.replay.TOO_OLD);
    this.seqReset.inc(counts.replay.SEQ_RESET);
    for (const [type, n] of Object.entries(counts.flags)) this.qualityFlags.inc({ type }, n);
  }

  /** /metrics, /healthz, plus JSON routes (e.g. /ledger) rendered synchronously from `json`. */
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
