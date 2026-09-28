import type { SimEvent } from '../simulate.js';

/**
 * OEM-A "Aurex" payload, format v2 (from T0+12h): °C instead of °F and renamed/restructured fields.
 * The normaliser (S2) must detect the shape and convert both versions to the same canonical event.
 */
export interface AurexV2 {
  vehicle: { vin: string };
  time: string;
  seqNo: number;
  event: string;
  position: { lat: number; lon: number };
  speedKmh: number;
  odometerKm: number;
  engine: { coolant: { tempC: number | null }; rpm: number | null };
  battery: { tempC: number | null; socPct: number | null };
  fuel: { pct: number | null };
  electrical: { v12: number };
  ambientC: number;
  codes: string[];
  idleS: number;
  software: string;
  ignition: boolean;
  charging: boolean;
}

export const AUREX_V2 = 'aurex.v2';

const r = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
const n = (x: number | null, dp: number) => (x === null ? null : r(x, dp));

export function toAurexV2(e: SimEvent): AurexV2 {
  return {
    vehicle: { vin: e.vin },
    time: new Date(e.eventTs).toISOString(),
    seqNo: e.seq,
    event: e.evt,
    position: { lat: r(e.lat, 5), lon: r(e.lon, 5) },
    speedKmh: r(e.speedKmh, 1),
    odometerKm: r(e.odoKm, 3),
    engine: { coolant: { tempC: n(e.coolantC, 1) }, rpm: e.rpm },
    battery: { tempC: n(e.battTempC, 1), socPct: n(e.socPct, 1) },
    fuel: { pct: n(e.fuelPct, 1) },
    electrical: { v12: r(e.lvBattV, 2) },
    ambientC: r(e.ambientC, 1),
    codes: e.dtc,
    idleS: e.idleS,
    software: e.firmware,
    ignition: e.ignition,
    charging: e.charging,
  };
}
