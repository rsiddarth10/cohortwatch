/**
 * Static reference data for the synthetic fleet. All names, OEMs, WMIs and places are fictitious.
 */

export type Powertrain = 'EV' | 'DIESEL' | 'HYBRID';
export type ClimateZone = 'HOT_DRY' | 'HOT_HUMID' | 'TEMPERATE' | 'COLD';
export type DutyCode = 'URBAN' | 'LINEHAUL' | 'RENTAL' | 'FIELD' | 'YARD';
export type OemCode = 'AUREX' | 'KESTREL';

export interface Region {
  id: number;
  code: string;
  name: string;
  climate: ClimateZone;
  /** Daily ambient curve: mean + amp * cos(2*pi*(hour - 15)/24), hour in UTC (synthetic local time). */
  ambientMeanC: number;
  ambientAmpC: number;
  /** Synthetic centre used to place depots. */
  lat: number;
  lon: number;
}

export const REGIONS: readonly Region[] = [
  { id: 1, code: 'R1', name: 'Sundar Plateau', climate: 'HOT_DRY', ambientMeanC: 32, ambientAmpC: 7, lat: 14, lon: 74 },
  { id: 2, code: 'R2', name: 'Ochre Basin', climate: 'HOT_DRY', ambientMeanC: 33, ambientAmpC: 7, lat: 18, lon: 74 },
  { id: 3, code: 'R3', name: 'Coral Coast', climate: 'HOT_HUMID', ambientMeanC: 30, ambientAmpC: 4, lat: 22, lon: 74 },
  {
    id: 4,
    code: 'R4',
    name: 'Monsoon Delta',
    climate: 'HOT_HUMID',
    ambientMeanC: 29,
    ambientAmpC: 4,
    lat: 26,
    lon: 74,
  },
  { id: 5, code: 'R5', name: 'Midland Vale', climate: 'TEMPERATE', ambientMeanC: 22, ambientAmpC: 6, lat: 14, lon: 82 },
  { id: 6, code: 'R6', name: 'Riverbend', climate: 'TEMPERATE', ambientMeanC: 20, ambientAmpC: 6, lat: 18, lon: 82 },
  { id: 7, code: 'R7', name: 'Highcrest', climate: 'COLD', ambientMeanC: 8, ambientAmpC: 5, lat: 22, lon: 82 },
  { id: 8, code: 'R8', name: 'Frostmere', climate: 'COLD', ambientMeanC: 4, ambientAmpC: 5, lat: 26, lon: 82 },
];

export interface Oem {
  id: number;
  code: OemCode;
  name: string;
  /** Fictitious world manufacturer identifier used in VINs. */
  wmi: string;
  plant: string;
  payloadFormat: 'aurex.v1' | 'kestrel.v1';
  topic: string;
}

export const OEMS: readonly Oem[] = [
  {
    id: 1,
    code: 'AUREX',
    name: 'Aurex Motors',
    wmi: '7AX',
    plant: 'A',
    payloadFormat: 'aurex.v1',
    topic: 'raw.oem-a.v1',
  },
  {
    id: 2,
    code: 'KESTREL',
    name: 'Kestrel Commercial',
    wmi: '7KS',
    plant: 'K',
    payloadFormat: 'kestrel.v1',
    topic: 'raw.oem-b.v1',
  },
];

export interface VehicleModel {
  id: number;
  oemId: number;
  code: string;
  name: string;
  powertrain: Powertrain;
  /** VIN descriptor section (5 chars, no I/O/Q). */
  vds: string;
  /** EV/hybrid: % state of charge per km. Diesel: % of tank per km. */
  energyPctPerKm: number;
  firmware: readonly string[];
}

export const MODELS: readonly VehicleModel[] = [
  { id: 1, oemId: 1, code: 'AX-EV1', name: 'Aurex Voltan', powertrain: 'EV', vds: 'VE1C4', energyPctPerKm: 0.3, firmware: ['E2-2.0.4', 'E2-2.1.0', 'E2-2.2.1'] },
  { id: 2, oemId: 1, code: 'AX-EV2', name: 'Aurex Voltan Compact', powertrain: 'EV', vds: 'VE2C3', energyPctPerKm: 0.38, firmware: ['E3-1.4.0', 'E3-1.5.2', 'E3-1.6.0'] },
  { id: 3, oemId: 1, code: 'AX-D1', name: 'Aurex Durant', powertrain: 'DIESEL', vds: 'DR1L6', energyPctPerKm: 0.12, firmware: ['D5-3.6.2', 'D5-3.7.0', 'D5-3.8.0'] },
  { id: 4, oemId: 1, code: 'AX-H1', name: 'Aurex Hybra', powertrain: 'HYBRID', vds: 'HY1M5', energyPctPerKm: 0.2, firmware: ['H1-5.0.1', 'H1-5.1.0', 'H1-5.2.3'] },
  { id: 5, oemId: 2, code: 'KS-EV1', name: 'Kestrel eCargo', powertrain: 'EV', vds: 'EC1V2', energyPctPerKm: 0.32, firmware: ['7.2.0', '7.3.1', '7.4.0'] },
  { id: 6, oemId: 2, code: 'KS-D1', name: 'Kestrel Haulmark', powertrain: 'DIESEL', vds: 'HM1D8', energyPctPerKm: 0.14, firmware: ['4.0.3', '4.1.0', '4.1.2'] },
  { id: 7, oemId: 2, code: 'KS-D2', name: 'Kestrel Titan', powertrain: 'DIESEL', vds: 'TT2D9', energyPctPerKm: 0.1, firmware: ['6.3.0', '6.4.1', '6.5.0'] },
  { id: 8, oemId: 2, code: 'KS-H1', name: 'Kestrel Flex', powertrain: 'HYBRID', vds: 'FX1H7', energyPctPerKm: 0.2, firmware: ['2.8.0', '2.9.1', '3.0.0'] },
]; // prettier-ignore

