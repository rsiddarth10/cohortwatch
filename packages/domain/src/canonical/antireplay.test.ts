import { describe, expect, it } from 'vitest';
import { Rng } from '../rng.js';
import {
  ENCODED_WINDOW_BYTES,
  WINDOW_BITS,
  checkReplay,
  decodeWindow,
  encodeWindow,
  type ReplayResult,
  type ReplayWindow,
} from './antireplay.js';
import { ENCODED_VIN_STATE_BYTES, decodeVinState, encodeVinState } from './state.js';

/** Feed (seq, ts) pairs through the window; return results in order. */
function run(pairs: [number, number][], start?: ReplayWindow): { results: ReplayResult[]; state?: ReplayWindow } {
  let state = start;
  const results: ReplayResult[] = [];
  for (const [seq, ts] of pairs) {
    const r = checkReplay(state, seq, ts);
    results.push(r.result);
    state = r.state;
  }
  return { results, state };
}

describe('anti-replay window: the five outcomes', () => {
  it('NEW for increasing seqs, DUPLICATE for an exact repeat', () => {
    expect(run([[1, 10], [2, 20], [3, 30], [3, 30], [2, 20]]).results).toEqual([
      'NEW', 'NEW', 'NEW', 'DUPLICATE', 'DUPLICATE',
    ]); // prettier-ignore
  });

  it('LATE_NEW for an unseen older seq inside the window; a second copy of it is a DUPLICATE', () => {
    expect(run([[1, 10], [5, 50], [3, 30], [3, 30], [4, 40]]).results).toEqual([
      'NEW', 'NEW', 'LATE_NEW', 'DUPLICATE', 'LATE_NEW',
    ]); // prettier-ignore
  });

  it('TOO_OLD beyond the window when event time is not newer (forwarded as late, never silently lost)', () => {
    const { results, state } = run([
      [1, 10],
      [1 + WINDOW_BITS, 1000],
      [1, 10], // exactly W below maxSeq: the window no longer covers it
    ]);
    expect(results).toEqual(['NEW', 'NEW', 'TOO_OLD']);
    expect(state!.maxSeq).toBe(1 + WINDOW_BITS);
  });

  it('SEQ_RESET for a large backward jump with newer event time: the window restarts there', () => {
    const { results, state } = run([
      [5000, 1000],
      [3, 2000], // the device restarted its counter
      [4, 2100],
      [3, 2000],
    ]);
    expect(results).toEqual(['NEW', 'SEQ_RESET', 'NEW', 'DUPLICATE']);
    expect(state!.maxSeq).toBe(4);
  });

  it('the edge of the window: W−1 below is remembered, W below is not', () => {
    const top = 5000;
    const edge = run([[top - (WINDOW_BITS - 1), 1], [top, 2], [top - (WINDOW_BITS - 1), 1]]).results; // prettier-ignore
    expect(edge).toEqual(['NEW', 'NEW', 'DUPLICATE']);
    const beyond = run([[top - WINDOW_BITS, 1], [top, 2], [top - WINDOW_BITS, 1]]).results; // prettier-ignore
    expect(beyond).toEqual(['NEW', 'NEW', 'TOO_OLD']);
  });

  it('never modifies the input state (pure: state in → new state out)', () => {
    const s = checkReplay(undefined, 10, 100).state;
    const snapshot = encodeWindow(s);
    checkReplay(s, 11, 110);
    checkReplay(s, 5, 50);
    checkReplay(s, 10, 100);
    expect(encodeWindow(s)).toEqual(snapshot);
  });
});

describe('anti-replay window: invariants on shuffled, duplicated streams', () => {
  it('within the window, each seq is forwarded exactly once whatever the arrival order', () => {
    const r = Rng.of('replay-test');
    for (let trial = 0; trial < 20; trial++) {
      const n = 3000;
      const arrivals: number[] = [];
      for (let s = 1; s <= n; s++) {
        arrivals.push(s);
        if (r.chance(0.1)) arrivals.push(s); // duplicate
      }
      // bounded disorder: each arrival moves at most 200 places (well inside the 1024 window)
      const shuffled = arrivals
        .map((seq, i) => ({ seq, key: i + r.uniform(0, 200) }))
        .sort((x, y) => x.key - y.key)
        .map((x) => x.seq);
      let state: ReplayWindow | undefined;
      const forwarded = new Map<number, number>();
      for (const seq of shuffled) {
        const res = checkReplay(state, seq, seq * 1000);
        state = res.state;
        expect(res.result).not.toBe('TOO_OLD');
        if (res.result !== 'DUPLICATE') forwarded.set(seq, (forwarded.get(seq) ?? 0) + 1);
      }
      expect(forwarded.size).toBe(n);
      expect([...forwarded.values()].every((c) => c === 1)).toBe(true);
    }
  });

  it('bitmap shifts by non-multiples of 8 keep every remembered seq', () => {
    let state: ReplayWindow | undefined;
    const seen: number[] = [];
    for (let seq = 1; seq < 4000; seq += 1 + ((seq * 7) % 13)) {
      state = checkReplay(state, seq, seq).state;
      seen.push(seq);
    }
    for (const seq of seen.filter((s) => state!.maxSeq - s < WINDOW_BITS)) {
      expect(checkReplay(state, seq, seq).result).toBe('DUPLICATE');
    }
  });
});

describe('compact encoding for Redis', () => {
  it('window: 144 bytes, lossless', () => {
    const { state } = run([[100, 1_790_000_000_000], [90, 1_789_000_000_000], [612, 1_791_000_000_000]]); // prettier-ignore
    const bytes = encodeWindow(state!);
    expect(bytes).toHaveLength(ENCODED_WINDOW_BYTES);
    expect(ENCODED_WINDOW_BYTES).toBe(144);
    const back = decodeWindow(bytes);
    expect(back).toEqual(state);
    expect(checkReplay(back, 90, 0).result).toBe('DUPLICATE');
    expect(() => decodeWindow(new Uint8Array(10))).toThrow();
  });

  it('VIN state (window + last reading): 168 bytes, lossless, nulls preserved', () => {
    const window = checkReplay(undefined, 7, 70).state;
    for (const last of [undefined, { seq: 7, odoKm: 1234.5, socPct: null }, { seq: 7, odoKm: null, socPct: 55 }]) {
      const bytes = encodeVinState({ window, last });
      expect(bytes).toHaveLength(ENCODED_VIN_STATE_BYTES);
      expect(decodeVinState(bytes)).toEqual({ window, last });
    }
    // decodes from a view into a larger buffer (as Redis clients hand back)
    const big = new Uint8Array(ENCODED_VIN_STATE_BYTES + 8);
    big.set(encodeVinState({ window, last: undefined }), 8);
    expect(decodeVinState(big.subarray(8)).window.maxSeq).toBe(7);
    expect(() => decodeVinState(new Uint8Array(3))).toThrow();
  });
});
