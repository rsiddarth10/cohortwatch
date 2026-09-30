import type { CampaignParams } from '../campaign/params.js';
import { DEFAULT_DETECT, type Metric } from '../detect/params.js';
import type { QueueParams } from './params.js';
import type { Placed } from './queue.js';

/**
 * Queue reasons (phrases, never scores; the S3/S5 clue style) and the cost of waiting (brief §1.3.1).
 */
export interface QueueReason {
  type: 'RUNAWAY' | 'INCIDENT' | 'CAMPAIGN' | 'AT_RISK' | 'NOT_FIXED' | 'CODES' | 'BEHAVIOUR' | 'IN_SERVICE' | 'BOOKED';
  text: string;
}

const metricInfo = (m: string | null) =>
  m && m in DEFAULT_DETECT.metrics ? DEFAULT_DETECT.metrics[m as Metric] : null;
const f1 = (x: number) => x.toFixed(1);
const signed = (x: number) => `${x >= 0 ? '+' : ''}${f1(x)}`;

export function reasonsOf(r: Placed): QueueReason[] {
  const out: QueueReason[] = [];
  for (const i of r.incidents) {
    const mi = metricInfo(i.metric);
    if (i.runaway || i.severity === 'CRITICAL') {
      out.push({
        type: 'RUNAWAY',
        text:
          i.hoursToLimit !== null && mi?.hardLimit != null
            ? `runaway: ≈ ${Math.max(0, Math.round(i.hoursToLimit))} h to ${mi.hardLimit} ${mi.unit}`
            : `runaway: ${i.family} critical`,
      });
    } else if (i.trigger === 'DTC_RATE') {
      out.push({ type: 'INCIDENT', text: `${i.family} codes well above its own usual rate` });
    } else {
      const parts = [`${i.family} incident`];
      if (mi && i.deviation !== null)
        parts.push(
          `${mi.label} ${f1(Math.abs(i.deviation))} ${mi.unit} ${i.deviation >= 0 ? 'above' : 'below'} its own normal`,
        );
      if (mi && i.slopePerH !== null && (i.zSlope ?? 0) >= 1.5)
        parts.push(`rising ${i.slopePerH.toFixed(2)} ${mi.unit}/h`);
      out.push({ type: 'INCIDENT', text: parts.join(': ').replace(': rising', ', rising') });
    }
  }
  for (const c of r.campaigns) {
    if (c.role === 'MEMBER') {
      out.push({ type: 'CAMPAIGN', text: `member of ${c.family} campaign at ${c.depotCode} (${c.members} vans)` });
    } else {
      const mi = metricInfo(familyMetric(c.family));
      const dev = mi && c.adjDev !== null ? `, ${mi.label} ${signed(c.adjDev)} ${mi.unit} vs its normal` : '';
      out.push({
        type: 'AT_RISK',
        text: `at-risk: same model and depot as an open ${c.family} campaign (${c.depotCode}, ${c.members} vans)${dev}`,
      });
    }
  }
  for (const a of r.atRisk) {
    out.push({ type: 'AT_RISK', text: `at-risk: ${a.reason}` });
  }
  if (r.notFixed) {
    out.push({
      type: 'NOT_FIXED',
      text: `repair on ${new Date(r.notFixed.repairedTs).toISOString().slice(0, 10)} did not hold`,
    });
  }
  if (r.ctx.codes24h > 0) out.push({ type: 'CODES', text: `${r.ctx.codes24h} fault codes in the last 24 h` });
  if (r.ctx.behaviourRatio !== null && r.ctx.behaviourRatio >= 1.5) {
    out.push({
      type: 'BEHAVIOUR',
      text: `harsh driving ${f1(r.ctx.behaviourRatio)}× its duty's usual (small, capped weight)`,
    });
  }
  if (r.ctx.inServiceTomorrow) out.push({ type: 'IN_SERVICE', text: 'in service tomorrow' });
  return out;
}

const FAMILY_METRIC: Record<string, Metric> = {
  COOLING: 'coolant_c',
  HV_BATTERY_THERMAL: 'batt_temp_c',
  LV_ELECTRICAL: 'lv_batt_v',
};
export const familyMetric = (family: string): Metric | null => FAMILY_METRIC[family] ?? null;

/** Expected breakdown cost of one van (tow + days off the road + unplanned-repair premium), from the S5 money config. */
export const breakdownInr = (m: CampaignParams['money']): number =>
  m.towInr + m.downtimeDays * m.dailyRevenueInr + m.repairPremiumInr;

/**
 * P(breakdown before its bay) × breakdown cost. With a known time to limit: P = min(1, wait / time to limit);
 * otherwise a daily hazard by severity and role: P = 1 − (1 − h)^days. Deliberately simple (ADR 0014).
 */
export function costOfWaiting(r: Placed, days: number, p: QueueParams, money: CampaignParams['money']): number {
  if (days <= 0) return 0;
  let prob: number;
  if (r.hoursToLimit !== null) prob = Math.min(1, (days * 24) / Math.max(r.hoursToLimit, 1));
  else {
    const h = p.hazardPerDay;
    const sev = Math.max(0, ...r.incidents.map((i) => h[i.severity]));
    const role = Math.max(
      0,
      ...r.campaigns.map((c) => (c.role === 'MEMBER' ? h.member : h.atRisk)),
      r.atRisk.length ? h.atRisk : 0,
      r.notFixed ? h.notFixed : 0,
    );
    const daily = Math.max(sev, role);
    prob = 1 - (1 - daily) ** days;
  }
  return Math.round(prob * breakdownInr(money));
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function costText(r: Placed, p: QueueParams, money: CampaignParams['money']): { inr: number; text: string } {
  const days = Math.max(1, r.waitDays);
  const v = costOfWaiting(r, days, p, money);
  return { inr: v, text: `waiting ${days} day${days > 1 ? 's' : ''} ≈ ₹${inr.format(v)}` };
}
