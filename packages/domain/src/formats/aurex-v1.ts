import type { SimEvent } from '../simulate.js';

/**
 * OEM-A "Aurex" payload, format v1: nested JSON, temperatures in °F, ISO timestamps,
 * explicit nulls for signals the vehicle does not have. (v2 with °C arrives in step 1b.)
 */
export interface AurexV1 {
  vehicle: { vin: string };
  t: string;
  n: number;
  evt: string;
  pos: { la: number; lo: number };
  spd: number;
  odo: number;
  eng: { coolantTempF: number | null; rpm: number | null };
  batt: { tempF: number | null; soc: number | null };
  fuel: { pct: number | null };
  elec: { v12: number };
  amb: number;
  codes: string[];
  idle: number;
  sw: string;
  ign: boolean;
  chg: boolean;
}

export const AUREX_V1 = 'aurex.v1';

const r = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;
const toF = (c: number) => (c * 9) / 5 + 32;

export function toAurexV1(e: SimEvent): AurexV1 {
  return {
    vehicle: { vin: e.vin },
    t: new Date(e.eventTs).toISOString(),
    n: e.seq,
    evt: e.evt,
    pos: { la: r(e.lat, 5), lo: r(e.lon, 5) },
    spd: r(e.speedKmh, 1),
    odo: r(e.odoKm, 3),
    eng: {
      coolantTempF: e.coolantC === null ? null : r(toF(e.coolantC), 1),
      rpm: e.rpm,
    },
    batt: {
      tempF: e.battTempC === null ? null : r(toF(e.battTempC), 1),
      soc: e.socPct === null ? null : r(e.socPct, 1),
    },
    fuel: { pct: e.fuelPct === null ? null : r(e.fuelPct, 1) },
    elec: { v12: r(e.lvBattV, 2) },
    amb: r(toF(e.ambientC), 1),
    codes: e.dtc,
    idle: e.idleS,
    sw: e.firmware,
    ign: e.ignition,
    chg: e.charging,
  };
}
