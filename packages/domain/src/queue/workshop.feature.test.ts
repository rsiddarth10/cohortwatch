import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import { applyIncident, applyOutcome, emptyBook, type Group } from '../campaign/book.js';
import { DEFAULT_CAMPAIGN } from '../campaign/params.js';
import type { IncidentMessage } from '../detect/message.js';
import { DEFAULT_FIX, judgeRepair, type HourRow, type RepairStatus } from '../repair/confirm.js';
import { HOUR_MS } from '../time.js';
import { DEFAULT_QUEUE } from './params.js';
import {
  fillBays,
  mergeSignals,
  rank,
  type IncidentSignal,
  type Placed,
  type QueueSignal,
  type VanContext,
} from './queue.js';
import { reasonsOf } from './reasons.js';

/** BDD scenarios for brief §1.7 items 5, 6 and 8 (tests/bdd/workshop.feature), against the domain. */
const feature = await loadFeature('tests/bdd/workshop.feature');

const T0 = Date.UTC(2026, 8, 28, 4);
const ctx =
  (codes: Record<string, number> = {}) =>
  (vin: string): VanContext => ({ codes24h: codes[vin] ?? 0, behaviourRatio: null, inServiceTomorrow: true });
const inc = (vin: string, over: Partial<IncidentSignal> = {}): IncidentSignal => ({
  kind: 'INCIDENT', vin, depotId: 1, incidentId: `i-${vin}`, family: 'COOLING', metric: 'coolant_c', severity: 'HIGH',
  runaway: false, hoursToLimit: null, deviation: 6, slopePerH: 0.3, zSlope: 3, trigger: 'SIGNAL', ...over,
}); // prettier-ignore
const member = (vin: string): QueueSignal => ({ kind: 'CAMPAIGN', vin, depotId: 1, campaignId: 'c', family: 'COOLING', members: 18, role: 'MEMBER', depotCode: 'D-001', adjDev: null }); // prettier-ignore
const build = (signals: QueueSignal[], bays: number, codes: Record<string, number> = {}) =>
  fillBays(rank(mergeSignals(signals, ctx(codes)), DEFAULT_QUEUE), bays, DEFAULT_QUEUE);
const at = (placed: Placed[], vin: string) => placed.find((p) => p.vin === vin)!;

