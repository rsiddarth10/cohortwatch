/**
 * VIN helpers (ISO 3779 / North-American check digit at position 9).
 * 17 characters, no I/O/Q. All O(17).
 */

export const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;

const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
}; // prettier-ignore

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function charValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  const v = TRANSLITERATION[c];
  if (v === undefined) throw new Error(`invalid VIN character: ${c}`);
  return v;
}

/** Check digit for a 17-char VIN (position 9 is ignored in the sum, weight 0). */
export function computeCheckDigit(vin: string): string {
  if (vin.length !== 17) throw new Error('VIN must be 17 characters');
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += charValue(vin[i]!) * WEIGHTS[i]!;
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

export function isValidVin(vin: string): boolean {
  if (!VIN_REGEX.test(vin)) return false;
  return computeCheckDigit(vin) === vin[8];
}

// Model-year codes (position 10) for 2020-2030. I, O, Q, U, Z and 0 are never used.
const YEAR_CODES: Record<number, string> = {
  2020: 'L', 2021: 'M', 2022: 'N', 2023: 'P', 2024: 'R', 2025: 'S', 2026: 'T', 2027: 'V', 2028: 'W', 2029: 'X', 2030: 'Y',
}; // prettier-ignore

export function yearCode(year: number): string {
  const c = YEAR_CODES[year];
  if (!c) throw new Error(`unsupported model year ${year}`);
  return c;
}

/**
 * Build a valid VIN: WMI(3) + VDS(5) + check(1) + year(1) + plant(1) + serial(6).
 */
export function buildVin(wmi: string, vds: string, modelYear: number, plant: string, serial: number): string {
  if (wmi.length !== 3 || vds.length !== 5 || plant.length !== 1) throw new Error('bad VIN parts');
  if (serial < 0 || serial > 999_999) throw new Error('serial out of range');
  const draft = `${wmi}${vds}0${yearCode(modelYear)}${plant}${String(serial).padStart(6, '0')}`;
  if (!VIN_REGEX.test(draft)) throw new Error(`VIN parts contain forbidden characters: ${draft}`);
  return draft.slice(0, 8) + computeCheckDigit(draft) + draft.slice(9);
}
