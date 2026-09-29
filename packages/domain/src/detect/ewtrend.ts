import { HOUR_MS } from '../time.js';

/**
 * Exponentially weighted least-squares trend in O(1) (reference plan §9.3).
 *
 * The five decayed sums S = Σw, St = Σw·t, Stt = Σw·t², Sy = Σw·y, Sty = Σw·t·y are kept with the time
 * origin at the newest point (`at`), so t of older points is ≤ 0 and the sums never lose precision to
 * large absolute times. A new point after a gap of Δ hours first moves the origin by Δ and decays every
 * weight by exp(−Δ/τ), then adds itself at t = 0:
 *
 *   S' = w·S + 1   St' = w·(St − Δ·S)   Stt' = w·(Stt − 2Δ·St + Δ²·S)   Sy' = w·Sy + y   Sty' = w·(Sty − Δ·Sy)
 *
 * which equals a weighted least-squares fit where the point at age a (hours) has weight exp(−a/τ).
 * Time is event time (epoch ms); a point older than `at` (out of order) is added at its negative t
 * without moving the origin. O(1) time, 6 numbers of state.
 */
export interface EwTrend {
  /** Event time of the origin (ms). */
  at: number;
  S: number;
  St: number;
  Stt: number;
  Sy: number;
  Sty: number;
}

export const emptyTrend = (): EwTrend => ({ at: 0, S: 0, St: 0, Stt: 0, Sy: 0, Sty: 0 });

export function ewUpdate(tr: EwTrend, tsMs: number, y: number, tauH: number): EwTrend {
  if (tr.S === 0) return { at: tsMs, S: 1, St: 0, Stt: 0, Sy: y, Sty: 0 };
  const d = (tsMs - tr.at) / HOUR_MS;
  if (d < 0) {
    // out of order: add at its own (negative) time with its own age weight; origin stays
    const w = Math.exp(d / tauH);
    return {
      at: tr.at,
      S: tr.S + w,
      St: tr.St + w * d,
      Stt: tr.Stt + w * d * d,
      Sy: tr.Sy + w * y,
      Sty: tr.Sty + w * d * y,
    };
  }
  const w = Math.exp(-d / tauH);
  return {
    at: tsMs,
    S: w * tr.S + 1,
    St: w * (tr.St - d * tr.S),
    Stt: w * (tr.Stt - 2 * d * tr.St + d * d * tr.S),
    Sy: w * tr.Sy + y,
    Sty: w * (tr.Sty - d * tr.Sy),
  };
}

/** Effective weight Σw as of the origin. */
export const trendWeight = (tr: EwTrend): number => tr.S;

/** EW mean of y (the smoothed level). */
export const trendMean = (tr: EwTrend): number => (tr.S > 0 ? tr.Sy / tr.S : NaN);

/** Slope (units per hour), or null when the points do not span enough time to fit a line. */
export function trendSlope(tr: EwTrend): number | null {
  const den = tr.S * tr.Stt - tr.St * tr.St;
  // relative guard: Var(t) under the weights must be meaningfully > 0 (≈ 6 minutes of spread)
  if (tr.S <= 0 || den <= 0 || den / (tr.S * tr.S) < 0.01) return null;
  return (tr.S * tr.Sty - tr.St * tr.Sy) / den;
}

/** Fitted value of the line at the origin (the newest point's time), or the mean when no slope exists. */
export function trendFitNow(tr: EwTrend): number {
  const b = trendSlope(tr);
  if (b === null) return trendMean(tr);
  return (tr.Sy - b * tr.St) / tr.S;
}
