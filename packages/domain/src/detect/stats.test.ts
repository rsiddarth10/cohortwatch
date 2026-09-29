import { describe, expect, it } from 'vitest';
import { HOUR_MS } from '../time.js';
import { dtcAdd, dtcCount24, dtcThreshold } from './dtc.js';
import { emptyTrend, ewUpdate, trendFitNow, trendMean, trendSlope, trendWeight, type EwTrend } from './ewtrend.js';
import { kofnConfirmed, kofnCount, kofnPush } from './kofn.js';
import { PeerContext, peerScopes } from './peer.js';
import { mad, median, robustZ } from './robust.js';
import { hoursToLimit, runawayRun } from './ttl.js';

/** Plain weighted least squares with weights exp(−age/τ), age measured from the newest point. */
function wls(points: [number, number][], tauH: number) {
  const tn = Math.max(...points.map(([t]) => t));
  let S = 0, St = 0, Stt = 0, Sy = 0, Sty = 0; // prettier-ignore
  for (const [tMs, y] of points) {
    const t = (tMs - tn) / HOUR_MS;
    const w = Math.exp(t / tauH);
    S += w;
    St += w * t;
    Stt += w * t * t;
    Sy += w * y;
    Sty += w * t * y;
  }
  const slope = (S * Sty - St * Sy) / (S * Stt - St * St);
  return { mean: Sy / S, slope, fitNow: (Sy - slope * St) / S, weight: S };
}

const T0 = Date.UTC(2026, 8, 1);

describe('EW regression trend (O(1) sums)', () => {
  it('matches a plain weighted least-squares fit, irregular gaps', () => {
    let tr: EwTrend = emptyTrend();
    const pts: [number, number][] = [];
    let t = T0;
    for (let i = 0; i < 200; i++) {
      t += (0.2 + ((i * 7919) % 13) / 5) * HOUR_MS; // irregular 0.2..2.6 h gaps
      const y = 88 + 0.05 * i + Math.sin(i) * 0.8;
      pts.push([t, y]);
      tr = ewUpdate(tr, t, y, 12);
    }
    const ref = wls(pts, 12);
    expect(trendMean(tr)).toBeCloseTo(ref.mean, 9);
    expect(trendSlope(tr)!).toBeCloseTo(ref.slope, 9);
    expect(trendFitNow(tr)).toBeCloseTo(ref.fitNow, 9);
    expect(trendWeight(tr)).toBeCloseTo(ref.weight, 9);
  });

  it('recovers an exact line and applies an out-of-order point at its own time', () => {
    let tr = emptyTrend();
    const pts: [number, number][] = [];
    for (const h of [0, 1, 2, 4, 3.5, 5]) {
      const tMs = T0 + h * HOUR_MS;
      pts.push([tMs, 10 + 2 * h]);
      tr = ewUpdate(tr, tMs, 10 + 2 * h, 12);
    }
    expect(trendSlope(tr)!).toBeCloseTo(2, 9);
    expect(trendFitNow(tr)).toBeCloseTo(20, 9);
    expect(trendMean(tr)).toBeCloseTo(wls(pts, 12).mean, 9);
  });

  it('has no slope with one point or points at one instant', () => {
    let tr = ewUpdate(emptyTrend(), T0, 5, 12);
    expect(trendSlope(tr)).toBeNull();
    expect(trendFitNow(tr)).toBe(5);
    tr = ewUpdate(tr, T0, 7, 12);
    expect(trendSlope(tr)).toBeNull();
    expect(trendMean(tr)).toBe(6);
    expect(Number.isNaN(trendMean(emptyTrend()))).toBe(true);
  });

  it('forgets: after a long gap the old level has almost no weight', () => {
    let tr = ewUpdate(emptyTrend(), T0, 100, 12);
    tr = ewUpdate(tr, T0 + 120 * HOUR_MS, 50, 12);
    expect(trendMean(tr)).toBeCloseTo(50, 2);
  });
});

describe('robust statistics', () => {
  it('median, MAD and robust z', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(robustZ(1.4826, 1, 0.1)).toBeCloseTo(1, 9);
    expect(robustZ(1.4826, 0, 1)).toBeCloseTo(1, 9); // floor applies
  });
});

