import type { CampaignParams } from './params.js';

/**
 * At-risk sisters (brief §1.3.3, reference plan §9.9): vans in a campaign's family key that are not members yet,
 * whose own trend on the campaign's metric is heading the same way but has not crossed their line.
 * Input: the van's hourly scores (peer-adjusted deviation, z_level, z_slope) written by the S3 telemetry writer,
 * newest first. The rule is generic so S4 can reuse it for solo at-risk vans.
 */
export interface HourlyScore {
  /** Bucket start, event time (ms). */
  ts: number;
  adjDev: number | null;
  zLevel: number | null;
  zSlope: number | null;
}

export interface AtRiskVerdict {
  atRisk: boolean;
  /** Event time of the newest row the verdict is based on (ms), or null without data. */
  ts: number | null;
  reason: string | null;
}

export function atRiskOf(newestFirst: readonly HourlyScore[], p: CampaignParams['atRisk']): AtRiskVerdict {
  const rows = newestFirst.filter((r) => r.zLevel !== null);
  if (rows.length === 0) return { atRisk: false, ts: null, reason: null };
  const recent = rows.slice(0, p.n);
  const high = recent.filter((r) => r.zLevel! >= p.zLevel).length;
  const newest = rows[0]!;
  if (high >= p.k) {
    return {
      atRisk: true,
      ts: newest.ts,
      reason: `above its own normal in ${high} of the last ${recent.length} hours (peer-adjusted z ≥ ${p.zLevel})`,
    };
  }
  if (newest.zSlope !== null && newest.zSlope >= p.zSlope && (newest.adjDev ?? 0) > 0) {
    return { atRisk: true, ts: newest.ts, reason: `rising faster than its usual rate (z ${newest.zSlope.toFixed(1)})` };
  }
  return { atRisk: false, ts: newest.ts, reason: null };
}
