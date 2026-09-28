import { DEFAULT_PARAMS, generateRegistry } from '@cw/domain';
import { describe, expect, it } from 'vitest';
import { csvRow, range, registryCopies } from './seed.js';

describe('COPY encoding', () => {
  it('encodes NULL as an empty field and quotes only when needed', () => {
    expect(csvRow([1, 'plain', null, true, false])).toBe('1,plain,,t,f\n');
    expect(csvRow(['a,b', 'say "hi"', ''])).toBe('"a,b","say ""hi""",""\n');
  });

  it('writes half-open tstzrange literals, open-ended when there is no end', () => {
    const t = Date.parse('2026-01-01T00:00:00Z');
    expect(range(t, null)).toBe('[2026-01-01T00:00:00.000Z,)');
    expect(range(t, t + 1000)).toBe('[2026-01-01T00:00:00.000Z,2026-01-01T00:00:01.000Z)');
  });

  it('covers every registry table in FK order with one row per vehicle where expected', () => {
    const reg = generateRegistry('seed-test', 600, Date.parse('2026-09-28T04:00:00Z'), DEFAULT_PARAMS);
    const copies = registryCopies(reg);
    const tables = copies.map((c) => c.table);
    expect(tables.indexOf('core.tenant')).toBeLessThan(tables.indexOf('core.fleet'));
    expect(tables.indexOf('core.fleet')).toBeLessThan(tables.indexOf('core.depot'));
    expect(tables.indexOf('core.vehicle')).toBeLessThan(tables.indexOf('core.vehicle_depot_assignment'));
    expect(tables.indexOf('core.driver')).toBeLessThan(tables.indexOf('core.driver_assignment'));
    expect(tables.at(-1)).toBe('sim.vehicle_profile');
    const count = (t: string) => [...copies.find((c) => c.table === t)!.rows()].length;
    expect(count('core.vehicle')).toBe(600);
    expect(count('sim.vehicle_profile')).toBe(600);
    expect(count('core.vehicle_depot_assignment')).toBe(600);
    expect(count('core.vehicle_firmware_history')).toBeGreaterThanOrEqual(600);
    for (const c of copies) {
      for (const row of c.rows()) expect(row).toHaveLength(c.columns.length);
    }
  });
});
