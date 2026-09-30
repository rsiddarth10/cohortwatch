/**
 * Poisson outbreak test (reference plan §9.7): p = P(X ≥ n | λ), "more cases than expected in this place and time".
 * Summed directly from the tail in log space (no 1 − CDF cancellation), so p-values like 1e-12 stay accurate.
 * O(n + terms) per call; the tail sum stops when a term no longer changes the total.
 */

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

export function poissonTail(n: number, lambda: number): number {
  if (n <= 0) return 1;
  if (lambda <= 0) return 0;
  let logTerm = -lambda + n * Math.log(lambda) - logFactorial(n);
  let term = Math.exp(logTerm);
  let sum = term;
  for (let k = n + 1; k < n + 10_000; k++) {
    logTerm += Math.log(lambda) - Math.log(k);
    term = Math.exp(logTerm);
    sum += term;
    if (term < sum * 1e-16 && k > lambda) break;
  }
  return Math.min(1, sum);
}

export interface ExpectedRateInput {
  /** Vans currently in the family key's cohort (model × duty × depot). */
  vansInKey: number;
  /** Merged window length in days. */
  days: number;
  /** Baseline for this family × model × duty (per 1,000 van-days) from the batch fault-rate table. */
  baselinePer1000: number;
  /** Current rate of the same family in the same region OUTSIDE this depot (per 1,000 van-days). */
  regionalPer1000: number;
  floorPer1000: number;
}

/**
 * λ = vans × days × max(floor, baseline, current regional rate). The regional term stops a shared condition
 * (a heatwave) from opening a campaign at one depot: when the whole region is elevated, 5 at one depot is not
 * surprising.
 */
export function expectedLambda(i: ExpectedRateInput): {
  lambda: number;
  ratePer1000: number;
  source: 'floor' | 'baseline' | 'regional';
} {
  const candidates: [number, 'floor' | 'baseline' | 'regional'][] = [
    [i.floorPer1000, 'floor'],
    [i.baselinePer1000, 'baseline'],
    [i.regionalPer1000, 'regional'],
  ];
  const [rate, source] = candidates.reduce((a, b) => (b[0] > a[0] ? b : a));
  return { lambda: (i.vansInKey * Math.max(i.days, 0) * rate) / 1000, ratePer1000: rate, source };
}

/** Distinct vans with an incident per 1,000 van-days. */
export const ratePer1000 = (vans: number, fleet: number, days: number): number =>
  fleet > 0 && days > 0 ? (1000 * vans) / (fleet * days) : 0;
