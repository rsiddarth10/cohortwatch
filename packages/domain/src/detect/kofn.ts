/**
 * k-of-n confirmation (reference plan §9.4): the last n outcomes as a bit ring (bit 0 = newest).
 * A deviation is confirmed when at least k of the last n readings were abnormal, so one noisy tick
 * never raises an incident. O(1), one integer of state (n ≤ 30).
 */

export function kofnPush(bits: number, abnormal: boolean, n: number): number {
  const mask = n >= 31 ? 0x7fffffff : (1 << n) - 1;
  return ((bits << 1) | (abnormal ? 1 : 0)) & mask;
}

export function kofnCount(bits: number): number {
  let c = 0;
  for (let b = bits; b; b &= b - 1) c++;
  return c;
}

export const kofnConfirmed = (bits: number, k: number): boolean => kofnCount(bits) >= k;
