import { describe, expect, it } from 'vitest';
import type { IncidentMessage } from '../detect/message.js';
import { HOUR_MS } from '../time.js';
import { atRiskOf, type HourlyScore } from './atrisk.js';
import {
  applyIncident,
  atRiskChanged,
  bucketOf,
  campaignIdOf,
  dismiss,
  emptyBook,
  reraiseThreshold,
  type ApplyContext,
  type CampaignEvent,
  type KeyBook,
} from './book.js';
import { campaignClues, costIfNotFixed } from './clues.js';
import { firmwareClue } from './firmware.js';
import { CampaignParamsSchema, DEFAULT_CAMPAIGN } from './params.js';
import { expectedLambda, poissonTail, ratePer1000 } from './poisson.js';
import { cosine, FEATURE_DIM, featureVector, pastCampaigns } from './similarity.js';
import { find, union, type Parents } from './unionfind.js';

const T0 = Date.UTC(2026, 8, 28, 4);
const P = DEFAULT_CAMPAIGN;
const KEY = 'COOLING|6|1|10';
const RATES = { vansInKey: 60, baselinePer1000: 4, regionalPer1000: 1 };
const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
  params: P,
  rates: RATES,
  memberElsewhere: false,
  ...over,
});

let n = 0;
function inc(vin: string, h: number, over: Partial<IncidentMessage> = {}): IncidentMessage {
  n++;
  return {
    incident_id: `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`,
    action: 'OPEN',
    vin,
    fault_family: 'COOLING',
    family_key: KEY,
    window_bucket: 0,
    event_ts: new Date(T0 + h * HOUR_MS).toISOString(),
    seq: 1,
    trigger: 'SIGNAL',
    metric: 'coolant_c',
    severity: 'WARN',
    runaway: false,
    hours_to_limit: null,
    depot_id: 10,
    model_id: 6,
    duty_type_id: 1,
    region_id: 3,
    firmware: '4.2.1',
    baseline_source: 'VAN',
    last_code: 'P0217',
    numbers: {
      level: 98,
      baseline_median: 90,
      deviation: 8,
      peer_adj: 0,
      z_level: 6,
      z_slope: 1,
      slope_per_h: 0.3,
      dtc_count_24h: 0,
      dtc_usual_per_day: 0,
    },
    clues: [],
    ...over,
  };
}

function feed(book: KeyBook, msgs: IncidentMessage[], c = ctx()) {
  const events: CampaignEvent[] = [];
  for (const m of msgs) {
    const r = applyIncident(book, m, c);
    book = r.book;
    events.push(...r.events);
  }
  return { book, events };
}

const live = (b: KeyBook) => Object.values(b.groups).filter((g) => g.status !== 'MERGED');

describe('Poisson outbreak test', () => {
  it('tail equals 1 − CDF for moderate values and stays accurate far in the tail', () => {
    const cdf = (k: number, l: number) => {
      let s = 0;
      let t = Math.exp(-l);
      for (let i = 0; i < k; i++) {
        s += t;
        t *= l / (i + 1);
      }
      return s;
    };
    for (const [k, l] of [
      [5, 0.7],
      [3, 2.5],
      [10, 4],
      [1, 0.1],
    ] as const) {
      expect(poissonTail(k, l)).toBeCloseTo(1 - cdf(k, l), 12);
    }
    expect(poissonTail(18, 0.5)).toBeGreaterThan(0);
    expect(poissonTail(18, 0.5)).toBeLessThan(1e-15);
    expect(poissonTail(0, 3)).toBe(1);
    expect(poissonTail(3, 0)).toBe(0);
  });

  it('expected λ takes the largest of floor, baseline and the current regional rate', () => {
    expect(expectedLambda({ vansInKey: 60, days: 2, baselinePer1000: 4, regionalPer1000: 1, floorPer1000: 2 })).toEqual(
      {
        lambda: 0.48,
        ratePer1000: 4,
        source: 'baseline',
      },
    );
    expect(
      expectedLambda({ vansInKey: 60, days: 2, baselinePer1000: 1, regionalPer1000: 30, floorPer1000: 2 }).source,
    ).toBe('regional');
    expect(
      expectedLambda({ vansInKey: 60, days: 1, baselinePer1000: 0, regionalPer1000: 0, floorPer1000: 2 }).lambda,
    ).toBeCloseTo(0.12);
    expect(ratePer1000(5, 1000, 2)).toBe(2.5);
    expect(ratePer1000(5, 0, 2)).toBe(0);
  });
});

