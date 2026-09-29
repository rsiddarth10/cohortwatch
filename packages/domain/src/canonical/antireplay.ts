/**
 * Per-VIN anti-replay window (S2), in the style of IPsec/DTLS replay protection.
 *
 * State = highest seq seen + a W-bit bitmap of which of the W seqs at or below it were seen
 * (bit k ↔ seq maxSeq − k), plus the newest event time. W = 1024 → 128 B of bitmap per VIN.
 * Every transition is a pure function (state in → new state out) so Redis can store the bytes.
 * Cost per event: O(W/8) = 128 byte operations at most (a constant), usually O(1).
 */

export const WINDOW_BITS = 1024;
const WINDOW_BYTES = WINDOW_BITS / 8;

export interface ReplayWindow {
  maxSeq: number;
  /** Newest event time seen (epoch ms), used to tell a device reset from a very late message. */
  maxTs: number;
  /** WINDOW_BYTES bytes; bit k (byte k>>3, bit k&7) set ↔ seq maxSeq − k was seen. */
  bits: Uint8Array;
}

export type ReplayResult =
  /** Newest so far. */
  | 'NEW'
  /** Already seen (exact duplicate or redelivery): drop. */
  | 'DUPLICATE'
  /** Older than the newest but never seen (out of order): forward. */
  | 'LATE_NEW'
  /** Older than the window can remember: forward flagged LATE (never silently dropped). */
  | 'TOO_OLD'
  /** Far below the window but with newer event time: the device restarted its counter; window restarts. */
  | 'SEQ_RESET';

export interface ReplayConfig {
  /** A seq this far below maxSeq (or more) is outside the window. Defaults to WINDOW_BITS. */
  windowBits: number;
}

export const DEFAULT_REPLAY: ReplayConfig = { windowBits: WINDOW_BITS };

function fresh(seq: number, ts: number): ReplayWindow {
  const bits = new Uint8Array(WINDOW_BYTES);
  bits[0] = 1;
  return { maxSeq: seq, maxTs: ts, bits };
}

const testBit = (b: Uint8Array, k: number) => (b[k >> 3]! & (1 << (k & 7))) !== 0;
function setBit(b: Uint8Array, k: number): void {
  b[k >> 3]! |= 1 << (k & 7);
}

/** Shift the bitmap so bit k moves to bit k + d (older), dropping bits that leave the window. */
function shifted(b: Uint8Array, d: number): Uint8Array {
  const out = new Uint8Array(WINDOW_BYTES);
  if (d >= WINDOW_BITS) return out;
  const byteShift = d >> 3;
  const bitShift = d & 7;
  for (let i = WINDOW_BYTES - 1; i >= byteShift; i--) {
    const src = i - byteShift;
    let v = (b[src]! << bitShift) & 0xff;
    if (bitShift && src > 0) v |= b[src - 1]! >> (8 - bitShift);
    out[i] = v;
  }
  return out;
}

/**
 * Classify one reading and return the next state. The input state is never modified.
 * A DUPLICATE or TOO_OLD reading returns the same state object (nothing to write back).
 */
export function checkReplay(
  state: ReplayWindow | undefined,
  seq: number,
  eventTs: number,
  cfg: ReplayConfig = DEFAULT_REPLAY,
): { result: ReplayResult; state: ReplayWindow } {
  if (!state) return { result: 'NEW', state: fresh(seq, eventTs) };
  const w = Math.min(cfg.windowBits, WINDOW_BITS);
  if (seq > state.maxSeq) {
    const bits = shifted(state.bits, seq - state.maxSeq);
    setBit(bits, 0);
    return { result: 'NEW', state: { maxSeq: seq, maxTs: Math.max(state.maxTs, eventTs), bits } };
  }
  const d = state.maxSeq - seq;
  if (d < w) {
    if (testBit(state.bits, d)) return { result: 'DUPLICATE', state };
    const bits = state.bits.slice();
    setBit(bits, d);
    return { result: 'LATE_NEW', state: { ...state, maxTs: Math.max(state.maxTs, eventTs), bits } };
  }
  if (eventTs > state.maxTs) return { result: 'SEQ_RESET', state: fresh(seq, eventTs) };
  return { result: 'TOO_OLD', state };
}

// ---- Compact encoding for Redis: 8 B maxSeq + 8 B maxTs + 128 B bitmap = 144 B -------------------

export const ENCODED_WINDOW_BYTES = 16 + WINDOW_BYTES;

export function encodeWindow(s: ReplayWindow): Uint8Array {
  const out = new Uint8Array(ENCODED_WINDOW_BYTES);
  const dv = new DataView(out.buffer);
  dv.setFloat64(0, s.maxSeq, true);
  dv.setFloat64(8, s.maxTs, true);
  out.set(s.bits, 16);
  return out;
}

export function decodeWindow(bytes: Uint8Array): ReplayWindow {
  if (bytes.length !== ENCODED_WINDOW_BYTES) throw new Error(`replay window must be ${ENCODED_WINDOW_BYTES} bytes`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { maxSeq: dv.getFloat64(0, true), maxTs: dv.getFloat64(8, true), bits: bytes.slice(16) };
}
