import { HOUR_MS } from '../time.js';

/**
 * Per-family fault-code counts over the last 24 sim-hours: a ring of 24 hourly buckets (event time).
 * O(1) amortised per code, 25 numbers of state per family that has ever reported a code.
 */
export interface DtcRing {
  /** Hour index (floor(ts / 1 h)) of the newest bucket. */
  hour: number;
  /** counts[i] = codes in hour (hour − i). */
  counts: number[];
  /** Newest code seen, for the clue ("P0217 seen 5× in 24 h"). */
  lastCode: string;
}

const SLOTS = 24;

function advanced(r: DtcRing, hour: number): number[] {
  const shift = hour - r.hour;
  if (shift <= 0) return r.counts;
  if (shift >= SLOTS) return new Array<number>(SLOTS).fill(0);
  return [...new Array<number>(shift).fill(0), ...r.counts.slice(0, SLOTS - shift)];
}

export function dtcAdd(r: DtcRing | undefined, tsMs: number, code: string): DtcRing {
  const hour = Math.floor(tsMs / HOUR_MS);
  if (!r) {
    const counts = new Array<number>(SLOTS).fill(0);
    counts[0] = 1;
    return { hour, counts, lastCode: code };
  }
  const counts = [...advanced(r, hour)];
  const i = Math.max(r.hour, hour) - hour; // a late code lands in its own (older) bucket
  if (i < SLOTS) counts[i]! += 1;
  return { hour: Math.max(r.hour, hour), counts, lastCode: code };
}

/** Codes in the 24 h ending at `tsMs`. */
export function dtcCount24(r: DtcRing | undefined, tsMs: number): number {
  if (!r) return 0;
  const hour = Math.floor(tsMs / HOUR_MS);
  return advanced(r, hour).reduce((a, b) => a + b, 0);
}

/** DTC-rate rule: at least max(minCount, factor × the van's usual codes per day). */
export function dtcThreshold(usualPerDay: number, factor: number, minCount: number): number {
  return Math.max(minCount, factor * usualPerDay);
}
