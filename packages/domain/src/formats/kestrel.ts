import type { EventType, SimEvent } from '../simulate.js';

/**
 * OEM-B "Kestrel" payload: flat compact JSON, epoch-ms timestamps, °C, SoC as 0-1,
 * DTCs pipe-joined, short event codes, and absent keys (not nulls) for missing signals.
 */
export interface KestrelV1 {
  id: string;
  ts: number;
  sq: number;
  e: string;
  g: [number, number];
  s: number;
  o: number;
  ct?: number;
  bt?: number;
  soc?: number;
  fl?: number;
  v: number;
  a: number;
  dtc: string;
  fw: string;
  ig: 0 | 1;
  ch: 0 | 1;
  hb: number;
  ha: number;
  idl: number;
}

export const KESTREL_V1 = 'kestrel.v1';

export const KESTREL_EVENT_CODES: Record<EventType, string> = {
  IGNITION_ON: 'IG1',
  IGNITION_OFF: 'IG0',
  TRIP_START: 'TS',
  TRIP_END: 'TE',
  PERIODIC: 'P',
  HEARTBEAT: 'HB',
  HARSH_BRAKE: 'XB',
  HARSH_ACCEL: 'XA',
  DTC: 'D',
};

const r = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

export function toKestrel(e: SimEvent): KestrelV1 {
  const out: KestrelV1 = {
    id: e.vin,
    ts: e.eventTs,
    sq: e.seq,
    e: KESTREL_EVENT_CODES[e.evt],
    g: [r(e.lat, 5), r(e.lon, 5)],
    s: r(e.speedKmh, 1),
    o: r(e.odoKm, 3),
    v: r(e.lvBattV, 2),
    a: r(e.ambientC, 1),
    dtc: e.dtc.join('|'),
    fw: e.firmware,
    ig: e.ignition ? 1 : 0,
    ch: e.charging ? 1 : 0,
    hb: e.harshBrake,
    ha: e.harshAccel,
    idl: e.idleS,
  };
  if (e.coolantC !== null) out.ct = r(e.coolantC, 1);
  if (e.battTempC !== null) out.bt = r(e.battTempC, 1);
  if (e.socPct !== null) out.soc = r(e.socPct / 100, 4);
  if (e.fuelPct !== null) out.fl = r(e.fuelPct, 1);
  return out;
}
