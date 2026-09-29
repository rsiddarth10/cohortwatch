/**
 * Robust statistics: median, MAD and robust z (reference plan §9.4). 1.4826 × MAD estimates σ for normal data.
 */

export const MAD_TO_SIGMA = 1.4826;

/** Median of the values (NaN for none). Sorts a copy: O(n log n). */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return NaN;
  const a = Float64Array.from(values).sort();
  const h = n >> 1;
  return n % 2 ? a[h]! : (a[h - 1]! + a[h]!) / 2;
}

/** Median absolute deviation from the median. */
export function mad(values: ArrayLike<number>): number {
  const m = median(values);
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i]! - m);
  return median(dev);
}

/** Robust z of a deviation from the median, with a floor on the MAD. */
export function robustZ(deviation: number, madValue: number, madFloor: number): number {
  return deviation / (MAD_TO_SIGMA * Math.max(madValue, madFloor));
}