/** The OEM-B diesel model reserved for the S1/S1b plants (brief §5.1). */
export const S1_MODEL_CODE = 'KS-D1';
/** A different OEM-B diesel model also present at depot S1 (same-depot decoys in 1b). */
export const S1_OTHER_MODEL_CODE = 'KS-D2';

export interface DutyProfile {
  id: number;
  code: DutyCode;
  name: string;
  /** Share of the fleet (brief §5.1). */
  share: number;
  /** Shift start, hours after midnight (UTC as synthetic local time). */
  shiftStartH: number;
  /** Ignition-on hours per day; null = variable (rental). */
  activeH: number | null;
  trips: number;
  /** Mean moving-average speed including stops, km/h, and its per-interval sd. */
  speedKmh: number;
  speedSdKmh: number;
  maxSpeedKmh: number;
  idleFraction: number;
  /** Engine/battery load factor (feeds the coolant and battery-temperature load terms). */
  load: number;
  harshPerHour: number;
  radiusKm: number;
}

export const DUTIES: readonly DutyProfile[] = [
  { id: 1, code: 'URBAN', name: 'Urban delivery', share: 0.45, shiftStartH: 7, activeH: 10, trips: 3, speedKmh: 16, speedSdKmh: 6, maxSpeedKmh: 70, idleFraction: 0.25, load: 1.0, harshPerHour: 0.3, radiusKm: 15 },
  { id: 2, code: 'LINEHAUL', name: 'Linehaul', share: 0.2, shiftStartH: 5, activeH: 18, trips: 3, speedKmh: 66, speedSdKmh: 10, maxSpeedKmh: 110, idleFraction: 0.05, load: 1.4, harshPerHour: 0.05, radiusKm: 200 },
  { id: 3, code: 'RENTAL', name: 'Rental', share: 0.15, shiftStartH: 8, activeH: null, trips: 3, speedKmh: 35, speedSdKmh: 12, maxSpeedKmh: 110, idleFraction: 0.1, load: 0.8, harshPerHour: 0.4, radiusKm: 40 },
  { id: 4, code: 'FIELD', name: 'Field service', share: 0.1, shiftStartH: 8, activeH: 9, trips: 5, speedKmh: 20, speedSdKmh: 8, maxSpeedKmh: 90, idleFraction: 0.15, load: 0.9, harshPerHour: 0.2, radiusKm: 40 },
  { id: 5, code: 'YARD', name: 'Yard shuttle', share: 0.1, shiftStartH: 6, activeH: 12, trips: 2, speedKmh: 8, speedSdKmh: 4, maxSpeedKmh: 30, idleFraction: 0.4, load: 0.6, harshPerHour: 0.1, radiusKm: 2 },
]; // prettier-ignore

export type FaultFamily = 'COOLING' | 'HV_BATTERY_THERMAL' | 'LV_ELECTRICAL' | 'EXHAUST' | 'BRAKE_SENSOR';

export const FAULT_CODES: Readonly<Record<FaultFamily, readonly string[]>> = {
  COOLING: ['P0217', 'P0118', 'P0480'],
  HV_BATTERY_THERMAL: ['P0A7E', 'P0A80'],
  LV_ELECTRICAL: ['P0562', 'P0620'],
  EXHAUST: ['P2463', 'P0401'],
  BRAKE_SENSOR: ['C0035'],
};

/** Families that can physically occur on a powertrain (background noise only picks from these). */
export function familiesFor(pt: Powertrain): FaultFamily[] {
  const common: FaultFamily[] = ['LV_ELECTRICAL', 'BRAKE_SENSOR'];
  if (pt === 'EV') return [...common, 'HV_BATTERY_THERMAL'];
  if (pt === 'DIESEL') return [...common, 'COOLING', 'EXHAUST'];
  return [...common, 'COOLING', 'HV_BATTERY_THERMAL'];
}

export function modelById(id: number): VehicleModel {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model ${id}`);
  return m;
}

export function dutyById(id: number): DutyProfile {
  const d = DUTIES.find((x) => x.id === id);
  if (!d) throw new Error(`unknown duty ${id}`);
  return d;
}

export function regionById(id: number): Region {
  const r = REGIONS.find((x) => x.id === id);
  if (!r) throw new Error(`unknown region ${id}`);
  return r;
}

export function oemById(id: number): Oem {
  const o = OEMS.find((x) => x.id === id);
  if (!o) throw new Error(`unknown OEM ${id}`);
  return o;
}
