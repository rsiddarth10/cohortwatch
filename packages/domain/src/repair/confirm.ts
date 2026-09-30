import { z } from 'zod';
import { HOUR_MS } from '../time.js';

/**
 * Fix confirmation (S6, brief §1.3.4): after a repair, watch the van's next driven hours and decide.
 * Judged only on post-repair DRIVEN hourly rows (rows with a peer-adjusted score for the fault's metric; the S3
 * trend was reset at the repair, ADR 0016).
 *   PENDING   — not driven since the repair (or not enough driving to decide yet)
 *   FIXED     — ≥ insideK of the last insideN driven rows inside its own band (|z| < band) and ≥ minDrivenH driven hours
 *   NOT_FIXED — notFixedAfterH driven hours without FIXED, or windowH sim-hours passed with ≥ minDrivenH driven hours
 */
export const FixParamsSchema = z.object({
  band: z.number().positive().default(2),
  insideK: z.number().int().positive().default(6),
  insideN: z.number().int().positive().default(8),
  minDrivenH: z.number().int().positive().default(12),
  notFixedAfterH: z.number().int().positive().default(24),
  windowH: z.number().positive().default(48),
});
export type FixParams = z.infer<typeof FixParamsSchema>;
export const DEFAULT_FIX: FixParams = FixParamsSchema.parse({});

export type RepairStatus = 'REPAIRED' | 'PENDING' | 'FIXED' | 'NOT_FIXED';

export interface HourRow {
  /** Hourly bucket start, event time (ms). */
  ts: number;
  /** Peer-adjusted z_level of the fault's metric; null = not driven that hour. */
  z: number | null;
}

export interface Verdict {
  status: RepairStatus;
  drivenHours: number;
  insideRecent: number;
  recent: number;
  /** Event time the verdict was reached (the newest row used), or null. */
  ts: number | null;
  text: string;
}

export function judgeRepair(repairTs: number, rows: readonly HourRow[], nowTs: number, p: FixParams): Verdict {
  // only whole hours after the repair: the bucket containing the repair still holds pre-repair readings
  const firstHour = Math.ceil(repairTs / HOUR_MS) * HOUR_MS;
  const driven = rows
    .filter((r) => r.ts >= firstHour && r.ts <= nowTs && r.ts < repairTs + p.windowH * HOUR_MS && r.z !== null)
    .sort((a, b) => a.ts - b.ts);
  const n = driven.length;
  const recent = driven.slice(-p.insideN);
  const inside = recent.filter((r) => Math.abs(r.z!) < p.band).length;
  const ts = n ? driven[n - 1]!.ts : null;
  const base = { drivenHours: n, insideRecent: inside, recent: recent.length, ts };
  if (n === 0) return { ...base, status: 'PENDING', text: 'pending: not driven since the repair' };
  if (n >= p.minDrivenH && inside >= p.insideK) {
    return {
      ...base,
      status: 'FIXED',
      text: `fixed ✓: back inside its own normal in ${inside} of the last ${recent.length} driven hours (${n} h driven)`,
    };
  }
  const windowOver = nowTs >= repairTs + p.windowH * HOUR_MS;
  if (n >= p.notFixedAfterH || (windowOver && n >= p.minDrivenH)) {
    return {
      ...base,
      status: 'NOT_FIXED',
      text: `not fixed: still outside its own normal in ${recent.length - inside} of the last ${recent.length} driven hours (${n} h driven)`,
    };
  }
  return {
    ...base,
    status: 'PENDING',
    text: `pending: ${n} driven hour${n === 1 ? '' : 's'} since the repair, ${inside} of the last ${recent.length} inside its normal`,
  };
}