describe('k-of-n', () => {
  it('confirms at k of the last n and forgets older outcomes', () => {
    let b = 0;
    for (const x of [true, false, true, true]) b = kofnPush(b, x, 6);
    expect(kofnConfirmed(b, 4)).toBe(false);
    b = kofnPush(b, true, 6);
    expect(kofnConfirmed(b, 4)).toBe(true);
    for (let i = 0; i < 3; i++) b = kofnPush(b, false, 6);
    expect(kofnCount(b)).toBe(3); // last 6: T T T F F F
    expect(kofnCount(kofnPush(0x7fffffff, true, 31))).toBe(31);
  });
});

describe('time to limit and runaway run', () => {
  it('computes only above the minimum rate, in the bad direction', () => {
    expect(hoursToLimit(100, 2, 110, 0.5, 1)).toBe(5);
    expect(hoursToLimit(100, 0.1, 110, 0.5, 1)).toBeNull(); // tiny trend: no "limit in 100 h" flicker
    expect(hoursToLimit(100, -2, 110, 0.5, 1)).toBeNull();
    expect(hoursToLimit(100, null, 110, 0.5, 1)).toBeNull();
    expect(hoursToLimit(112, 2, 110, 0.5, 1)).toBe(0);
  });
  it('counts consecutive readings under the line and resets on one above', () => {
    let r = 0;
    for (const h of [11, 10, 9]) r = runawayRun(r, h, 12);
    expect(r).toBe(3);
    expect(runawayRun(r, 13, 12)).toBe(0);
    expect(runawayRun(r, null, 12)).toBe(0);
  });
});

describe('DTC 24-h ring', () => {
  it('counts codes in the last 24 h, including a late one, and forgets older hours', () => {
    let r = dtcAdd(undefined, T0, 'P0217');
    r = dtcAdd(r, T0 + 2 * HOUR_MS, 'P0118');
    r = dtcAdd(r, T0 + HOUR_MS, 'P0480'); // late
    expect(dtcCount24(r, T0 + 2 * HOUR_MS)).toBe(3);
    expect(r.lastCode).toBe('P0480');
    expect(dtcCount24(r, T0 + 24.5 * HOUR_MS)).toBe(2);
    expect(dtcCount24(r, T0 + 30 * HOUR_MS)).toBe(0);
    expect(dtcCount24(undefined, T0)).toBe(0);
    expect(dtcCount24(dtcAdd(r, T0 + 60 * HOUR_MS, 'P0217'), T0 + 60 * HOUR_MS)).toBe(1);
    expect(dtcThreshold(0, 4, 3)).toBe(3);
    expect(dtcThreshold(2, 4, 3)).toBe(8);
  });
});

describe('peer context', () => {
  it('a shared +10 °C shift across peers gives ≈ 0 adjusted deviation', () => {
    const peers = new PeerContext(2, 10);
    const key = peerScopes(3, 1, 'coolant_c')[0]!.key;
    const devs = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i) * 0.5); // every van +10 °C (heatwave)
    devs.forEach((d, i) => peers.update(key, `VIN${i}`, d, 0, T0));
    const c = peers.centre(key, T0);
    expect(c.peers).toBe(50);
    for (const d of devs) expect(Math.abs(d - c.level)).toBeLessThan(0.6);
  });

  it('a few sick vans do not move the centre; too few peers → no adjustment', () => {
    const peers = new PeerContext(2, 10);
    const key = 'k';
    for (let i = 0; i < 40; i++) peers.update(key, `H${i}`, 0.1 * (i % 3), 0, T0);
    for (let i = 0; i < 5; i++) peers.update(key, `S${i}`, 12, 1, T0);
    expect(Math.abs(peers.centre(key, T0).level)).toBeLessThan(0.3);
    const few = new PeerContext(2, 10);
    few.update('x', 'A', 10, 0, T0);
    expect(few.centre('x', T0)).toEqual({ level: 0, slope: 0, peers: 0 });
    expect(few.centre('nothing', T0).peers).toBe(0);
  });

  it('only counts recent readings, keeps the newest per VIN, and drops long-gone entries', () => {
    const peers = new PeerContext(2, 2);
    peers.update('k', 'A', 5, 0, T0);
    peers.update('k', 'B', 5, 0, T0);
    peers.update('k', 'A', 1, 0, T0 + 3 * HOUR_MS);
    peers.update('k', 'A', 9, 0, T0); // older than what A already has: ignored
    peers.update('k', 'C', 1, 0, T0 + 3 * HOUR_MS);
    expect(peers.centre('k', T0 + 3 * HOUR_MS)).toMatchObject({ level: 1, peers: 2 });
    expect(peers.size()).toBe(3);
    peers.centre('k', T0 + 40 * HOUR_MS);
    expect(peers.size()).toBe(0);
  });
});
