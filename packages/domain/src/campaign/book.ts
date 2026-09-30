import { uuidV5 } from '../canonical/event.js';
import type { IncidentMessage } from '../detect/message.js';
import { HOUR_MS } from '../time.js';
import type { CampaignParams } from './params.js';
import { expectedLambda, poissonTail } from './poisson.js';
import { union, type Parents } from './unionfind.js';

/**
 * The campaign book of ONE family key (fault family | model | duty | depot): pure state in → state out (S5).
 *
 * An incident joins the key's live group whose event-time buckets touch its own (gap ≤ 1 bucket); a new bucket
 * that bridges two groups merges them (union-find, the older group stays root). A group opens as a campaign when
 * it has ≥ minVans distinct vans AND P(X ≥ n | λ) < α; below that it is WATCHING. A van joins once: a second
 * incident, a replay or a CLOSE never adds a member. A dismissal ("not an outbreak") is sticky until the group is
 * materially worse (members +growthPct% or +growthAbs, or a member turns runaway).
 */

export type CampaignStatus = 'WATCHING' | 'OPEN' | 'DISMISSED' | 'MERGED' | 'CLOSED';

export interface Member {
  vin: string;
  incidentId: string;
  /** Event time (ms) of the van's first incident in this campaign. */
  firstTs: number;
  runaway: boolean;
  deviation: number | null;
  slopePerH: number | null;
  lastCode: string | null;
  firmware: string | null;
}

export interface Dismissal {
  atMembers: number;
  by: string;
  reason: string;
  ts: number;
  /** A member turned runaway after the dismissal. */
  runawaySince: boolean;
}

export interface Group {
  id: string;
  familyKey: string;
  family: string;
  modelId: number;
  dutyId: number;
  depotId: number;
  regionId: number;
  status: CampaignStatus;
  firstBucket: number;
  lastBucket: number;
  firstTs: number;
  lastTs: number;
  members: Record<string, Member>;
  mergedInto: string | null;
  openedTs: number | null;
  lambda: number | null;
  pValue: number | null;
  rateSource: 'floor' | 'baseline' | 'regional' | null;
  dismissal: Dismissal | null;
  version: number;
}

export interface KeyBook {
  key: string;
  groups: Record<string, Group>;
}

export type CampaignEventType = 'OPENED' | 'GREW' | 'MERGED' | 'DISMISSED' | 'REOPENED' | 'AT_RISK_CHANGED';

export interface CampaignEvent {
  type: CampaignEventType;
  campaignId: string;
  version: number;
  familyKey: string;
  status: CampaignStatus;
  members: number;
  /** Event time (ms) of what caused it. */
  ts: number;
  /** Stable id for consumers to drop repeats: uuid5(campaign, type, version). */
  eventId: string;
  detail: Record<string, unknown>;
}

/** Numbers the service looks up for this key at the incident's time (the domain stays free of I/O). */
export interface KeyRates {
  vansInKey: number;
  baselinePer1000: number;
  regionalPer1000: number;
}

export interface ApplyContext {
  params: CampaignParams;
  rates: KeyRates;
  /** The van is already a member of a live campaign of this family under ANOTHER key (e.g. before a depot transfer). */
  memberElsewhere: boolean;
}

/** Fixed namespaces (random v4, generated once). */
export const CAMPAIGN_ID_NAMESPACE = '5b0e4c2a-8f1d-4d6e-9a37-c21f6e8d4b19';
export const CAMPAIGN_EVENT_NAMESPACE = 'e7d2a915-3c6b-4f08-b1a4-9d5e2c7f0a63';

export const campaignIdOf = (familyKey: string, firstBucket: number): string =>
  uuidV5(CAMPAIGN_ID_NAMESPACE, `${familyKey}|${firstBucket}`);

export const bucketOf = (tsMs: number, bucketH: number): number => Math.floor(tsMs / (bucketH * HOUR_MS));

export const emptyBook = (key: string): KeyBook => ({ key, groups: {} });

const LIVE = (g: Group) => g.status !== 'MERGED' && g.status !== 'CLOSED';
const memberCount = (g: Group) => Object.keys(g.members).length;

