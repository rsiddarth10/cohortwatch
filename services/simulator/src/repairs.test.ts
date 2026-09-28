import { describe, expect, it } from 'vitest';
import { parseArgs } from './main.js';
import { REPAIRS_TOPIC, parseRepair, repairMessage } from './repairs.js';

const VIN = '1HGCM82633A004352';

describe('repair message (workshop.repairs.v1)', () => {
  it('has exactly {vin, repaired_at} with an ISO sim time', () => {
    const t = Date.parse('2026-09-29T10:00:00Z');
    const m = repairMessage(VIN, t);
    expect(Object.keys(m).sort()).toEqual(['repaired_at', 'vin']);
    expect(m).toEqual({ vin: VIN, repaired_at: '2026-09-29T10:00:00.000Z' });
    expect(REPAIRS_TOPIC).toBe('workshop.repairs.v1');
  });

  it('round-trips and rejects anything malformed', () => {
    const t = Date.parse('2026-09-29T10:00:00Z');
    expect(parseRepair(JSON.stringify(repairMessage(VIN, t)))).toEqual({ vin: VIN, repairedAtMs: t });
    expect(parseRepair(null)).toBeNull();
    expect(parseRepair('{not json')).toBeNull();
    expect(parseRepair(JSON.stringify({ vin: 'BADVIN', repaired_at: '2026-09-29T10:00:00Z' }))).toBeNull();
    expect(parseRepair(JSON.stringify({ vin: VIN, repaired_at: 'yesterday' }))).toBeNull();
    expect(parseRepair(JSON.stringify({ vin: VIN }))).toBeNull();
    expect(() => repairMessage('BADVIN', t)).toThrow(/VIN/);
    expect(() => repairMessage(VIN, Number.NaN)).toThrow();
  });
});

describe('simulator CLI arguments', () => {
  it('parses modes and flags', () => {
    expect(parseArgs([], 'demo')).toMatchObject({ mode: 'demo', reset: false, burst: false });
    expect(parseArgs(['bench', '--burst'], 'demo')).toMatchObject({ mode: 'bench', burst: true });
    expect(parseArgs(['bench', '--duration', '30'], 'demo').durationS).toBe(30);
    expect(parseArgs(['history', '--days', '30', '--interval-min', '2'], 'demo')).toMatchObject({
      mode: 'history',
      days: 30,
      intervalMin: 2,
    });
    expect(parseArgs(['--reset'], 'live')).toMatchObject({ mode: 'live', reset: true });
    expect(parseArgs(['reset'], 'demo').mode).toBe('reset');
  });
});

describe('sim:watch raw reader', () => {
  it('reads coolant from all three raw formats in °C', async () => {
    const { readRaw } = await import('./cli/watch.js');
    expect(readRaw(JSON.stringify({ id: VIN, ts: 1000, e: 'P', ct: 91.2 }))).toEqual({
      vin: VIN,
      ts: 1000,
      coolantC: 91.2,
      driving: true,
    });
    const v1 = readRaw(
      JSON.stringify({ vehicle: { vin: VIN }, t: '2026-09-28T04:00:00Z', evt: 'PERIODIC', eng: { coolantTempF: 194 } }),
    );
    expect(v1!.coolantC).toBeCloseTo(90, 5);
    const v2 = readRaw(
      JSON.stringify({
        vehicle: { vin: VIN },
        time: '2026-09-28T04:00:00Z',
        seqNo: 1,
        event: 'HEARTBEAT',
        engine: { coolant: { tempC: null } },
      }),
    );
    expect(v2).toMatchObject({ coolantC: null, driving: false });
    expect(readRaw('{broken')).toBeNull();
  });
});
