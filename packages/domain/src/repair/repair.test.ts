import { describe, expect, it } from 'vitest';
import { applyIncident, applyOutcome, emptyBook, type Group } from '../campaign/book.js';
import { DEFAULT_CAMPAIGN } from '../campaign/params.js';
import type { IncidentMessage } from '../detect/message.js';
import { emptyVan, resetForRepair, stepVan, type DetectEvent } from '../detect/vanstate.js';
import { DEFAULT_DETECT } from '../detect/params.js';
import { PeerContext } from '../detect/peer.js';
import { HOUR_MS } from '../time.js';
import { DEFAULT_FIX, FixParamsSchema, judgeRepair, type HourRow } from './confirm.js';

const T0 = Date.UTC(2026, 8, 28, 4);
const REPAIR = T0 + 30 * HOUR_MS + 17 * 60_000; // 10:17

/** Hourly rows after the repair: `driven` hours with z, then idle hours. */
function rows(z: (i: number) => number | null, hours: number, from = Math.ceil(REPAIR / HOUR_MS) * HOUR_MS): HourRow[] {
  return Array.from({ length: hours }, (_, i) => ({ ts: from + i * HOUR_MS, z: z(i) }));
}

describe('fix confirmation', () => {
  it('PENDING when not driven since the repair', () => {
    const v = judgeRepair(
      REPAIR,
      rows(() => null, 20),
      REPAIR + 20 * HOUR_MS,
      DEFAULT_FIX,
    );
    expect(v).toMatchObject({ status: 'PENDING', drivenHours: 0, text: 'pending: not driven since the repair' });
  });

  it('FIXED after ≥ 12 driven hours with ≥ 6 of the last 8 inside its band', () => {
    const early = judgeRepair(
      REPAIR,
      rows(() => 0.5, 11),
      REPAIR + 11 * HOUR_MS,
      DEFAULT_FIX,
    );
    expect(early.status).toBe('PENDING');
    expect(early.text).toBe('pending: 11 driven hours since the repair, 8 of the last 8 inside its normal');
    const v = judgeRepair(
      REPAIR,
      rows((i) => (i === 3 ? 2.5 : 0.5), 12),
      REPAIR + 12 * HOUR_MS,
      DEFAULT_FIX,
    );
    expect(v).toMatchObject({ status: 'FIXED', drivenHours: 12, insideRecent: 8 });
    expect(v.text).toMatch(/^fixed ✓/);
  });

  it('the hour containing the repair (pre-repair readings) and rows after the 48-h window do not count', () => {
    const before = [{ ts: Math.floor(REPAIR / HOUR_MS) * HOUR_MS, z: 9 }];
    const late = rows(() => 0.1, 5, REPAIR + 60 * HOUR_MS);
    expect(judgeRepair(REPAIR, [...before, ...late], REPAIR + 70 * HOUR_MS, DEFAULT_FIX).drivenHours).toBe(0);
  });

  it('NOT_FIXED after 24 driven hours outside the band, or once the window is over with enough driving', () => {
    const bad = judgeRepair(
      REPAIR,
      rows(() => 4, 24),
      REPAIR + 30 * HOUR_MS,
      DEFAULT_FIX,
    );
    expect(bad.status).toBe('NOT_FIXED');
    expect(bad.text).toBe('not fixed: still outside its own normal in 8 of the last 8 driven hours (24 h driven)');
    const mixed = rows((i) => (i % 10 < 8 ? (i % 2 ? 3 : 0.5) : null), 47);
    expect(judgeRepair(REPAIR, mixed, REPAIR + 25 * HOUR_MS, DEFAULT_FIX).status).toBe('PENDING'); // 21 driven h, 4 of 8 inside
    expect(judgeRepair(REPAIR, mixed, REPAIR + 49 * HOUR_MS, DEFAULT_FIX).status).toBe('NOT_FIXED');
    expect(FixParamsSchema.parse({ band: 3 }).band).toBe(3);
  });
});

