import { describe, expect, it } from 'vitest';
import { FAULT_CODES } from '../catalog.js';
import { buildVin } from '../vin.js';
import { eventId, type CanonicalEvent } from './event.js';
import { DEFAULT_SKEW_MS, DTC_REGEX, IngestClock, checkJumps, faultFamilyOf, validateEvent } from './validate.js';

const VIN = buildVin('7KS', 'HM1D8', 2024, 'K', 100001);
const base: CanonicalEvent = {
  event_id: eventId(VIN, 10),
  vin: VIN,
  seq: 10,
  event_ts: '2026-09-28T10:00:00.000Z',
  evt: 'PERIODIC',
  lat: 14.1,
  lon: 74.6,
  speed_kmh: 40,
  odo_km: 1000,
  ambient_c: 30,
  coolant_c: 90,
  rpm: 1800,
  batt_temp_c: 30,
  soc_pct: 60,
  fuel_pct: 50,
  lv_batt_v: 14.1,
  ignition: true,
  charging: false,
  harsh_brake: 0,
  harsh_accel: 0,
  idle_s: 0,
  dtc: [],
  fault_families: [],
  firmware: '4.2.1',
  source_format: 'kestrel.v1',
  quality_flags: [],
};
const valid = (e: CanonicalEvent) => {
  const r = validateEvent(e);
  if (!r.ok) throw new Error(r.detail);
  return r.event;
};

describe('VIN', () => {
  it('rejects a wrong check digit or a forbidden letter (the event cannot be attributed)', () => {
    const wrongCheck = VIN.slice(0, 8) + (VIN[8] === '0' ? '1' : '0') + VIN.slice(9);
    const forbidden = VIN.slice(0, 5) + 'O' + VIN.slice(6);
    for (const vin of [wrongCheck, forbidden, 'SHORT']) {
      const r = validateEvent({ ...base, vin });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_VIN');
    }
    expect(validateEvent(base).ok).toBe(true);
  });
});

describe('physical ranges', () => {
  it('nulls an out-of-range field, flags it, and keeps the event', () => {
    const v = valid({ ...base, soc_pct: 140, speed_kmh: -5 });
    expect(v.soc_pct).toBeNull();
    expect(v.speed_kmh).toBeNull();
    expect(v.quality_flags).toEqual(expect.arrayContaining(['OUT_OF_RANGE:soc_pct', 'OUT_OF_RANGE:speed_kmh']));
    expect(v.coolant_c).toBe(90); // other fields untouched
  });

  it('leaves in-range values and nulls alone, and never mutates the input', () => {
    const input = { ...base, rpm: null };
    const v = valid(input);
    expect(v).toEqual(input);
    const bad = { ...base, coolant_c: 400 };
    valid(bad);
    expect(bad.coolant_c).toBe(400);
    expect(bad.quality_flags).toEqual([]);
  });
});

describe('DTC → fault family', () => {
  it('every catalogue code is valid and maps to its family', () => {
    for (const [fam, codes] of Object.entries(FAULT_CODES)) {
      for (const c of codes) {
        expect(DTC_REGEX.test(c)).toBe(true);
        expect(faultFamilyOf(c)).toBe(fam);
      }
    }
  });

  it('a valid but unknown code → OTHER; invalid codes are dropped and flagged', () => {
    const v = valid({ ...base, dtc: ['P0217', 'U0100', 'P02-17', 'p0217', 'P0A7EE', 'Q0000', '0217', 'XX123'] });
    expect(v.dtc).toEqual(['P0217', 'U0100']);
    expect(v.fault_families).toEqual(['COOLING', 'OTHER']);
    expect(v.quality_flags.filter((f) => f === 'INVALID_DTC')).toHaveLength(6);
  });
});

