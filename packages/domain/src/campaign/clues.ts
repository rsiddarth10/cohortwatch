import type { Member } from './book.js';
import type { CampaignParams } from './params.js';

/**
 * Campaign clues and money (brief §1.3.3): phrases with numbers and units, never a bare score.
 */
export interface CampaignClue {
  type: 'PLACE' | 'TREND' | 'CODES' | 'FIRMWARE' | 'REGION' | 'SURPRISE' | 'MONEY';
  text: string;
  value: number;
  unit: string;
}

export interface PlaceNames {
  family: string;
  model: string;
  duty: string;
  depot: string;
  unit: string;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
}

export function campaignClues(
  members: readonly Member[],
  names: PlaceNames,
  stats: { n: number; lambda: number; pValue: number; days: number; keyPer1000: number; regionalPer1000: number },
): CampaignClue[] {
  const clues: CampaignClue[] = [];
  clues.push({
    type: 'PLACE',
    text: `${members.length} ${names.model} vans on ${names.duty.toLowerCase()} duty at depot ${names.depot}, same ${names.family} fault`,
    value: members.length,
    unit: 'vans',
  });
  const dev = median(members.map((m) => m.deviation).filter((x): x is number => x !== null));
  const slope = median(members.map((m) => m.slopePerH).filter((x): x is number => x !== null));
  if (dev !== null) {
    const trend = slope !== null && slope > 0 ? `, rising ${slope.toFixed(2)} ${names.unit}/h` : '';
    clues.push({
      type: 'TREND',
      text: `typical member is ${dev.toFixed(1)} ${names.unit} above its own normal${trend}`,
      value: dev,
      unit: names.unit,
    });
  }
  const codes = new Map<string, number>();
  for (const m of members) if (m.lastCode) codes.set(m.lastCode, (codes.get(m.lastCode) ?? 0) + 1);
  if (codes.size > 0) {
    const top = [...codes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
    clues.push({
      type: 'CODES',
      text: `top codes: ${top.map(([c, n]) => `${c} (${n} vans)`).join(', ')}`,
      value: top[0]![1],
      unit: 'vans',
    });
  }
  clues.push({
    type: 'SURPRISE',
    text: `${stats.n} vans in ${stats.days.toFixed(0)} day${stats.days >= 2 ? 's' : ''} where ${stats.lambda.toFixed(
      1,
    )} would be expected by chance`,
    value: stats.n,
    unit: 'vans',
  });
  clues.push({
    type: 'REGION',
    text:
      stats.regionalPer1000 * 3 < stats.keyPer1000
        ? `peers elsewhere in the region are normal (${stats.regionalPer1000.toFixed(1)} vs ${stats.keyPer1000.toFixed(
            0,
          )} incidents per 1,000 van-days here)`
        : `the rest of the region is elevated too (${stats.regionalPer1000.toFixed(1)} per 1,000 van-days)`,
    value: stats.regionalPer1000,
    unit: 'per 1,000 van-days',
  });
  return clues;
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Cost if not fixed ≈ (members + at-risk) × (breakdown cost − planned fix). Assumptions in config. */
export function costIfNotFixed(members: number, atRisk: number, p: CampaignParams['money']): CampaignClue {
  const breakdown = p.towInr + p.downtimeDays * p.dailyRevenueInr + p.repairPremiumInr;
  const perVan = Math.max(0, breakdown - p.plannedFixInr);
  const total = (members + atRisk) * perVan;
  return {
    type: 'MONEY',
    text: `cost if not fixed ≈ ₹${inr.format(total)} (${members + atRisk} vans × ₹${inr.format(perVan)}: tow, ${p.downtimeDays} days off the road, unplanned repair, minus a planned fix)`,
    value: total,
    unit: 'INR',
  };
}
