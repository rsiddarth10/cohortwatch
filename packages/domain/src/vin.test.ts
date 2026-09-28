import { describe, expect, it } from 'vitest';
import { VIN_REGEX, buildVin, computeCheckDigit, isValidVin, yearCode } from './vin.js';

describe('VIN', () => {
  it('accepts a known-valid public example VIN', () => {
    expect(isValidVin('1HGCM82633A004352')).toBe(true);
    expect(computeCheckDigit('1HGCM82633A004352')).toBe('3');
  });

  it('rejects a wrong check digit', () => {
    expect(isValidVin('1HGCM82643A004352')).toBe(false);
  });

  it('rejects I, O and Q and wrong lengths', () => {
    expect(isValidVin('1HGCM82633A00435I')).toBe(false);
    expect(isValidVin('1HGCM82633A00435O')).toBe(false);
    expect(isValidVin('1HGCM82633A00435Q')).toBe(false);
    expect(isValidVin('1HGCM82633A00435')).toBe(false);
    expect(isValidVin('1hgcm82633a004352')).toBe(false);
  });

  it('uses X when the remainder is 10', () => {
    // search a serial whose check digit is X, then confirm it validates
    let found = '';
    for (let s = 0; s < 200 && !found; s++) {
      const v = buildVin('7AX', 'VE1C4', 2024, 'A', s);
      if (v[8] === 'X') found = v;
    }
    expect(found).not.toBe('');
    expect(isValidVin(found)).toBe(true);
  });

  it('builds valid VINs with the model-year code at position 10', () => {
    const v = buildVin('7KS', 'HM1D8', 2025, 'K', 123456);
    expect(v).toHaveLength(17);
    expect(VIN_REGEX.test(v)).toBe(true);
    expect(isValidVin(v)).toBe(true);
    expect(v[9]).toBe(yearCode(2025));
    expect(v.endsWith('123456')).toBe(true);
  });

  it('refuses bad parts', () => {
    expect(() => buildVin('7A', 'VE1C4', 2024, 'A', 1)).toThrow();
    expect(() => buildVin('7AX', 'VE1C4', 2024, 'A', 1_000_000)).toThrow();
    expect(() => buildVin('7AX', 'VEOC4', 2024, 'A', 1)).toThrow(/forbidden/);
    expect(() => yearCode(1999)).toThrow();
    expect(() => computeCheckDigit('SHORT')).toThrow();
    expect(() => computeCheckDigit('1HGCM82633A00435*')).toThrow();
  });
});
