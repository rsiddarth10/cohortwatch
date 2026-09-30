import type { Severity } from '../detect/vanstate.js';
import type { QueueParams } from './params.js';

/**
 * The daily workshop queue of one depot (S4, brief §1.3.1): pure functions, signals in → ranked items out.
 *
 * Candidates are open incidents, campaign members, campaign at-risk sisters, solo at-risk vans and vans whose repair
 * did not hold; one entry per van, reasons merged. The score weighs severity, trend, campaign size, in-service-tomorrow
 * and a CAPPED behaviour term. The fault-code count is NOT a term (a loud-but-stable van must rank below a quiet van
 * that is getting worse). A runaway/critical van is pinned above every score.
 */

export interface IncidentSignal {
  kind: 'INCIDENT';
  vin: string;
  depotId: number;
  incidentId: string;
  family: string;
  metric: string | null;
  severity: Severity;
  runaway: boolean;
  hoursToLimit: number | null;
  deviation: number | null;
  slopePerH: number | null;
  zSlope: number | null;
  trigger: 'SIGNAL' | 'DTC_RATE';
}

export interface CampaignSignal {
  kind: 'CAMPAIGN';
  vin: string;
  depotId: number;
  campaignId: string;
  family: string;
  members: number;
  role: 'MEMBER' | 'AT_RISK';
  depotCode: string;
  /** At-risk sisters: their own peer-adjusted deviation on the campaign's metric (unit). */
  adjDev: number | null;
}

export interface AtRiskSignal {
  kind: 'AT_RISK';
  vin: string;
  depotId: number;
  family: string;
  metric: string;
  adjDev: number | null;
  zSlope: number | null;
  reason: string;
}

export interface NotFixedSignal {
  kind: 'NOT_FIXED';
  vin: string;
  depotId: number;
  repairedTs: number;
}

export type QueueSignal = IncidentSignal | CampaignSignal | AtRiskSignal | NotFixedSignal;

/** Per-van context the service looks up (not signals themselves). */
export interface VanContext {
  codes24h: number;
  /** Harsh events per driven hour ÷ the median of its duty; null when unknown. */
  behaviourRatio: number | null;
  inServiceTomorrow: boolean;
}

export interface Candidate {
  vin: string;
  depotId: number;
  incidents: IncidentSignal[];
  campaigns: CampaignSignal[];
  atRisk: AtRiskSignal[];
  notFixed: NotFixedSignal | null;
  ctx: VanContext;
}

export interface ScoreParts {
  severity: number;
  trend: number;
  campaign: number;
  inService: number;
  behaviour: number;
  notFixed: number;
}

export interface Ranked extends Candidate {
  score: number;
  parts: ScoreParts;
  pinned: boolean;
  /** Smallest known hours to limit (pinned items are ordered by it). */
  hoursToLimit: number | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** One candidate per van; its signals merge. */
export function mergeSignals(signals: readonly QueueSignal[], ctx: (vin: string) => VanContext): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const s of signals) {
    let c = by.get(s.vin);
    if (!c) {
      c = { vin: s.vin, depotId: s.depotId, incidents: [], campaigns: [], atRisk: [], notFixed: null, ctx: ctx(s.vin) };
      by.set(s.vin, c);
    }
    if (s.kind === 'INCIDENT') c.incidents.push(s);
    else if (s.kind === 'CAMPAIGN') c.campaigns.push(s);
    else if (s.kind === 'AT_RISK') c.atRisk.push(s);
    else c.notFixed = s;
  }
  return [...by.values()];
}

export function scoreCandidate(c: Candidate, p: QueueParams): Ranked {
  const w = p.weights;
  const sevOf = (s: Severity) => p.severity[s];
  let severity = Math.max(0, ...c.incidents.map((i) => sevOf(i.severity)));
  if (severity === 0 && (c.atRisk.length > 0 || c.campaigns.some((x) => x.role === 'AT_RISK')))
    severity = p.severity.atRisk;
  if (c.notFixed) severity = Math.max(severity, p.severity.HIGH);
  const ttls = c.incidents.map((i) => i.hoursToLimit).filter((x): x is number => x !== null);
  const hoursToLimit = ttls.length ? Math.min(...ttls) : null;
  const zSlope = Math.max(0, ...c.incidents.map((i) => i.zSlope ?? 0), ...c.atRisk.map((a) => a.zSlope ?? 0));
  const trend = Math.max(
    clamp01(zSlope / p.fullTrendZ),
    hoursToLimit === null ? 0 : clamp01(1 - hoursToLimit / p.trendHorizonH),
  );
  const norm = (n: number) => clamp01(Math.log2(1 + n) / Math.log2(1 + p.campaignFullAt));
  const campaign = Math.max(0, ...c.campaigns.map((x) => (x.role === 'MEMBER' ? 1 : p.atRiskFactor) * norm(x.members)));
  const behaviour =
    c.ctx.behaviourRatio === null ? 0 : clamp01((c.ctx.behaviourRatio - 1) / (p.behaviourFullRatio - 1));
  // an at-risk-only van (no incident, not a member, no failed repair) counts "at a lower weight" (brief §1.3.1)
  const atRiskOnly = c.incidents.length === 0 && !c.notFixed && !c.campaigns.some((x) => x.role === 'MEMBER');
  const f = atRiskOnly ? p.atRiskFactor : 1;
  const parts: ScoreParts = {
    severity: w.severity * severity * f,
    trend: w.trend * trend * f,
    campaign: w.campaign * campaign,
    inService: c.ctx.inServiceTomorrow ? w.inService : 0,
    behaviour: w.behaviourCap * behaviour,
    notFixed: c.notFixed ? w.notFixed : 0,
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const pinned = c.incidents.some((i) => i.runaway || i.severity === 'CRITICAL');
  return { ...c, score, parts, pinned, hoursToLimit };
}

/** Pinned (runaway/critical) first, soonest limit first; then score; ties by VIN (deterministic). */
export function rank(cands: readonly Candidate[], p: QueueParams): Ranked[] {
  return cands
    .map((c) => scoreCandidate(c, p))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.pinned && b.pinned ? (a.hoursToLimit ?? Infinity) - (b.hoursToLimit ?? Infinity) : 0) ||
        b.score - a.score ||
        a.vin.localeCompare(b.vin),
    );
}

export type Slot = 'TODAY' | 'TOMORROW' | 'WAITING';

export interface Placed extends Ranked {
  rank: number;
  slot: Slot;
  /** Days until its bay (0 today, 1 tomorrow, ≥ 2 waiting): drives the cost of waiting. */
  waitDays: number;
}

/**
 * Fill today's bays, then tomorrow's, in rank order. Only items at or above minBayScore take a bay (a pinned
 * runaway always does); the rest wait. Capacity per day = bays × slotsPerBayPerDay.
 */
export function fillBays(ranked: readonly Ranked[], bays: number, p: QueueParams): Placed[] {
  const perDay = Math.max(0, bays * p.slotsPerBayPerDay);
  let today = 0;
  let tomorrow = 0;
  let waiting = 0;
  return ranked.map((r, i) => {
    const eligible = r.pinned || r.score >= p.minBayScore;
    let slot: Slot = 'WAITING';
    if (eligible && today < perDay) {
      slot = 'TODAY';
      today++;
    } else if (eligible && tomorrow < perDay) {
      slot = 'TOMORROW';
      tomorrow++;
    }
    const waitDays = slot === 'TODAY' ? 0 : slot === 'TOMORROW' ? 1 : 2 + Math.floor(waiting++ / Math.max(1, perDay));
    return { ...r, rank: i + 1, slot, waitDays };
  });
}