describe('union-find', () => {
  it('merges into the older root with path compression', () => {
    const parents: Parents = {};
    const older = (a: string, b: string) => a < b;
    expect(union(parents, 'c', 'b', older)).toBe('b');
    expect(union(parents, 'b', 'a', older)).toBe('a');
    expect(find(parents, 'c')).toBe('a');
    expect(parents.c).toBe('a'); // compressed
    expect(union(parents, 'c', 'a', older)).toBe('a');
    expect(find(parents, 'z')).toBe('z');
  });
});

describe('campaign book', () => {
  it('opens at the 5th sister, grows with the 6th and 7th, never a second campaign', () => {
    const { book, events } = feed(
      emptyBook(KEY),
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((v, i) => inc(`VIN${v}`, 20 + i)),
    );
    expect(events.map((e) => e.type)).toEqual(['OPENED', 'GREW', 'GREW']);
    expect(live(book)).toHaveLength(1);
    const g = live(book)[0]!;
    expect(Object.keys(g.members)).toHaveLength(7);
    expect(g.status).toBe('OPEN');
    expect(g.id).toBe(campaignIdOf(KEY, bucketOf(T0 + 20 * HOUR_MS, 24)));
    expect(events[0]!.members).toBe(5);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
  });

  it('join once: a second incident of a member, a CLOSE, or a van already in another key add nothing', () => {
    let { book } = feed(
      emptyBook(KEY),
      ['A', 'B', 'C', 'D', 'E'].map((v, i) => inc(`VIN${v}`, 20 + i)),
    );
    const before = book;
    const again = applyIncident(book, inc('VINA', 30), ctx());
    expect(again.events).toEqual([]);
    expect(Object.keys(live(again.book)[0]!.members)).toHaveLength(5);
    expect(applyIncident(book, inc('VINZ', 30, { action: 'CLOSE' }), ctx()).book).toBe(book);
    expect(applyIncident(book, inc('VINY', 30), ctx({ memberElsewhere: true })).book).toBe(before);
    book = applyIncident(book, inc('VINA', 31, { action: 'ESCALATE', runaway: true }), ctx()).book;
    expect(live(book)[0]!.members.VINA!.runaway).toBe(true);
  });

  it('WATCHING below the bar: 5 vans but not surprising (big regional rate: a heatwave), or fewer than 5', () => {
    const heat = feed(
      emptyBook(KEY),
      ['A', 'B', 'C', 'D', 'E', 'F'].map((v, i) => inc(`VIN${v}`, 20 + i)),
      ctx({
        rates: { vansInKey: 60, baselinePer1000: 4, regionalPer1000: 40 },
      }),
    );
    expect(heat.events).toEqual([]);
    expect(live(heat.book)[0]!.status).toBe('WATCHING');
    expect(live(heat.book)[0]!.rateSource).toBe('regional');
    const few = feed(
      emptyBook(KEY),
      ['A', 'B', 'C', 'D'].map((v, i) => inc(`VIN${v}`, 20 + i)),
    );
    expect(live(few.book)[0]!.status).toBe('WATCHING');
    expect(live(few.book)[0]!.pValue).toBeLessThan(P.alpha); // surprising, but under 5 vans
  });

  it('five scattered vans at five depots are five keys: no campaign anywhere', () => {
    for (let d = 0; d < 5; d++) {
      const key = `COOLING|6|1|${20 + d}`;
      const { events } = feed(emptyBook(key), [inc(`VIN${d}`, 20, { depot_id: 20 + d, family_key: key })]);
      expect(events).toEqual([]);
    }
  });

  it('touching windows merge (union-find); a gap of two buckets starts a new group', () => {
    let { book } = feed(emptyBook(KEY), [inc('VINA', 0), inc('VINB', 1), inc('VINC', 44), inc('VIND', 45)]);
    expect(live(book)).toHaveLength(2);
    const r = feed(book, [inc('VINE', 30)]); // bucket +1 touches bucket 0 and bucket +2 → both groups merge
    book = r.book;
    expect(live(book)).toHaveLength(1);
    expect(r.events.map((e) => e.type)).toEqual(['MERGED', 'OPENED']);
    const root = live(book)[0]!;
    expect(root.firstBucket).toBe(bucketOf(T0, 24));
    expect(Object.keys(root.members).sort()).toEqual(['VINA', 'VINB', 'VINC', 'VIND', 'VINE']);
    const merged = Object.values(book.groups).find((g) => g.status === 'MERGED')!;
    expect(merged.mergedInto).toBe(root.id);
  });

  it('a dismissal is sticky until materially worse, then REOPENED; a runaway member re-raises too', () => {
    let { book } = feed(
      emptyBook(KEY),
      ['A', 'B', 'C', 'D', 'E', 'F'].map((v, i) => inc(`VIN${v}`, 20 + i)),
    );
    const g = live(book)[0]!;
    const d = dismiss(g, 'lead@fleet', 'known heat issue', T0);
    expect(d.events[0]!.type).toBe('DISMISSED');
    expect(dismiss(d.group, 'x', 'y', T0).events).toEqual([]); // already dismissed
    book = { ...book, groups: { ...book.groups, [g.id]: d.group } };
    expect(reraiseThreshold(6, P)).toBe(9);
    expect(reraiseThreshold(18, P)).toBe(21);
    const quiet = feed(
      book,
      ['G', 'H'].map((v, i) => inc(`VIN${v}`, 30 + i)),
    );
    expect(quiet.events).toEqual([]);
    expect(live(quiet.book)[0]!.status).toBe('DISMISSED');
    const worse = feed(quiet.book, [inc('VINI', 33)]);
    expect(worse.events.map((e) => e.type)).toEqual(['REOPENED']);
    // runaway path
    const dis2 = dismiss(live(worse.book)[0]!, 'lead', 'again', T0);
    let b2: KeyBook = { ...worse.book, groups: { ...worse.book.groups, [dis2.group.id]: dis2.group } };
    b2 = applyIncident(b2, inc('VINA', 34, { action: 'ESCALATE', runaway: true }), ctx()).book;
    expect(live(b2)[0]!.status).toBe('OPEN');
  });

  it('at-risk change bumps the version with a stable event id', () => {
    const { book } = feed(
      emptyBook(KEY),
      ['A', 'B', 'C', 'D', 'E'].map((v, i) => inc(`VIN${v}`, 20 + i)),
    );
    const g = live(book)[0]!;
    const r = atRiskChanged(g, T0, ['VINX', 'VINY']);
    expect(r.group.version).toBe(g.version + 1);
    expect(r.event).toMatchObject({ type: 'AT_RISK_CHANGED', detail: { atRisk: 2 } });
  });

  it('params are overridable', () => {
    expect(CampaignParamsSchema.parse({ alpha: 1e-4 }).alpha).toBe(1e-4);
  });
});

