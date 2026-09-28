import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../simulate.js';
import { AUREX_V1, KESTREL_V1, encodeForOem, toAurexV1, toKestrel } from './index.js';

const base: SimEvent = {
  vin: '7KSHM1D84RK100001',
  oemId: 2,
  seq: 88,
  eventTs: Date.parse('2026-09-28T10:15:02.120Z'),
  evt: 'PERIODIC',
  lat: 14.123456,
  lon: 74.654321,
  speedKmh: 42.26,
  odoKm: 18234.7123,
  ambientC: 31.24,
  coolantC: 91.36,
  rpm: 1830,
  battTempC: null,
  socPct: null,
  fuelPct: 63.21,
  lvBattV: 14.137,
  ignition: true,
  charging: false,
  harshBrake: 0,
  harshAccel: 0,
  idleS: 120,
  dtc: ['P0217', 'C0035'],
  firmware: '4.1.2',
};

describe('OEM-A Aurex v1', () => {
  it('is nested, in °F, with ISO time and explicit nulls', () => {
    const a = toAurexV1({ ...base, oemId: 1 });
    expect(a.vehicle.vin).toBe(base.vin);
    expect(a.t).toBe('2026-09-28T10:15:02.120Z');
    expect(a.n).toBe(88);
    expect(a.evt).toBe('PERIODIC');
    expect(a.pos).toEqual({ la: 14.12346, lo: 74.65432 });
    expect(a.eng.coolantTempF).toBeCloseTo((91.36 * 9) / 5 + 32, 1);
    expect(a.eng.rpm).toBe(1830);
    expect(a.batt).toEqual({ tempF: null, soc: null });
    expect(a.fuel.pct).toBe(63.2);
    expect(a.elec.v12).toBe(14.14);
    expect(a.amb).toBeCloseTo((31.24 * 9) / 5 + 32, 1);
    expect(a.codes).toEqual(['P0217', 'C0035']);
    expect(a.sw).toBe('4.1.2');
    expect(a.ign).toBe(true);
    expect(a.chg).toBe(false);
    expect(Object.keys(a).sort()).toEqual(
      [
        'amb',
        'batt',
        'chg',
        'codes',
        'elec',
        'eng',
        'evt',
        'fuel',
        'idle',
        'ign',
        'n',
        'odo',
        'pos',
        'spd',
        'sw',
        't',
        'vehicle',
      ].sort(),
    );
  });

  it('converts EV battery temperature and keeps SoC as a percentage', () => {
    const a = toAurexV1({ ...base, oemId: 1, coolantC: null, rpm: null, battTempC: 30, socPct: 64.44, fuelPct: null });
    expect(a.batt.tempF).toBe(86);
    expect(a.batt.soc).toBe(64.4);
    expect(a.eng.coolantTempF).toBeNull();
    expect(a.fuel.pct).toBeNull();
  });
});

describe('OEM-B Kestrel', () => {
  it('is flat and compact: epoch ms, [lat,lon], °C, pipe-joined DTCs, short codes', () => {
    const k = toKestrel(base);
    expect(k.id).toBe(base.vin);
    expect(k.ts).toBe(base.eventTs);
    expect(k.sq).toBe(88);
    expect(k.e).toBe('P');
    expect(k.g).toEqual([14.12346, 74.65432]);
    expect(k.s).toBe(42.3);
    expect(k.o).toBe(18234.712);
    expect(k.ct).toBe(91.4);
    expect(k.dtc).toBe('P0217|C0035');
    expect(k.fw).toBe('4.1.2');
    expect(k.ig).toBe(1);
    expect(k.ch).toBe(0);
    expect(k.idl).toBe(120);
    expect(k.fl).toBe(63.2);
    // missing signals are absent keys, not nulls
    expect('bt' in k).toBe(false);
    expect('soc' in k).toBe(false);
  });

  it('encodes SoC as a 0-1 fraction and harsh events as counts', () => {
    const k = toKestrel({
      ...base,
      evt: 'HARSH_BRAKE',
      harshBrake: 1,
      socPct: 41.2,
      battTempC: 31.5,
      coolantC: null,
      fuelPct: null,
      dtc: [],
    });
    expect(k.soc).toBe(0.412);
    expect(k.bt).toBe(31.5);
    expect(k.e).toBe('XB');
    expect(k.hb).toBe(1);
    expect(k.dtc).toBe('');
    expect('ct' in k).toBe(false);
  });
});

describe('encodeForOem', () => {
  it('routes each OEM to its raw topic and format, keyed by VIN', () => {
    const b = encodeForOem(base);
    expect(b).toMatchObject({ topic: 'raw.oem-b.v1', key: base.vin, format: KESTREL_V1 });
    expect(JSON.parse(b.value).sq).toBe(88);
    const a = encodeForOem({ ...base, oemId: 1 });
    expect(a).toMatchObject({ topic: 'raw.oem-a.v1', key: base.vin, format: AUREX_V1 });
    expect(JSON.parse(a.value).vehicle.vin).toBe(base.vin);
  });
});