describe('impossible jumps', () => {
  const prev = { seq: 10, odoKm: 1000, socPct: 60, driving: true };

  it('flags the odometer going backwards, and does not let the glitch become the new normal', () => {
    const r = checkJumps(prev, { ...base, seq: 11, odo_km: 900 });
    expect(r.event.odo_km).toBeNull();
    expect(r.event.quality_flags).toContain('ODOMETER_BACKWARDS');
    expect(r.next!.odoKm).toBe(1000);
    // the next good reading is not flagged
    const r2 = checkJumps(r.next, { ...base, seq: 12, odo_km: 1001 });
    expect(r2.event.quality_flags).toEqual([]);
    expect(r2.next!.odoKm).toBe(1001);
  });

  it('flags an EV gaining charge between two driving readings', () => {
    const ev = { ...base, seq: 11, coolant_c: null, soc_pct: 75 }; // no engine: an EV
    expect(checkJumps(prev, ev).event.quality_flags).toContain('SOC_RISING_WHILE_DRIVING');
    expect(checkJumps(prev, ev).event.soc_pct).toBeNull();
    expect(checkJumps(prev, { ...ev, soc_pct: 60.3 }).event.quality_flags).toEqual([]); // rounding
  });

  it('does not flag charging, parking, a hybrid, or the first drive after charging at the depot', () => {
    const ev = { ...base, seq: 11, coolant_c: null, soc_pct: 75 };
    expect(checkJumps(prev, { ...ev, charging: true }).event.quality_flags).toEqual([]);
    expect(checkJumps(prev, { ...ev, speed_kmh: 0 }).event.quality_flags).toEqual([]);
    expect(checkJumps(prev, { ...ev, coolant_c: 88 }).event.quality_flags).toEqual([]); // hybrid: engine recharges
    const parked = { ...prev, driving: false }; // last reading was a heartbeat before an overnight charge
    expect(checkJumps(parked, ev).event.quality_flags).toEqual([]);
    expect(checkJumps(parked, ev).next!.driving).toBe(true);
  });

  it('does not compare a late (older) reading, and starts clean without history', () => {
    const late = checkJumps(prev, { ...base, seq: 8, odo_km: 950 });
    expect(late.event.quality_flags).toEqual([]);
    expect(late.next).toBe(prev);
    const first = checkJumps(undefined, { ...base, odo_km: 5 });
    expect(first.event.quality_flags).toEqual([]);
    expect(first.next).toEqual({ seq: 10, odoKm: 5, socPct: 60, driving: true });
  });

  it('keeps the previous value when a signal is absent', () => {
    const r = checkJumps(prev, { ...base, seq: 11, soc_pct: null, odo_km: null });
    expect(r.next).toEqual({ seq: 11, odoKm: 1000, socPct: 60, driving: true });
  });
});

describe('clock skew (event time vs ingest time mapped into event time, never mixed)', () => {
  it('learns the offset, then flags only readings far ahead of what their ingest time implies', () => {
    const speed = 360;
    const c = new IngestClock(speed, 128, 16);
    const T = 1_790_000_000_000;
    const W = 1_700_000_000_000; // wall clock of the first ingest
    expect(c.isAhead(T + 1e9, W)).toBe(false); // nothing learned yet: never flags
    for (let i = 0; i < 128; i++) {
      const wall = W + i * 50;
      // a sparse stream: consecutive readings are 18 sim-seconds apart; 5% are 1-60 sim-min late
      const late = i % 20 === 0 ? (1 + (i % 60)) * 60_000 : 0;
      c.push(T + i * 50 * speed - late, wall);
    }
    const wall = W + 128 * 50;
    const now = T + 128 * 50 * speed;
    expect(c.expected(wall)).toBeCloseTo(now, -3);
    expect(c.isAhead(now, wall)).toBe(false);
    expect(c.isAhead(now + 90_000, wall)).toBe(false); // the injected ±90 s skew is tolerated
    expect(c.isAhead(now + DEFAULT_SKEW_MS + 5_000, wall)).toBe(true);
    expect(c.isAhead(now - 3_600_000, wall)).toBe(false); // late is not skew
  });

  it('works at 1× (production) and is not moved by a few skewed vans', () => {
    const c = new IngestClock(1, 64, 8);
    for (let i = 0; i < 64; i++) c.push(1000 + i * 1000 + (i % 25 === 0 ? 10 * 60_000 : 0), 1000 + i * 1000);
    expect(c.expected(100_000)).toBe(100_000);
    expect(c.speed).toBe(1);
  });
});
