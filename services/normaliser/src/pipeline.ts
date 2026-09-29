import {
  DecodeError,
  IngestClock,
  checkJumps,
  checkReplay,
  decodeRaw,
  flag,
  flagType,
  validateEvent,
  type CanonicalEvent,
  type ReplayResult,
  type ValidationConfig,
  type VinState,
} from '@cw/domain';

/**
 * The normaliser's pure core: raw records of ONE partition batch → canonical events, DLQ entries and the
 * new per-VIN states. No I/O here; main.ts reads states from Redis before and writes them back after.
 */

export interface RawRecord {
  topic: string;
  partition: number;
  offset: string;
  /** Kafka record timestamp (wall ms): the ingest time used for the skew check. */
  timestampMs: number;
  key: string | null;
  value: Buffer | null;
  headers: Record<string, string>;
}

export type DlqCode = 'MALFORMED_JSON' | 'UNKNOWN_SHAPE' | 'SCHEMA_INVALID' | 'INVALID_VIN';

/** The DLQ record value (JSON). */
export interface DlqEnvelope {
  source_topic: string;
  partition: number;
  offset: string;
  error_code: DlqCode;
  error_detail: string;
  raw_payload_b64: string;
  /** Wall-clock time the normaliser first saw the record (ISO 8601). */
  first_seen: string;
}

export interface CanonicalOut {
  event: CanonicalEvent;
  src: RawRecord;
}

export interface DlqOut {
  key: string | null;
  envelope: DlqEnvelope;
  src: RawRecord;
}

/** Stage 1 (pure): decode + stateless validation. The VINs of `ok` entries are the Redis keys to read. */
export type Decoded = { ok: true; event: CanonicalEvent; src: RawRecord } | { ok: false; dlq: DlqOut };

export function decodeBatch(records: readonly RawRecord[], cfg: ValidationConfig, now: () => Date): Decoded[] {
  return records.map((src) => {
    const toDlq = (code: DlqCode, detail: string): Decoded => ({
      ok: false,
      dlq: {
        key: src.key,
        src,
        envelope: {
          source_topic: src.topic,
          partition: src.partition,
          offset: src.offset,
          error_code: code,
          error_detail: detail.slice(0, 500),
          raw_payload_b64: (src.value ?? Buffer.alloc(0)).toString('base64'),
          first_seen: now().toISOString(),
        },
      },
    });
    let event: CanonicalEvent;
    try {
      event = decodeRaw(src.value?.toString('utf8') ?? '');
    } catch (err) {
      if (err instanceof DecodeError) return toDlq(err.code, err.message);
      return toDlq('SCHEMA_INVALID', err instanceof Error ? err.message : String(err));
    }
    const v = validateEvent(event, cfg);
    return v.ok ? { ok: true, event: v.event, src } : toDlq(v.code, v.detail);
  });
}

export interface BatchCounts {
  in: number;
  out: number;
  dlq: Partial<Record<DlqCode, number>>;
  replay: Record<ReplayResult, number>;
  flags: Record<string, number>;
}

export interface BatchResult {
  canonical: CanonicalOut[];
  dlq: DlqOut[];
  /** New state for every VIN whose state changed (write these back after producing). */
  states: Map<string, VinState>;
  counts: BatchCounts;
}

const REPLAY_FLAG: Partial<Record<ReplayResult, string>> = {
  LATE_NEW: flag('OUT_OF_ORDER'),
  TOO_OLD: flag('LATE'),
  SEQ_RESET: flag('SEQ_RESET'),
};

export interface ClassifyOptions {
  /** CLOCK_SKEW when event time is more than this ahead of the time its ingest implies. */
  skewMs: number;
}

/**
 * Stage 2 (pure): anti-replay, impossible jumps and skew, in offset order, threading each VIN's state
 * through the batch. `states` holds what Redis returned (missing = never seen); it is not modified.
 */
export function classifyBatch(
  decoded: readonly Decoded[],
  states: ReadonlyMap<string, VinState | undefined>,
  clock: IngestClock,
  opts: ClassifyOptions,
): BatchResult {
  const counts: BatchCounts = {
    in: decoded.length,
    out: 0,
    dlq: {},
    replay: { NEW: 0, DUPLICATE: 0, LATE_NEW: 0, TOO_OLD: 0, SEQ_RESET: 0 },
    flags: {},
  };
  const canonical: CanonicalOut[] = [];
  const dlq: DlqOut[] = [];
  const next = new Map<string, VinState>();

  for (const d of decoded) {
    if (!d.ok) {
      dlq.push(d.dlq);
      counts.dlq[d.dlq.envelope.error_code] = (counts.dlq[d.dlq.envelope.error_code] ?? 0) + 1;
      continue;
    }
    const ev = d.event;
    const ts = Date.parse(ev.event_ts);
    const prev = next.get(ev.vin) ?? states.get(ev.vin);
    const replay = checkReplay(prev?.window, ev.seq, ts);
    counts.replay[replay.result]++;
    if (replay.result === 'DUPLICATE') continue;

    // A counter reset starts the VIN's history over, so jumps are not judged against the old counter.
    const last = replay.result === 'SEQ_RESET' ? undefined : prev?.last;
    const jumps = checkJumps(last, ev);
    const out = jumps.event;
    const rf = REPLAY_FLAG[replay.result];
    if (rf) out.quality_flags.push(rf);
    if (clock.isAhead(ts, d.src.timestampMs, opts.skewMs)) out.quality_flags.push(flag('CLOCK_SKEW'));
    clock.push(ts, d.src.timestampMs);

    next.set(ev.vin, { window: replay.state, last: jumps.next });
    for (const f of out.quality_flags) {
      const t = flagType(f);
      counts.flags[t] = (counts.flags[t] ?? 0) + 1;
    }
    canonical.push({ event: out, src: d.src });
    counts.out++;
  }
  return { canonical, dlq, states: next, counts };
}

/** VINs whose state must be read before classifying (deduplicated, in first-seen order). */
export const vinsOf = (decoded: readonly Decoded[]): string[] => [
  ...new Set(decoded.flatMap((d) => (d.ok ? [d.event.vin] : []))),
];