describeFeature(feature, ({ Scenario }) => {
  Scenario('Outbreak vans and the runaway rank above loud-but-stable vans', ({ Given, And, When, Then }) => {
    const signals: QueueSignal[] = [];
    let placed: Placed[] = [];
    Given('a depot with 3 bays', () => undefined);
    And('a loud-but-stable van with 40 fault codes a day and a flat trend', () => {
      signals.push(
        inc('LOUD', { trigger: 'DTC_RATE', severity: 'WARN', deviation: null, slopePerH: null, zSlope: null }),
      );
    });
    And('2 members of a COOLING campaign of 18 vans that are getting worse', () => {
      signals.push(
        inc('M1', { severity: 'WARN', zSlope: 2 }),
        member('M1'),
        inc('M2', { severity: 'WARN', zSlope: 1 }),
        member('M2'),
      );
    });
    And('a runaway van about 6 h from its limit', () =>
      signals.push(inc('RUN', { runaway: true, severity: 'CRITICAL', hoursToLimit: 6 })),
    );
    When('the queue is built', () => {
      placed = build(signals, 3, { LOUD: 40 });
    });
    Then('the runaway is rank 1', () => expect(placed[0]!.vin).toBe('RUN'));
    And('both campaign members rank above the loud-but-stable van', () => {
      expect(at(placed, 'M1').rank).toBeLessThan(at(placed, 'LOUD').rank);
      expect(at(placed, 'M2').rank).toBeLessThan(at(placed, 'LOUD').rank);
    });
    And('the loud-but-stable van does not get a bay today', () => expect(at(placed, 'LOUD').slot).not.toBe('TODAY'));
  });

  Scenario('The runaway jumps to the top with a critical reason', ({ Given, When, Then, And }) => {
    const signals: QueueSignal[] = [];
    let placed: Placed[] = [];
    Given('a depot queue with 5 vans that are getting worse', () => {
      for (let i = 0; i < 5; i++) signals.push(inc(`W${i}`, { zSlope: 4 + i }), member(`W${i}`));
    });
    When('a van turns runaway with 9 h to its limit', () => {
      signals.push(inc('RUN', { runaway: true, severity: 'WARN', hoursToLimit: 9, zSlope: 0 }));
      placed = build(signals, 2);
    });
    Then('it is rank 1 with the reason "runaway: ≈ 9 h to 110 °C"', () => {
      expect(placed[0]!.vin).toBe('RUN');
      expect(reasonsOf(placed[0]!)[0]!.text).toBe('runaway: ≈ 9 h to 110 °C');
    });
    And('it gets a bay today', () => expect(placed[0]!.slot).toBe('TODAY'));
  });

  Scenario(
    'The repaired van is confirmed fixed and the campaign closes only when all members are fixed',
    ({ Given, When, Then, And }) => {
      let g: Group;
      const repairTs = T0 + 30 * HOUR_MS;
      const hours = (z: number, n: number, from = repairTs): HourRow[] => Array.from({ length: n }, (_, i) => ({ ts: Math.ceil(from / HOUR_MS) * HOUR_MS + i * HOUR_MS, z })); // prettier-ignore
      const judge = (rows: HourRow[], from = repairTs): RepairStatus =>
        judgeRepair(from, rows, from + 60 * HOUR_MS, DEFAULT_FIX).status;
      const statuses: RepairStatus[] = [];
      let third: RepairStatus = 'REPAIRED';
      Given('an open COOLING campaign with 3 members', () => {
        let book = emptyBook('COOLING|6|1|10');
        const m = (vin: string, h: number): IncidentMessage => ({
        incident_id: `00000000-0000-5000-8000-00000000000${h}`, action: 'OPEN', vin, fault_family: 'COOLING', family_key: 'COOLING|6|1|10',
        window_bucket: 0, event_ts: new Date(T0 + h * HOUR_MS).toISOString(), seq: h, trigger: 'SIGNAL', metric: 'coolant_c',
        severity: 'HIGH', runaway: false, hours_to_limit: null, depot_id: 10, model_id: 6, duty_type_id: 1, region_id: 3,
        firmware: null, baseline_source: 'VAN',
        numbers: { level: 99, baseline_median: 90, deviation: 9, peer_adj: 0, z_level: 7, z_slope: 1, slope_per_h: 0.3, dtc_count_24h: 0, dtc_usual_per_day: 0 },
        clues: [],
      }); // prettier-ignore
        for (const [i, vin] of ['A', 'B', 'C'].entries()) {
          book = applyIncident(book, m(vin, 20 + i), {
            params: { ...DEFAULT_CAMPAIGN, minVans: 3 },
            rates: { vansInKey: 20, baselinePer1000: 1, regionalPer1000: 1 }, // 3 of 20 in a day: p ≈ 1e-5
            memberElsewhere: false,
          }).book;
        }
        g = Object.values(book.groups)[0]!;
        expect(g.status).toBe('OPEN');
      });
      When('2 members are repaired and their next 12 driven hours sit inside their normal', () => {
        statuses.push(judge(hours(0.5, 12)), judge(hours(0.8, 12)));
      });
      Then('those repairs are FIXED', () => expect(statuses).toEqual(['FIXED', 'FIXED']));
      And('the campaign stays open with 2 of 3 fixed', () => {
        g = applyOutcome(g, 'A', 'FIXED', T0).group;
        g = applyOutcome(g, 'B', 'FIXED', T0).group;
        expect(g.status).toBe('OPEN');
      });
      When("the third member's repair shows 24 driven hours still outside its normal", () => {
        third = judge(hours(4, 24));
      });
      Then('that repair is NOT_FIXED', () => expect(third).toBe('NOT_FIXED'));
      And('that van is back in the queue with "did not hold"', () => {
        const placed = build([{ kind: 'NOT_FIXED', vin: 'C', depotId: 1, repairedTs: repairTs }], 2);
        expect(reasonsOf(placed[0]!).map((r) => r.text)).toContain('repair on 2026-09-29 did not hold');
      });
      And('the campaign stays open', () => {
        g = applyOutcome(g, 'C', 'NOT_FIXED', T0).group;
        expect(g.status).toBe('OPEN');
      });
      When('the third member is repaired again and its readings return to normal', () => {
        const again = repairTs + 40 * HOUR_MS;
        expect(judge(hours(0.2, 12, again), again)).toBe('FIXED');
      });
      Then('the campaign is closed', () => {
        g = applyOutcome(g, 'C', 'FIXED', T0).group;
        expect(g.status).toBe('CLOSED');
      });
    },
  );
});
