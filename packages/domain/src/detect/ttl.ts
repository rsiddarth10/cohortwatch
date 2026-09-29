/**
 * Time to the hard limit and the runaway rule (brief §1.3.2).
 *
 * Hours to limit = (limit − level) / rate, from the fast trend's fitted level and slope. It is computed only
 * when the rate in the bad direction is at least `minRatePerH`, so a flat van never shows "limit in 400 h".
 * A van is a runaway (critical) after `consecutive` readings in a row under `hours`; one reading above
 * resets the run. Once critical, the flag is sticky for the life of the incident (the caller keeps it).
 */

export function hoursToLimit(
  level: number,
  ratePerH: number | null,
  limit: number,
  minRatePerH: number,
  direction: 1 | -1,
): number | null {
  if (ratePerH === null || direction * ratePerH < minRatePerH) return null;
  const h = (limit - level) / ratePerH;
  return h < 0 ? 0 : h;
}

/** Next consecutive-reading count for the runaway rule. */
export function runawayRun(run: number, ttlH: number | null, hours: number): number {
  return ttlH !== null && ttlH < hours ? run + 1 : 0;
}
