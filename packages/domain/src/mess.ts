import { oemPayload, type EncodeOptions } from './formats/index.js';
import { Rng } from './rng.js';
import type { SimEvent } from './simulate.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time.js';

/**
 * Mess injection (brief §5.5, amended). Which messages are messed with, and how, is a pure function of
 * (seed, VIN, seq), so runs are reproducible by content; only wall-clock arrival order differs.
 * Applied to the live stream only, never to history.
 */
export interface MessConfig {
  duplicateRate: number;
  outOfOrderRate: number;
  outOfOrderDelayMin: [number, number];
  offlineVanDayRate: number;
  offlineDurationMin: [number, number];
  malformedRate: number;
  invalidVinRate: number;
  unknownDtcRate: number;
  skewVanRate: number;
  skewS: number;
  impossibleRate: number;
}

export const DEFAULT_MESS: MessConfig = {
  duplicateRate: 0.02,
  outOfOrderRate: 0.05,
  outOfOrderDelayMin: [1, 60],
  offlineVanDayRate: 0.01,
  offlineDurationMin: [30, 180],
  malformedRate: 0.001,
  invalidVinRate: 0.0005,
  unknownDtcRate: 0.0005,
  skewVanRate: 0.005,
  skewS: 90,
  impossibleRate: 0.0002,
};

export type MessKind =
  'duplicate' | 'out_of_order' | 'offline' | 'malformed' | 'invalid_vin' | 'unknown_dtc' | 'skew' | 'impossible';

export interface OutMessage {
  topic: string;
  key: string;
  format: string;
  value: string;
  /** Simulated time at which the message is released to Kafka. */
  releaseMs: number;
  vin: string;
  seq: number;
  kinds: MessKind[];
}

export interface MessContext extends EncodeOptions {
  seed: string;
  epochMs: number;
  cfg: MessConfig;
  enabled: boolean;
}

const UNKNOWN_DTCS = ['P02-17', 'XX123', 'p0217', 'P0A7EE', 'Q0000', '0217'];

/** Van-level constant clock skew in ms (0 for most vans). */
export function skewMs(ctx: MessContext, vin: string): number {
  const r = Rng.of(ctx.seed, vin, 'skew');
  if (!r.chance(ctx.cfg.skewVanRate)) return 0;
  return (r.chance(0.5) ? 1 : -1) * ctx.cfg.skewS * 1000;
}

/** The van's offline window on a sim-day, if any: [from, to). */
export function offlineWindow(ctx: MessContext, vin: string, day: number): [number, number] | null {
  const r = Rng.of(ctx.seed, vin, 'offline', day);
  if (!r.chance(ctx.cfg.offlineVanDayRate)) return null;
  const from = ctx.epochMs + day * DAY_MS + Math.round(r.uniform(6, 20) * HOUR_MS);
  const [a, b] = ctx.cfg.offlineDurationMin;
  return [from, from + Math.round(r.uniform(a, b) * MINUTE_MS)];
}

function corruptVin(vin: string, r: Rng): string {
  if (r.chance(0.5)) {
    // forbidden letter
    return vin.slice(0, 5) + 'O' + vin.slice(6);
  }
  // wrong check digit (position 9)
  const c = vin[8] === '0' ? '1' : '0';
  return vin.slice(0, 8) + c + vin.slice(9);
}

/** Turn one clean event into the message(s) the OEM feed actually delivers. */
export function messUp(e: SimEvent, ctx: MessContext): OutMessage[] {
  if (!ctx.enabled) {
    const p = oemPayload(e, ctx);
    return [
      {
        topic: p.topic,
        key: e.vin,
        format: p.format,
        value: JSON.stringify(p.body),
        releaseMs: e.eventTs,
        vin: e.vin,
        seq: e.seq,
        kinds: [],
      },
    ];
  }
  const cfg = ctx.cfg;
  const r = Rng.of(ctx.seed, e.vin, e.seq, 'mess');
  const kinds: MessKind[] = [];
  const ev: SimEvent = { ...e };

  const skew = skewMs(ctx, e.vin);
  if (skew !== 0) {
    ev.eventTs += skew;
    kinds.push('skew');
  }
  if (r.chance(cfg.impossibleRate)) {
    kinds.push('impossible');
    const variant = r.int(0, 3);
    if (variant === 0 && ev.socPct !== null) ev.socPct = 140;
    else if (variant === 1) ev.speedKmh = -r.uniform(1, 20);
    else if (variant === 2) ev.odoKm = Math.max(0, ev.odoKm - r.uniform(20, 200));
    else if (ev.socPct !== null && ev.speedKmh > 0) ev.socPct = Math.min(100, ev.socPct + 15);
    else ev.speedKmh = -5;
  }
  if (r.chance(cfg.unknownDtcRate)) {
    kinds.push('unknown_dtc');
    ev.dtc = [...ev.dtc, r.pick(UNKNOWN_DTCS)];
  }
  if (r.chance(cfg.invalidVinRate)) {
    kinds.push('invalid_vin');
    ev.vin = corruptVin(ev.vin, r);
  }

  // Format is chosen by the true event time (the OEM cloud switches, not the van's clock).
  const v2 = ctx.aurexV2FromMs !== undefined && e.eventTs >= ctx.aurexV2FromMs;
  const p = oemPayload(ev, { aurexV2FromMs: v2 ? -Infinity : Infinity });
  let value = JSON.stringify(p.body);
  if (r.chance(cfg.malformedRate)) {
    kinds.push('malformed');
    if (r.chance(0.5)) {
      value = value.slice(0, Math.max(1, Math.floor(value.length * r.uniform(0.3, 0.9))));
    } else {
      const body = p.body as Record<string, unknown>;
      const required =
        'id' in body ? ['id', 'ts', 'sq'] : 'seqNo' in body ? ['vehicle', 'time', 'seqNo'] : ['vehicle', 't', 'n'];
      delete body[r.pick(required)];
      value = JSON.stringify(body);
    }
  }

  let release = e.eventTs;
  const day = Math.floor((e.eventTs - ctx.epochMs) / DAY_MS);
  const off = offlineWindow(ctx, e.vin, day);
  if (off && e.eventTs >= off[0] && e.eventTs < off[1]) {
    kinds.push('offline');
    release = off[1];
  }
  const [lo, hi] = cfg.outOfOrderDelayMin;
  if (r.chance(cfg.outOfOrderRate)) {
    kinds.push('out_of_order');
    release += Math.round(r.uniform(lo, hi) * MINUTE_MS);
  }

  const out: OutMessage[] = [
    { topic: p.topic, key: ev.vin, format: p.format, value, releaseMs: release, vin: e.vin, seq: e.seq, kinds },
  ];
  if (r.chance(cfg.duplicateRate)) {
    out.push({
      ...out[0]!,
      releaseMs: release + Math.round(r.uniform(lo, hi) * MINUTE_MS),
      kinds: [...kinds, 'duplicate'],
    });
  }
  return out;
}
