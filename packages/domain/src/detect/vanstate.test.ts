import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../time.js';
import { DEFAULT_DETECT, type Metric } from './params.js';
import { PeerContext } from './peer.js';
import {
  emptyVan,
  familyKeyOf,
  incidentIdOf,
  qualifyingValue,
  stepVan,
  toDetectEvent,
  type DetectEvent,
  type IncidentEvent,
  type StepEnv,
  type VanBaseline,
  type VanState,
} from './vanstate.js';

const T0 = Date.UTC(2026, 8, 1);
const P = DEFAULT_DETECT;

/** Deterministic N(0,1) noise (xorshift + Box–Muller). */
function noise(seed: number) {
  let s = seed >>> 0 || 1;
  const u = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const coolantBase = (median = 90): VanBaseline => ({
  metrics: {
    coolant_c: { median, mad: 0.6, slopeMedian: 0, slopeMad: 0.1, source: 'VAN' },
    lv_batt_v: { median: 14.1, mad: 0.08, slopeMedian: 0, slopeMad: 0.01, source: 'VAN' },
  },
  dtcPerDay: {},
});

function reading(
  vin: string,
  seq: number,
  ts: number,
  coolant: number | null,
  x: Partial<DetectEvent> = {},
): DetectEvent {
  return {
    vin,
    seq,
    ts,
    evt: 'PERIODIC',
    ignition: true,
    charging: false,
    speedKmh: 50,
    values: { coolant_c: coolant, batt_temp_c: null, lv_batt_v: 14.1 },
    dtc: [],
    families: [],
    flags: [],
    ...x,
  };
}

function env(
  baseline: VanBaseline | undefined,
  peers = new PeerContext(P.peerWindowH, P.minPeers),
  key: string | null = null,
): StepEnv {
  return {
    params: P,
    baseline,
    peers,
    peerKeys: (m: Metric) => (key ? [{ key: `${key}|${m}`, label: 'in the same region and duty' }] : []),
  };
}

/** Drive one van continuously, a reading every 30 sim-min, coolant = f(hours since T0). */
function drive(f: (h: number) => number, hours: number, e: StepEnv, seed = 1, vin = 'V1') {
  const rnd = noise(seed);
  let st: VanState = emptyVan();
  const incidents: IncidentEvent[] = [];
  for (let i = 0; i <= hours * 2; i++) {
    const h = i / 2;
    const r = stepVan(st, reading(vin, i + 1, T0 + h * HOUR_MS, f(h) + 0.8 * rnd()), e);
    st = r.state;
    incidents.push(...r.incidents);
  }
  return { st, incidents };
}

describe('stepVan: van vs its own normal', () => {
  it('a healthy van with noise raises nothing in 3 days', () => {
    for (const seed of [1, 2, 3, 4, 5]) expect(drive(() => 90, 72, env(coolantBase()), seed).incidents).toEqual([]);
  });

  it('a van without a baseline is tracked but not scored', () => {
    const { st, incidents } = drive((h) => 90 + h, 48, env(undefined));
    expect(incidents).toEqual([]);
    expect(st.m.coolant_c!.slow.S).toBeGreaterThan(0);
  });

  it('a drift of +10 °C opens exactly one incident, with clues in units', () => {
    const { incidents } = drive((h) => 90 + Math.min(Math.max(0, h - 6) * 0.3, 10), 60, env(coolantBase()));
    const opens = incidents.filter((i) => i.action === 'OPEN');
    expect(opens).toHaveLength(1);
    const inc = opens[0]!;
    expect(inc).toMatchObject({ family: 'COOLING', trigger: 'SIGNAL', metric: 'coolant_c', runaway: false });
    expect(inc.ts).toBeLessThan(T0 + 24 * HOUR_MS); // well before the drift peaks
    expect(inc.incidentId).toBe(incidentIdOf('V1', 'COOLING', inc.windowBucket));
    expect(inc.clues[0]!.text).toMatch(/^coolant \d+\.\d °C above its own normal \(90\.0 °C\)$/);
    for (const c of inc.clues) expect(c.text).toMatch(/°C|codes|h/);
  });

  it('single noisy ticks never confirm (k of n)', () => {
    const { incidents } = drive((h) => (Math.round(h * 2) % 10 === 0 ? 96 : 90), 72, env(coolantBase()));
    expect(incidents).toEqual([]);
  });

  it('a naturally hot van is normal against its own baseline, but fires the global rule', () => {
    const e = env(coolantBase(98));
    let st = emptyVan();
    let hits = 0;
    let incidents = 0;
    const rnd = noise(9);
    for (let i = 0; i < 100; i++) {
      const r = stepVan(st, reading('HOT', i + 1, T0 + i * 30 * MINUTE_MS, 98 + 0.8 * rnd()), e);
      st = r.state;
      hits += r.globalHits.length;
      incidents += r.incidents.length;
    }
    expect(incidents).toBe(0);
    expect(hits).toBe(1); // fires once, remembered
  });

  it('closes after the van is back to normal for a while', () => {
    const f = (h: number) => (h < 30 ? 90 + Math.min(Math.max(0, h - 6) * 0.5, 10) : 90);
    const { incidents } = drive(f, 90, env(coolantBase()));
    expect(incidents.map((i) => i.action)).toEqual(['OPEN', 'CLOSE']);
  });

  it('a 12 V voltage drop (bad direction is down) opens LV_ELECTRICAL', () => {
    let st = emptyVan();
    const out: IncidentEvent[] = [];
    for (let i = 0; i < 80; i++) {
      const v = i < 20 ? 14.1 : 13.2;
      const r = stepVan(
        st,
        {
          ...reading('LV', i + 1, T0 + i * 30 * MINUTE_MS, null),
          values: { coolant_c: null, batt_temp_c: null, lv_batt_v: v },
        },
        env(coolantBase()),
      );
      st = r.state;
      out.push(...r.incidents);
    }
    expect(out.find((i) => i.action === 'OPEN')?.family).toBe('LV_ELECTRICAL');
    expect(out[0]!.clues[0]!.text).toContain('V below its own normal');
  });
});

describe('stepVan: guards', () => {
  it('rejects the 25 → 140 → 25 °C glitch without an incident and keeps the trend', () => {
    const e = env(coolantBase());
    let st = drive(() => 90, 24, e).st;
    const before = st.m.coolant_c!.slow.Sy / st.m.coolant_c!.slow.S;
    const g = T0 + 24.2 * HOUR_MS;
    [25, 140, 25].forEach((c, k) => {
      const r = stepVan(st, reading('V1', 100 + k, g + k * 5000, c), e);
      expect(r.incidents).toEqual([]);
      st = r.state;
    });
    expect(st.m.coolant_c!.slow.Sy / st.m.coolant_c!.slow.S).toBeCloseTo(before, 6);
    const next = stepVan(st, reading('V1', 103, T0 + 24.5 * HOUR_MS, 90), e);
    expect(next.state.m.coolant_c!.rejN).toBe(0);
  });

  it('a persistent step (consistent rejected readings over an hour) restarts the trend', () => {
    const e = env(coolantBase());
    let st = drive(() => 90, 24, e).st;
    for (let k = 0; k < 4; k++) st = stepVan(st, reading('V1', 100 + k, T0 + (25 + k * 0.5) * HOUR_MS, 60), e).state;
    expect(st.m.coolant_c!.slow.Sy / st.m.coolant_c!.slow.S).toBeCloseTo(60, 6);
  });

  it('only warmed-up, driving, unflagged periodic readings count for temperature', () => {
    const on = T0;
    const r = (x: Partial<DetectEvent>) => ({ ...reading('V', 1, on + 30 * MINUTE_MS, 90), ...x });
    expect(qualifyingValue(r({}), 'coolant_c', on, P)).toBe(90);
    expect(qualifyingValue(r({ ts: on + 10 * MINUTE_MS }), 'coolant_c', on, P)).toBeNull(); // warming up
    expect(qualifyingValue(r({ evt: 'HEARTBEAT' }), 'coolant_c', on, P)).toBeNull();
    expect(qualifyingValue(r({ speedKmh: 0 }), 'coolant_c', on, P)).toBeNull();
    expect(qualifyingValue(r({ charging: true }), 'coolant_c', on, P)).toBeNull();
    expect(qualifyingValue(r({ ignition: false }), 'coolant_c', on, P)).toBeNull();
    expect(qualifyingValue(r({ flags: ['OUT_OF_RANGE:coolant_c'] }), 'coolant_c', on, P)).toBeNull();
    expect(qualifyingValue(r({ flags: ['CLOCK_SKEW'] }), 'coolant_c', on, P)).toBeNull();
    expect(qualifyingValue(r({ speedKmh: 0 }), 'lv_batt_v', on, P)).toBe(14.1); // running voltage at a stop
    expect(qualifyingValue(r({ ts: on + 10 * MINUTE_MS }), 'coolant_c', -1, P)).toBe(90); // ignition time unknown
  });

  it('tracks ignition on/off for the warm-up rule', () => {
    const e = env(coolantBase());
    let st = stepVan(emptyVan(), reading('V', 1, T0, null, { evt: 'IGNITION_ON' }), e).state;
    expect(st.ignOnTs).toBe(T0);
    st = stepVan(st, reading('V', 2, T0 + 5 * MINUTE_MS, 40), e).state;
    expect(st.m.coolant_c).toBeUndefined();
    st = stepVan(st, reading('V', 3, T0 + HOUR_MS, null, { evt: 'IGNITION_OFF', ignition: false }), e).state;
    expect(st.ignOnTs).toBe(-1);
  });
});

describe('stepVan: replay and determinism', () => {
  it('skips readings at or below the last applied seq; a SEQ_RESET restarts the guard', () => {
    const e = env(coolantBase());
    const { st } = drive((h) => 90 + Math.max(0, h - 6) * 0.3, 40, e);
    for (let seq = 1; seq <= 81; seq++) {
      const r = stepVan(st, reading('V1', seq, T0 + seq * HOUR_MS, 120), e);
      expect(r.skipped).toBe(true);
      expect(r.state).toBe(st);
    }
    const reset = stepVan(st, reading('V1', 1, T0 + 50 * HOUR_MS, 90, { flags: ['SEQ_RESET'] }), e);
    expect(reset.skipped).toBe(false);
    expect(reset.state.lastSeq).toBe(1);
  });

  it('state survives a JSON checkpoint: continuing from it gives the same incidents', () => {
    const f = (h: number) => 90 + Math.min(Math.max(0, h - 6) * 0.3, 10);
    const whole = drive(f, 60, env(coolantBase()));
    const e = env(coolantBase());
    const rnd = noise(1);
    let st: VanState = emptyVan();
    const out: IncidentEvent[] = [];
    for (let i = 0; i <= 120; i++) {
      if (i === 40) st = JSON.parse(JSON.stringify(st)) as VanState; // checkpoint + restore
      const r = stepVan(st, reading('V1', i + 1, T0 + (i / 2) * HOUR_MS, f(i / 2) + 0.8 * rnd()), e);
      st = r.state;
      out.push(...r.incidents);
    }
    expect(out).toEqual(whole.incidents);
  });

  it('incident ids and family keys are deterministic', () => {
    expect(incidentIdOf('V', 'COOLING', 5)).toBe(incidentIdOf('V', 'COOLING', 5));
    expect(incidentIdOf('V', 'COOLING', 5)).not.toBe(incidentIdOf('V', 'COOLING', 6));
    expect(familyKeyOf('COOLING', 6, 1, 42)).toBe('COOLING|6|1|42');
  });
});

describe('stepVan: peer adjustment', () => {
  /** 40 vans in one context; `shift(h, i)` is what happens to van i. */
  function fleet(shift: (h: number, i: number) => number, key: string | null) {
    const peers = new PeerContext(P.peerWindowH, P.minPeers);
    const e = env(coolantBase(), peers, key);
    const states = Array.from({ length: 40 }, () => emptyVan());
    const rnds = states.map((_, i) => noise(100 + i));
    const opened = new Set<number>();
    const critical = new Set<number>();
    for (let s = 0; s <= 144; s++) {
      const h = s / 2;
      states.forEach((st, i) => {
        const r = stepVan(
          st,
          reading(`V${i}`, s + 1, T0 + h * HOUR_MS + i * 1000, 90 + shift(h, i) + 0.8 * rnds[i]!()),
          e,
        );
        states[i] = r.state;
        if (r.incidents.some((x) => x.action === 'OPEN')) opened.add(i);
        if (r.incidents.some((x) => x.runaway)) critical.add(i);
      });
    }
    return Object.assign(opened, { critical });
  }
  const heat = (h: number) => (h < 12 ? 0 : Math.min((h - 12) * 1, 8)); // shared +8 °C (heatwave)

  it('a shared heatwave shift raises nothing with peer adjustment, and many incidents without', () => {
    expect(fleet(heat, 'R3|1').size).toBe(0);
    expect(fleet(heat, null).size).toBeGreaterThan(30);
  });

  it('a steep shared heat step never becomes a runaway; a real runaway among the same peers does', () => {
    const step = (h: number) => (h < 12 ? 0 : Math.min((h - 12) * 2.5, 16)); // shared +16 °C in ~6 h
    const shared = fleet(step, 'R3|1');
    expect(shared.critical.size).toBe(0);
    expect(shared.size).toBe(0);
    const quad = (h: number) => (h < 10 ? 0 : 0.038 * (h - 10) ** 2);
    const one = fleet((h, i) => step(h) + (i === 0 ? quad(h) : 0), 'R3|1');
    expect([...one.critical]).toEqual([0]);
  });

  it('a few sick vans among healthy peers are still found', () => {
    const sick = fleet((h, i) => heat(h) + (i < 4 ? Math.min(Math.max(0, h - 20) * 0.4, 10) : 0), 'R3|1');
    expect([...sick].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe('stepVan: runaway', () => {
  const quad = (h: number) => (h < 10 ? 90 : 90 + 0.038 * (h - 10) ** 2); // 110 °C at ≈ T0+32.9 h

  it('an accelerating van becomes critical with hours to spare, and the flag sticks', () => {
    const { incidents } = drive(quad, 34, env(coolantBase()));
    const crit = incidents.find((i) => i.runaway);
    expect(crit).toBeDefined();
    const limitH = 10 + Math.sqrt(20 / 0.038);
    const warningH = limitH - (crit!.ts - T0) / HOUR_MS;
    expect(warningH).toBeGreaterThan(5);
    expect(crit!.severity).toBe('CRITICAL');
    expect(crit!.clues.map((c) => c.type)).toContain('TIME_TO_LIMIT');
    expect(incidents.filter((i) => i.runaway && i.action !== 'CLOSE')).toHaveLength(1); // no flicker
  });

  it('a slow drift is an incident but never a runaway', () => {
    const { incidents } = drive((h) => 90 + Math.max(0, h - 6) * 0.25, 70, env(coolantBase()));
    expect(incidents.some((i) => i.action === 'OPEN')).toBe(true);
    expect(incidents.some((i) => i.runaway)).toBe(false);
  });
});

describe('stepVan: fault-code rate', () => {
  const code = (seq: number, ts: number, c: string, fam: 'EXHAUST' | 'COOLING') =>
    reading('D', seq, ts, null, { evt: 'DTC', dtc: [c], families: [fam] });

  it('3 codes in 24 h against a usual 0 opens a DTC-rate incident, which closes when the rate falls', () => {
    const e = env(coolantBase());
    let st = emptyVan();
    const out: IncidentEvent[] = [];
    [0, 2, 5].forEach((h, k) => {
      const r = stepVan(st, code(k + 1, T0 + h * HOUR_MS, 'P2463', 'EXHAUST'), e);
      st = r.state;
      out.push(...r.incidents);
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: 'OPEN', family: 'EXHAUST', trigger: 'DTC_RATE', dtcCount24: 3 });
    expect(out[0]!.clues[0]!.text).toBe('EXHAUST codes seen 3× in 24 h, latest P2463 (usual: 0.0 per day)');
    const later = stepVan(st, reading('D', 10, T0 + 30 * HOUR_MS, null), e);
    expect(later.incidents.map((i) => i.action)).toEqual(['CLOSE']);
  });

  it('respects the van own usual rate (4× rule)', () => {
    const e = env({ ...coolantBase(), dtcPerDay: { EXHAUST: 1 } });
    let st = emptyVan();
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const r = stepVan(st, code(k + 1, T0 + k * HOUR_MS, 'P2463', 'EXHAUST'), e);
      st = r.state;
      n += r.incidents.length;
    }
    expect(n).toBe(0); // 3 < 4 × 1
  });

  it('a code-rate incident becomes signal-backed when the signal confirms', () => {
    const e = env(coolantBase());
    let st = emptyVan();
    const out: IncidentEvent[] = [];
    let seq = 1;
    for (const h of [0, 1, 2]) {
      const r = stepVan(st, code(seq++, T0 + h * HOUR_MS, 'P0217', 'COOLING'), e);
      st = r.state;
      out.push(...r.incidents);
    }
    for (let i = 0; i < 40; i++) {
      const r = stepVan(st, reading('D', seq++, T0 + (3 + i / 2) * HOUR_MS, 104), e);
      st = r.state;
      out.push(...r.incidents);
    }
    expect(out.map((i) => `${i.action}:${i.trigger}`).slice(0, 2)).toEqual(['OPEN:DTC_RATE', 'ESCALATE:SIGNAL']);
    expect(out[1]!.clues.map((c) => c.type)).toContain('DTC_RATE');
  });
});

describe('toDetectEvent', () => {
  it('maps the canonical fields', () => {
    const d = toDetectEvent({
      event_id: '00000000-0000-5000-8000-000000000000',
      vin: '1HGBH41JXMN109186',
      seq: 3,
      event_ts: '2026-09-01T00:00:00.000Z',
      evt: 'PERIODIC',
      lat: null,
      lon: null,
      speed_kmh: 40,
      odo_km: null,
      ambient_c: 30,
      coolant_c: 90,
      rpm: null,
      batt_temp_c: null,
      soc_pct: null,
      fuel_pct: null,
      lv_batt_v: 14,
      ignition: true,
      charging: false,
      harsh_brake: null,
      harsh_accel: null,
      idle_s: null,
      dtc: ['P0217'],
      fault_families: ['COOLING'],
      firmware: '4.2.1',
      source_format: 'kestrel.v1',
      quality_flags: [],
    });
    expect(d).toMatchObject({ ts: T0, values: { coolant_c: 90, lv_batt_v: 14 }, families: ['COOLING'] });
  });
});