function event(g: Group, type: CampaignEventType, ts: number, detail: Record<string, unknown> = {}): CampaignEvent {
  return {
    type,
    campaignId: g.id,
    version: g.version,
    familyKey: g.familyKey,
    status: g.status,
    members: memberCount(g),
    ts,
    eventId: uuidV5(CAMPAIGN_EVENT_NAMESPACE, `${g.id}|${type}|${g.version}`),
    detail,
  };
}

function toMember(m: IncidentMessage, ts: number): Member {
  return {
    vin: m.vin,
    incidentId: m.incident_id,
    firstTs: ts,
    runaway: m.runaway,
    deviation: m.numbers.deviation,
    slopePerH: m.numbers.slope_per_h,
    lastCode: m.last_code ?? null,
    firmware: m.firmware,
  };
}

/** Members needed to count as "materially worse" after a dismissal at `at` members. */
export function reraiseThreshold(at: number, p: CampaignParams): number {
  return Math.min(Math.ceil(at * (1 + p.reraise.growthPct / 100)), at + p.reraise.growthAbs);
}

function evaluate(g: Group, ctx: ApplyContext, ts: number, grew: boolean, events: CampaignEvent[]): void {
  const p = ctx.params;
  const n = memberCount(g);
  const days = ((g.lastBucket - g.firstBucket + 1) * p.bucketH) / 24;
  const e = expectedLambda({
    vansInKey: ctx.rates.vansInKey,
    days,
    baselinePer1000: ctx.rates.baselinePer1000,
    regionalPer1000: ctx.rates.regionalPer1000,
    floorPer1000: p.rateFloorPer1000,
  });
  g.lambda = e.lambda;
  g.rateSource = e.source;
  g.pValue = poissonTail(n, e.lambda);
  const stats = { n, lambda: e.lambda, pValue: g.pValue, ratePer1000: e.ratePer1000, rateSource: e.source, days };
  if (g.status === 'WATCHING') {
    if (n >= p.minVans && g.pValue < p.alpha) {
      g.status = 'OPEN';
      g.openedTs = ts;
      g.version++;
      events.push(event(g, 'OPENED', ts, stats));
    } else if (grew) g.version++; // a watching group changed (no card)
  } else if (g.status === 'OPEN') {
    if (grew) {
      g.version++;
      events.push(event(g, 'GREW', ts, stats));
    }
  } else if (g.status === 'DISMISSED' && g.dismissal) {
    const worse = n >= reraiseThreshold(g.dismissal.atMembers, p) || g.dismissal.runawaySince;
    if (worse) {
      const why = g.dismissal.runawaySince ? 'a member turned runaway' : `members ${g.dismissal.atMembers} → ${n}`;
      g.status = 'OPEN';
      g.dismissal = null;
      g.version++;
      events.push(event(g, 'REOPENED', ts, { ...stats, why }));
    } else if (grew) g.version++; // grows quietly while dismissed
  }
}

/**
 * Apply one incident action (OPEN / ESCALATE / CLOSE) to its key's book. The caller has already dropped a
 * replayed (incident_id, action). Returns the new book and the events to publish.
 */