describe('at-risk sisters', () => {
  const row = (h: number, z: number | null, zs: number | null = 0, dev: number | null = 1): HourlyScore => ({
    ts: T0 + h * HOUR_MS,
    adjDev: dev,
    zLevel: z,
    zSlope: zs,
  });
  it('3 of the last 4 hours above z 1.5, or a steep rise with a positive deviation', () => {
    expect(atRiskOf([row(4, 1.6), row(3, 1.7), row(2, 1.0), row(1, 1.9)], P.atRisk)).toMatchObject({
      atRisk: true,
      ts: T0 + 4 * HOUR_MS,
    });
    expect(atRiskOf([row(4, 1.6), row(3, 1.0), row(2, 1.0), row(1, 1.9), row(0, 2)], P.atRisk).atRisk).toBe(false);
    expect(atRiskOf([row(4, 0.5, 2.5, 0.3)], P.atRisk).atRisk).toBe(true);
    expect(atRiskOf([row(4, 0.5, 2.5, -0.3)], P.atRisk).atRisk).toBe(false);
    expect(atRiskOf([row(4, null)], P.atRisk)).toEqual({ atRisk: false, ts: null, reason: null });
  });
});

describe('firmware clue', () => {
  const day = 24 * HOUR_MS;
  it('same window for members and sisters: 16/18 vs 48% is shown, a small gap is not', () => {
    const first = T0 + 22 * HOUR_MS;
    const members = Array.from({ length: 18 }, (_, i) => ({
      vin: `M${i}`,
      firstIncidentTs: first + i * HOUR_MS,
      installs: i < 16 ? [{ version: '4.2.1', ts: T0 - day }] : [{ version: '4.1.2', ts: T0 - 20 * day }],
    }));
    const sisters = Array.from({ length: 42 }, (_, i) => ({
      vin: `S${i}`,
      installs: i < 20 ? [{ version: '4.2.1', ts: T0 - day }] : [],
    }));
    const c = firmwareClue({ members, sisters, campaignFirstTs: first }, P.firmware)!;
    expect(c).toMatchObject({ version: '4.2.1', membersWith: 16, sistersWith: 20, shown: true });
    expect(c.text).toBe('16 of 18 got firmware 4.2.1 in the 3 days before onset, vs 48% of healthy sisters (20 of 42)');
    const even = firmwareClue(
      {
        members,
        sisters: sisters.map((s) => ({ ...s, installs: [{ version: '4.2.1', ts: T0 - day }] })),
        campaignFirstTs: first,
      },
      P.firmware,
    )!;
    expect(even.shown).toBe(false);
    // an install outside the window does not count
    const old = firmwareClue(
      {
        members: members.map((m) => ({ ...m, installs: [{ version: '4.2.1', ts: T0 - 10 * day }] })),
        sisters,
        campaignFirstTs: first,
      },
      P.firmware,
    );
    expect(old).toBeNull();
    expect(firmwareClue({ members: [], sisters, campaignFirstTs: first }, P.firmware)).toBeNull();
  });
});

