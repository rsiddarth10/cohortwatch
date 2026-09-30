import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { IncidentMessage } from '../detect/message.js';
import { HOUR_MS } from '../time.js';
import { applyIncident, dismiss, emptyBook, type Group, type KeyBook } from './book.js';
import { DEFAULT_CAMPAIGN } from './params.js';

/**
 * BDD scenarios for brief §1.7 items 1, 2, 3, 7 and 9 (tests/bdd/campaigns.feature), against the domain book:
 * a small fleet harness routes each incident to its family key's book, like the engine does per partition.
 */
const feature = await loadFeature('tests/bdd/campaigns.feature');

const T0 = Date.UTC(2026, 8, 28, 4);
const S1 = 10;
const KS_D1 = 6;
const URBAN = 1;

class Fleet {
  books = new Map<string, KeyBook>();
  regionalPer1000 = 1;
  private n = 0;

  raise(vin: string, h: number, over: Partial<IncidentMessage> = {}): void {
    this.n++;
    const depot = over.depot_id ?? S1;
    const model = over.model_id ?? KS_D1;
    const key = `COOLING|${model}|${URBAN}|${depot}`;
    const m: IncidentMessage = {
      incident_id: `00000000-0000-5000-9000-${String(this.n).padStart(12, '0')}`,
      action: 'OPEN',
      vin,
      fault_family: 'COOLING',
      family_key: key,
      window_bucket: 0,
      event_ts: new Date(T0 + h * HOUR_MS).toISOString(),
      seq: this.n,
      trigger: 'SIGNAL',
      metric: 'coolant_c',
      severity: 'WARN',
      runaway: false,
      hours_to_limit: null,
      depot_id: depot,
      model_id: model,
      duty_type_id: URBAN,
      region_id: 3,
      firmware: '4.2.1',
      baseline_source: 'VAN',
      last_code: 'P0217',
      numbers: {
        level: 99,
        baseline_median: 90,
        deviation: 9,
        peer_adj: 0,
        z_level: 7,
        z_slope: 1,
        slope_per_h: 0.3,
        dtc_count_24h: 0,
        dtc_usual_per_day: 0,
      },
      clues: [],
      ...over,
    };
    const r = applyIncident(this.books.get(key) ?? emptyBook(key), m, {
      params: DEFAULT_CAMPAIGN,
      rates: { vansInKey: 60, baselinePer1000: 4, regionalPer1000: this.regionalPer1000 },
      memberElsewhere: false,
    });
    this.books.set(key, r.book);
  }

  live(): Group[] {
    return [...this.books.values()].flatMap((b) => Object.values(b.groups)).filter((g) => g.status !== 'MERGED');
  }

  open(): Group[] {
    return this.live().filter((g) => g.status === 'OPEN');
  }

  s1(): Group {
    return this.live().find((g) => g.depotId === S1 && g.modelId === KS_D1)!;
  }

  replace(g: Group): void {
    const b = this.books.get(g.familyKey)!;
    this.books.set(g.familyKey, { ...b, groups: { ...b.groups, [g.id]: g } });
  }
}

const sisters = (fleet: Fleet, from: number, count: number, h: number) => {
  for (let i = from; i < from + count; i++) fleet.raise(`SISTER${String(i).padStart(11, '0')}`, h + i * 0.5);
};

describeFeature(feature, ({ Scenario }) => {
  Scenario('With the plant on, a campaign opens on the sisters', ({ Given, When, Then, And }) => {
    const fleet = new Fleet();
    Given('60 KS-D1 vans on urban duty at depot S1', () => undefined);
    When('6 of them raise a COOLING incident within one day', () => sisters(fleet, 0, 6, 8));
    Then('exactly 1 campaign is open', () => expect(fleet.open()).toHaveLength(1));
    And('its members are those 6 vans', () => expect(Object.keys(fleet.open()[0]!.members)).toHaveLength(6));
  });

  Scenario('Scattered decoys stay out', ({ Given, When, Then }) => {
    const fleet = new Fleet();
    Given('6 diesel vans at 6 different depots', () => undefined);
    When('each raises a COOLING incident on the same day', () => {
      for (let d = 0; d < 6; d++) fleet.raise(`DECOY${String(d).padStart(12, '0')}`, 10 + d, { depot_id: 20 + d });
    });
    Then('no campaign is open', () => expect(fleet.open()).toHaveLength(0));
  });

  Scenario('A same-depot van of another model stays out', ({ Given, When, Then, And }) => {
    const fleet = new Fleet();
    Given('an open campaign at depot S1 for model KS-D1 with 5 sisters', () => sisters(fleet, 0, 5, 8));
    When('2 vans of another model at depot S1 raise COOLING incidents', () => {
      fleet.raise('OTHERMODEL0000001', 12, { model_id: 3 });
      fleet.raise('OTHERMODEL0000002', 13, { model_id: 3 });
    });
    Then('the campaign still has 5 members', () => expect(Object.keys(fleet.s1().members)).toHaveLength(5));
    And('exactly 1 campaign is open', () => expect(fleet.open()).toHaveLength(1));
  });

  Scenario('The heatwave opens nothing', ({ Given, When, Then, And }) => {
    const fleet = new Fleet();
    Given('the rest of the region is running 40 incidents per 1,000 van-days', () => {
      fleet.regionalPer1000 = 40;
    });
    When('6 vans at one depot raise a COOLING incident within one day', () => sisters(fleet, 0, 6, 8));
    Then('no campaign is open', () => expect(fleet.open()).toHaveLength(0));
    And('their group is only watching', () => expect(fleet.s1().status).toBe('WATCHING'));
  });

  Scenario('One more sister grows the campaign, never a second one', ({ Given, When, Then, And }) => {
    const fleet = new Fleet();
    Given('an open campaign at depot S1 for model KS-D1 with 5 sisters', () => sisters(fleet, 0, 5, 8));
    When('a 6th sister raises a COOLING incident a day later', () => fleet.raise('SISTER00000000005', 34));
    Then('exactly 1 campaign is open', () => expect(fleet.open()).toHaveLength(1));
    And('the campaign has 6 members', () => expect(Object.keys(fleet.s1().members)).toHaveLength(6));
  });

  Scenario('Duplicate or late notes never clone a member', ({ Given, When, Then }) => {
    const fleet = new Fleet();
    Given('an open campaign at depot S1 for model KS-D1 with 5 sisters', () => sisters(fleet, 0, 5, 8));
    When('a member raises a second incident, an earlier late incident, and a close', () => {
      fleet.raise('SISTER00000000000', 20);
      fleet.raise('SISTER00000000000', 2);
      fleet.raise('SISTER00000000000', 21, { action: 'CLOSE' });
    });
    Then('the campaign still has 5 members', () => expect(Object.keys(fleet.s1().members)).toHaveLength(5));
  });

  Scenario('An override survives the next tick', ({ Given, When, Then, And }) => {
    const fleet = new Fleet();
    Given('an open campaign at depot S1 for model KS-D1 with 6 sisters', () => sisters(fleet, 0, 6, 8));
    And('the lead dismisses it as not an outbreak', () => {
      fleet.replace(dismiss(fleet.s1(), 'lead', 'known heat issue', T0).group);
    });
    When('1 more sister raises a COOLING incident', () => sisters(fleet, 6, 1, 8));
    Then('the campaign stays dismissed', () => expect(fleet.s1().status).toBe('DISMISSED'));
    When('2 more sisters raise COOLING incidents', () => sisters(fleet, 7, 2, 8));
    Then('the campaign is re-raised', () => expect(fleet.s1().status).toBe('OPEN'));
  });
});