export function applyIncident(
  prev: KeyBook,
  m: IncidentMessage,
  ctx: ApplyContext,
): { book: KeyBook; events: CampaignEvent[] } {
  const book: KeyBook = { key: prev.key, groups: { ...prev.groups } };
  const events: CampaignEvent[] = [];
  if (m.action === 'CLOSE') return { book: prev, events }; // an S3 close never removes a member (S6 does)
  const p = ctx.params;
  const ts = Date.parse(m.event_ts);
  const b = bucketOf(ts, p.bucketH);
  const clone = (g: Group): Group => ({
    ...g,
    members: { ...g.members },
    dismissal: g.dismissal && { ...g.dismissal },
  });

  // join once: already a member of a live group of this key → only a runaway flag can change
  const home = Object.values(book.groups).find((g) => LIVE(g) && g.members[m.vin]);
  if (home) {
    if (m.runaway && !home.members[m.vin]!.runaway) {
      const g = clone(home);
      g.members[m.vin] = { ...g.members[m.vin]!, runaway: true };
      if (g.dismissal) g.dismissal.runawaySince = true;
      book.groups[g.id] = g;
      evaluate(g, ctx, ts, false, events);
    }
    return { book, events };
  }
  if (ctx.memberElsewhere) return { book: prev, events }; // stays in the campaign it joined first (transfer)

  // groups whose window touches this bucket
  const touching = Object.values(book.groups)
    .filter((g) => LIVE(g) && b >= g.firstBucket - 1 && b <= g.lastBucket + 1)
    .sort((x, y) => x.firstBucket - y.firstBucket || x.id.localeCompare(y.id));
  let g: Group;
  if (touching.length === 0) {
    g = {
      id: campaignIdOf(prev.key, b),
      familyKey: prev.key,
      family: m.fault_family,
      modelId: m.model_id,
      dutyId: m.duty_type_id,
      depotId: m.depot_id,
      regionId: m.region_id,
      status: 'WATCHING',
      firstBucket: b,
      lastBucket: b,
      firstTs: ts,
      lastTs: ts,
      members: {},
      mergedInto: null,
      openedTs: null,
      lambda: null,
      pValue: null,
      rateSource: null,
      dismissal: null,
      version: 0,
    };
  } else {
    g = clone(touching[0]!);
    // a bucket that bridges groups: union-find, the older group stays root, members join once
    const parents: Parents = {};
    const byId = new Map(touching.map((t) => [t.id, t]));
    const older = (x: string, y: string) => {
      const a = byId.get(x)!;
      const c = byId.get(y)!;
      return a.firstBucket < c.firstBucket || (a.firstBucket === c.firstBucket && a.id < c.id);
    };
    for (const other of touching.slice(1)) {
      union(parents, g.id, other.id, older);
      const child = clone(other);
      for (const [vin, mem] of Object.entries(child.members)) g.members[vin] ??= mem;
      g.firstBucket = Math.min(g.firstBucket, child.firstBucket);
      g.lastBucket = Math.max(g.lastBucket, child.lastBucket);
      g.firstTs = Math.min(g.firstTs, child.firstTs);
      g.lastTs = Math.max(g.lastTs, child.lastTs);
      if (child.status === 'DISMISSED' && g.status !== 'DISMISSED') {
        g.status = 'DISMISSED';
        g.dismissal = child.dismissal;
      } else if (child.status === 'OPEN' && g.status === 'WATCHING') {
        g.status = 'OPEN';
        g.openedTs = child.openedTs;
      }
      child.status = 'MERGED';
      child.mergedInto = g.id;
      child.members = {};
      child.version++;
      book.groups[child.id] = child;
      events.push(event(child, 'MERGED', ts, { into: g.id }));
    }
  }
  g.members[m.vin] = toMember(m, ts);
  g.firstBucket = Math.min(g.firstBucket, b);
  g.lastBucket = Math.max(g.lastBucket, b);
  g.firstTs = Math.min(g.firstTs, ts);
  g.lastTs = Math.max(g.lastTs, ts);
  if (m.runaway && g.dismissal) g.dismissal.runawaySince = true;
  book.groups[g.id] = g;
  evaluate(g, ctx, ts, true, events);
  return { book, events };
}

/** "Not an outbreak": sticky until materially worse. */
export function dismiss(g: Group, by: string, reason: string, ts: number): { group: Group; events: CampaignEvent[] } {
  if (g.status === 'MERGED' || g.status === 'CLOSED' || g.status === 'DISMISSED') return { group: g, events: [] };
  const out: Group = {
    ...g,
    status: 'DISMISSED',
    dismissal: { atMembers: memberCount(g), by, reason, ts, runawaySince: false },
    version: g.version + 1,
  };
  return { group: out, events: [event(out, 'DISMISSED', ts, { by, reason })] };
}

/** Event for a changed at-risk list (the list itself is computed by atrisk.ts from hourly scores). */
export function atRiskChanged(g: Group, ts: number, vins: readonly string[]): { group: Group; event: CampaignEvent } {
  const out = { ...g, version: g.version + 1 };
  return { group: out, event: event(out, 'AT_RISK_CHANGED', ts, { atRisk: vins.length, vins }) };
}