describe('clues and money', () => {
  it('phrases with numbers and units', () => {
    const { book } = feed(
      emptyBook(KEY),
      ['A', 'B', 'C', 'D', 'E'].map((v, i) => inc(`VIN${v}`, 20 + i)),
    );
    const members = Object.values(live(book)[0]!.members);
    const clues = campaignClues(
      members,
      { family: 'COOLING', model: 'KS-D1', duty: 'URBAN', depot: 'D-0010', unit: '°C' },
      { n: 5, lambda: 0.24, pValue: 1e-6, days: 1, keyPer1000: 83, regionalPer1000: 0.8 },
    );
    expect(clues.map((c) => c.type)).toEqual(['PLACE', 'TREND', 'CODES', 'SURPRISE', 'REGION']);
    expect(clues[1]!.text).toBe('typical member is 8.0 °C above its own normal, rising 0.30 °C/h');
    expect(clues[2]!.text).toBe('top codes: P0217 (5 vans)');
    expect(clues[4]!.text).toMatch(/^peers elsewhere in the region are normal/);
    const hot = campaignClues(members, { family: 'COOLING', model: 'm', duty: 'URBAN', depot: 'd', unit: '°C' }, {
      n: 5, lambda: 3, pValue: 0.2, days: 2, keyPer1000: 40, regionalPer1000: 30,
    }); // prettier-ignore
    expect(hot[4]!.text).toMatch(/elevated too/);
    const money = costIfNotFixed(18, 4, P.money);
    expect(money.value).toBe(22 * (8000 + 3 * 6000 + 25000 - 12000));
    expect(money.text).toMatch(/^cost if not fixed ≈ ₹8,58,000 \(22 vans/);
  });
});

describe('similar past campaigns', () => {
  it('30 deterministic synthetic cases; a cooling-diesel outbreak is closest to a cooling case', () => {
    const past = pastCampaigns();
    expect(past).toHaveLength(30);
    expect(pastCampaigns()).toEqual(past);
    expect(featureVector(past[0]!)).toHaveLength(FEATURE_DIM);
    const q = featureVector({
      family: 'COOLING',
      powertrain: 'DIESEL',
      duty: 'URBAN',
      climate: 'HOT_HUMID',
      members: 18,
      deviation: 9,
      slopePerH: 0.3,
      codes: ['P0217', 'P0217', 'P0118'],
    });
    const ranked = [...past].sort((a, b) => cosine(q, featureVector(b)) - cosine(q, featureVector(a)));
    expect(ranked.slice(0, 3).every((p) => p.family === 'COOLING')).toBe(true);
    expect(cosine(q, q)).toBeCloseTo(1, 12);
    expect(
      cosine(
        q,
        q.map(() => 0),
      ),
    ).toBe(0);
  });
});