describe('repair resets the trend (S3)', () => {
  const env = {
    params: DEFAULT_DETECT,
    baseline: {
      metrics: { coolant_c: { median: 90, mad: 0.4, slopeMedian: 0, slopeMad: 0.1, source: 'VAN' as const } },
      dtcPerDay: {},
    },
    peers: new PeerContext(2, 10),
    peerKeys: () => [],
  };
  const reading = (seq: number, ts: number, coolant: number): DetectEvent => ({
    vin: 'V',
    seq,
    ts,
    evt: 'PERIODIC',
    ignition: true,
    charging: false,
    speedKmh: 40,
    values: { coolant_c: coolant, batt_temp_c: null, lv_batt_v: null },
    dtc: [],
    families: [],
    flags: [],
  });

  it('drops the pre-repair sums, ignores late pre-repair readings, and is idempotent', () => {
    let st = emptyVan();
    for (let i = 0; i < 40; i++) st = stepVan(st, reading(i + 1, T0 + i * 0.5 * HOUR_MS, 100), env).state;
    expect(st.m.coolant_c!.slow.Sy / st.m.coolant_c!.slow.S).toBeCloseTo(100, 6);
    const reset = resetForRepair(st, REPAIR);
    expect(reset.m).toEqual({});
    expect(reset.open).toEqual(st.open); // the incident closes on post-repair readings, not by decree
    expect(resetForRepair(reset, REPAIR)).toBe(reset);
    expect(resetForRepair(reset, REPAIR - 1)).toBe(reset);
    const late = stepVan(reset, reading(100, REPAIR - HOUR_MS, 120), env);
    expect(late.state.m).toEqual({});
    expect(late.state.lastSeq).toBe(100);
    const after = stepVan(late.state, reading(101, REPAIR + HOUR_MS, 90), env).state;
    expect(after.m.coolant_c!.slow.Sy / after.m.coolant_c!.slow.S).toBeCloseTo(90, 6);
    expect(after.repairTs).toBe(REPAIR);
  });
});

describe('campaign close (S5 book)', () => {
  const inc = (vin: string, h: number): IncidentMessage => ({
    incident_id: `00000000-0000-5000-b000-${vin.padStart(12, '0').slice(-12)}`,
    action: 'OPEN',
    vin,
    fault_family: 'COOLING',
    family_key: 'COOLING|6|1|10',
    window_bucket: 0,
    event_ts: new Date(T0 + h * HOUR_MS).toISOString(),
    seq: h,
    trigger: 'SIGNAL',
    metric: 'coolant_c',
    severity: 'WARN',
    runaway: false,
    hours_to_limit: null,
    depot_id: 10,
    model_id: 6,
    duty_type_id: 1,
    region_id: 3,
    firmware: null,
    baseline_source: 'VAN',
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
  });

  it('closes only when every member is FIXED; a NOT_FIXED member keeps it open', () => {
    let book = emptyBook('COOLING|6|1|10');
    for (let i = 0; i < 5; i++) {
      book = applyIncident(book, inc(`V${i}`, 20 + i), {
        params: DEFAULT_CAMPAIGN,
        rates: { vansInKey: 60, baselinePer1000: 1, regionalPer1000: 1 },
        memberElsewhere: false,
      }).book;
    }
    let g: Group = Object.values(book.groups)[0]!;
    expect(g.status).toBe('OPEN');
    const types: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = applyOutcome(g, `V${i}`, 'FIXED', T0 + 60 * HOUR_MS);
      g = r.group;
      types.push(...r.events.map((e) => `${e.type}:${String(e.detail.fixed)}`));
    }
    expect(applyOutcome(g, 'V0', 'FIXED', T0).events).toEqual([]); // no change
    expect(applyOutcome(g, 'NOBODY', 'FIXED', T0).events).toEqual([]);
    const bad = applyOutcome(g, 'V4', 'NOT_FIXED', T0 + 70 * HOUR_MS);
    expect(bad.events).toEqual([]); // not fixed and it was not fixed before
    expect(bad.group.status).toBe('OPEN');
    const last = applyOutcome(g, 'V4', 'FIXED', T0 + 80 * HOUR_MS);
    types.push(...last.events.map((e) => `${e.type}:${String(e.detail.fixed)}`));
    expect(types).toEqual(['FIX_PROGRESS:1', 'FIX_PROGRESS:2', 'FIX_PROGRESS:3', 'FIX_PROGRESS:4', 'CLOSED:5']);
    expect(last.group.status).toBe('CLOSED');
    expect(applyOutcome(last.group, 'V4', 'NOT_FIXED', T0).events).toEqual([]); // closed stays closed
    const undo = applyOutcome(g, 'V0', 'NOT_FIXED', T0);
    expect(undo.group.members.V0!.fixed).toBe(false);
    const watching: Group = { ...g, status: 'WATCHING' };
    expect(applyOutcome(watching, 'V4', 'FIXED', T0).events).toEqual([]);
  });
});
