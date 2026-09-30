import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMPAIGN } from '../campaign/params.js';
import { HOUR_MS } from '../time.js';
import { DEFAULT_QUEUE, QueueParamsSchema } from './params.js';
import {
  fillBays,
  mergeSignals,
  rank,
  scoreCandidate,
  type IncidentSignal,
  type QueueSignal,
  type VanContext,
} from './queue.js';
import { breakdownInr, costOfWaiting, costText, familyMetric, reasonsOf } from './reasons.js';

const P = DEFAULT_QUEUE;
const M = DEFAULT_CAMPAIGN.money;
const ctx =
  (over: Partial<VanContext> = {}) =>
  (): VanContext => ({ codes24h: 0, behaviourRatio: null, inServiceTomorrow: true, ...over });

const incident = (vin: string, over: Partial<IncidentSignal> = {}): IncidentSignal => ({
  kind: 'INCIDENT',
  vin,
  depotId: 1,
  incidentId: `inc-${vin}`,
  family: 'COOLING',
  metric: 'coolant_c',
  severity: 'WARN',
  runaway: false,
  hoursToLimit: null,
  deviation: 4,
  slopePerH: 0.3,
  zSlope: 3,
  trigger: 'SIGNAL',
  ...over,
});

describe('queue scoring', () => {
  it('a loud-but-stable van (many codes, flat trend) ranks below a quiet van that is getting worse', () => {
    const loud = mergeSignals(
      [incident('LOUD', { trigger: 'DTC_RATE', deviation: null, slopePerH: null, zSlope: null })],
      ctx({ codes24h: 40 }),
    )[0]!;
    const quiet = mergeSignals([incident('QUIET', { zSlope: 3 })], ctx({ codes24h: 0 }))[0]!;
    const ranked = rank([loud, quiet], P);
    expect(ranked.map((r) => r.vin)).toEqual(['QUIET', 'LOUD']);
    // the code count is not a score term at all
    const louder = scoreCandidate({ ...loud, ctx: { ...loud.ctx, codes24h: 400 } }, P);
    expect(louder.score).toBe(scoreCandidate(loud, P).score);
  });

  it('a runaway is pinned above any score, soonest limit first', () => {
    const big = mergeSignals(
      [
        incident('MEMBER', { severity: 'HIGH', zSlope: 8 }),
        {
          kind: 'CAMPAIGN',
          vin: 'MEMBER',
          depotId: 1,
          campaignId: 'c',
          family: 'COOLING',
          members: 40,
          role: 'MEMBER',
          depotCode: 'D-1',
          adjDev: null,
        },
      ],
      ctx({ behaviourRatio: 5 }),
    );
    const run1 = mergeSignals(
      [incident('RUN1', { severity: 'CRITICAL', runaway: true, hoursToLimit: 9, zSlope: 0 })],
      ctx({ inServiceTomorrow: false }),
    );
    const run2 = mergeSignals(
      [incident('RUN2', { severity: 'WARN', runaway: true, hoursToLimit: 4, zSlope: 0 })],
      ctx(),
    );
    const ranked = rank([...big, ...run1, ...run2], P);
    expect(ranked.map((r) => r.vin)).toEqual(['RUN2', 'RUN1', 'MEMBER']);
    expect(ranked[0]!.pinned).toBe(true);
    expect(ranked[2]!.score).toBeGreaterThan(ranked[0]!.score);
  });

  it('one entry per van with merged reasons; members outrank at-risk sisters; the behaviour term is capped at 10%', () => {
    const signals: QueueSignal[] = [
      incident('V1'),
      {
        kind: 'CAMPAIGN',
        vin: 'V1',
        depotId: 1,
        campaignId: 'c',
        family: 'COOLING',
        members: 18,
        role: 'MEMBER',
        depotCode: 'D-001',
        adjDev: null,
      },
      {
        kind: 'CAMPAIGN',
        vin: 'V2',
        depotId: 1,
        campaignId: 'c',
        family: 'COOLING',
        members: 18,
        role: 'AT_RISK',
        depotCode: 'D-001',
        adjDev: 2.1,
      },
      {
        kind: 'AT_RISK',
        vin: 'V3',
        depotId: 1,
        family: 'COOLING',
        metric: 'coolant_c',
        adjDev: 1.8,
        zSlope: 1,
        reason: 'coolant +1.8 °C above its own normal in 3 of the last 4 hours',
      },
      { kind: 'NOT_FIXED', vin: 'V4', depotId: 1, repairedTs: Date.UTC(2026, 8, 29, 10) },
    ];
    const cands = mergeSignals(signals, ctx());
    expect(cands).toHaveLength(4);
    const ranked = rank(cands, P);
    expect(ranked[0]!.vin).toBe('V1');
    const v2 = ranked.find((r) => r.vin === 'V2')!;
    const v3 = ranked.find((r) => r.vin === 'V3')!;
    expect(v2.parts.campaign).toBeGreaterThan(0);
    expect(v2.score).toBeGreaterThan(v3.score);
    const max = scoreCandidate({ ...cands[0]!, ctx: { ...cands[0]!.ctx, behaviourRatio: 100 } }, P);
    expect(max.parts.behaviour).toBeCloseTo(0.1, 9);
    expect(max.parts.behaviour / max.score).toBeLessThanOrEqual(0.1 + 1e-9 + max.parts.behaviour); // never more than the cap
    expect(scoreCandidate({ ...cands[0]!, ctx: { ...cands[0]!.ctx, behaviourRatio: 0.5 } }, P).parts.behaviour).toBe(0);
    expect(ranked.find((r) => r.vin === 'V4')!.parts.notFixed).toBe(P.weights.notFixed);
  });

  it('an at-risk-only van counts at a lower weight: never a bay, even with a steep trend', () => {
    const steep = mergeSignals(
      [
        {
          kind: 'AT_RISK',
          vin: 'AR',
          depotId: 1,
          family: 'COOLING',
          metric: 'coolant_c',
          adjDev: 1.5,
          zSlope: 9,
          reason: 'r',
        },
      ],
      ctx(),
    );
    const [p] = fillBays(rank(steep, P), 5, P);
    expect(p!.score).toBeLessThan(P.minBayScore);
    expect(p!.slot).toBe('WAITING');
  });

  it('fills today, then tomorrow, in rank order; low scores wait; a runaway always gets a bay', () => {
    const cands = mergeSignals(
      [
        incident('A', { severity: 'HIGH' }),
        incident('B', { severity: 'HIGH' }),
        incident('C', { severity: 'HIGH' }),
        incident('LOW', { severity: 'WARN', zSlope: 0 }),
        incident('RUN', { severity: 'WARN', runaway: true, hoursToLimit: 10, zSlope: 0 }),
      ],
      ctx({ inServiceTomorrow: false }),
    );
    const placed = fillBays(rank(cands, P), 2, P);
    expect(placed.map((p) => `${p.vin}:${p.slot}`)).toEqual([
      'RUN:TODAY',
      'A:TODAY',
      'B:TOMORROW',
      'C:TOMORROW',
      'LOW:WAITING',
    ]);
    expect(placed.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(placed[4]!.waitDays).toBe(2);
    expect(QueueParamsSchema.parse({ slotsPerBayPerDay: 2 }).slotsPerBayPerDay).toBe(2);
    expect(fillBays(rank(cands, P), 0, P).filter((p) => p.slot !== 'WAITING')).toHaveLength(0);
  });
});

describe('reasons and cost of waiting', () => {
  it('phrases, never scores', () => {
    const cands = mergeSignals(
      [
        incident('RUN', { severity: 'CRITICAL', runaway: true, hoursToLimit: 6.2 }),
        incident('RUN', { family: 'EXHAUST', metric: null, trigger: 'DTC_RATE' }),
        {
          kind: 'CAMPAIGN',
          vin: 'RUN',
          depotId: 1,
          campaignId: 'c',
          family: 'COOLING',
          members: 18,
          role: 'MEMBER',
          depotCode: 'D-001',
          adjDev: null,
        },
        {
          kind: 'CAMPAIGN',
          vin: 'RUN',
          depotId: 1,
          campaignId: 'c2',
          family: 'COOLING',
          members: 18,
          role: 'AT_RISK',
          depotCode: 'D-001',
          adjDev: 2.1,
        },
        {
          kind: 'AT_RISK',
          vin: 'RUN',
          depotId: 1,
          family: 'COOLING',
          metric: 'coolant_c',
          adjDev: 1,
          zSlope: 1,
          reason: 'coolant +1.0 °C',
        },
        { kind: 'NOT_FIXED', vin: 'RUN', depotId: 1, repairedTs: Date.UTC(2026, 8, 29, 10) },
      ],
      ctx({ codes24h: 5, behaviourRatio: 2 }),
    );
    const placed = fillBays(rank(cands, P), 1, P);
    const texts = reasonsOf(placed[0]!).map((r) => r.text);
    expect(texts).toEqual([
      'runaway: ≈ 6 h to 110 °C',
      'EXHAUST codes well above its own usual rate',
      'member of COOLING campaign at D-001 (18 vans)',
      'at-risk: same model and depot as an open COOLING campaign (D-001, 18 vans), coolant +2.1 °C vs its normal',
      'at-risk: coolant +1.0 °C',
      'repair on 2026-09-29 did not hold',
      '5 fault codes in the last 24 h',
      "harsh driving 2.0× its duty's usual (small, capped weight)",
      'in service tomorrow',
    ]);
    const plain = fillBays(
      rank(mergeSignals([incident('X', { severity: 'HIGH' })], ctx({ inServiceTomorrow: false })), P),
      1,
      P,
    );
    expect(reasonsOf(plain[0]!).map((r) => r.text)).toEqual([
      'COOLING incident: coolant 4.0 °C above its own normal, rising 0.30 °C/h',
    ]);
    const noLimit = fillBays(rank(mergeSignals([incident('Y', { runaway: true, metric: null })], ctx()), P), 1, P);
    expect(reasonsOf(noLimit[0]!)[0]!.text).toBe('runaway: COOLING critical');
    expect(familyMetric('EXHAUST')).toBeNull();
  });

  it('cost of waiting from time to limit, or a daily hazard by severity and role', () => {
    const b = breakdownInr(M);
    expect(b).toBe(8000 + 3 * 6000 + 25000);
    const [run] = fillBays(rank(mergeSignals([incident('R', { runaway: true, hoursToLimit: 12 })], ctx()), P), 0, P);
    expect(costOfWaiting(run!, 1, P, M)).toBe(b); // a day is longer than its 12 h to limit
    expect(costOfWaiting(run!, 0, P, M)).toBe(0);
    const [warn] = fillBays(rank(mergeSignals([incident('W')], ctx()), P), 0, P);
    expect(costOfWaiting(warn!, 1, P, M)).toBe(Math.round(0.05 * b));
    expect(costText(warn!, P, M).text).toBe(
      `waiting 2 days ≈ ₹${new Intl.NumberFormat('en-IN').format(Math.round((1 - 0.95 ** 2) * b))}`,
    );
    const [ar] = fillBays(
      rank(
        mergeSignals(
          [
            {
              kind: 'AT_RISK',
              vin: 'A',
              depotId: 1,
              family: 'COOLING',
              metric: 'coolant_c',
              adjDev: 1,
              zSlope: 0,
              reason: 'r',
            },
          ],
          ctx(),
        ),
        P,
      ),
      1,
      P,
    );
    const two = Math.round((1 - 0.97 ** 2) * b); // below the bay threshold: it waits 2 days
    expect(ar!.slot).toBe('WAITING');
    expect(costText(ar!, P, M)).toEqual({
      inr: two,
      text: `waiting 2 days ≈ ₹${new Intl.NumberFormat('en-IN').format(two)}`,
    });
    expect(HOUR_MS).toBe(3_600_000);
  });
});
