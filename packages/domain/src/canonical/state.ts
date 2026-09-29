import { decodeWindow, encodeWindow, ENCODED_WINDOW_BYTES, type ReplayWindow } from './antireplay.js';
import type { LastReading } from './validate.js';

/**
 * Everything the normaliser remembers about one VIN, as one opaque value (Redis key `ar:{vin}`):
 * the replay window (144 B) + the newest accepted reading for jump checks (25 B) = 169 B.
 */
export interface VinState {
  window: ReplayWindow;
  last: LastReading | undefined;
}

const LAST_BYTES = 25;
export const ENCODED_VIN_STATE_BYTES = ENCODED_WINDOW_BYTES + LAST_BYTES;

export function encodeVinState(s: VinState): Uint8Array {
  const out = new Uint8Array(ENCODED_VIN_STATE_BYTES);
  out.set(encodeWindow(s.window), 0);
  const dv = new DataView(out.buffer, ENCODED_WINDOW_BYTES);
  // NaN encodes "absent" (no last reading / null value).
  dv.setFloat64(0, s.last ? s.last.seq : NaN, true);
  dv.setFloat64(8, s.last?.odoKm ?? NaN, true);
  dv.setFloat64(16, s.last?.socPct ?? NaN, true);
  dv.setUint8(24, s.last?.driving ? 1 : 0);
  return out;
}

export function decodeVinState(bytes: Uint8Array): VinState {
  if (bytes.length !== ENCODED_VIN_STATE_BYTES) throw new Error(`VIN state must be ${ENCODED_VIN_STATE_BYTES} bytes`);
  const window = decodeWindow(bytes.subarray(0, ENCODED_WINDOW_BYTES));
  const dv = new DataView(bytes.buffer, bytes.byteOffset + ENCODED_WINDOW_BYTES, LAST_BYTES);
  const seq = dv.getFloat64(0, true);
  const orNull = (x: number) => (Number.isNaN(x) ? null : x);
  return {
    window,
    last: Number.isNaN(seq)
      ? undefined
      : {
          seq,
          odoKm: orNull(dv.getFloat64(8, true)),
          socPct: orNull(dv.getFloat64(16, true)),
          driving: dv.getUint8(24) === 1,
        },
  };
}
