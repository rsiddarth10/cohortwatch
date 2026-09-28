import { isValidVin } from '@cw/domain';

export const REPAIRS_TOPIC = 'workshop.repairs.v1';

/** The message a workshop (CLI now, the UI in S6/S8) publishes when a van is repaired. */
export interface RepairMessage {
  vin: string;
  /** Simulated (event) time of the repair, ISO 8601. */
  repaired_at: string;
}

export function repairMessage(vin: string, simMs: number): RepairMessage {
  if (!isValidVin(vin)) throw new Error(`invalid VIN: ${vin}`);
  if (!Number.isFinite(simMs)) throw new Error('repaired_at must be a valid time');
  return { vin, repaired_at: new Date(simMs).toISOString() };
}

/** Parse and validate a repair message; returns null for anything malformed (never throws). */
export function parseRepair(value: string | null | undefined): { vin: string; repairedAtMs: number } | null {
  if (!value) return null;
  try {
    const m = JSON.parse(value) as Partial<RepairMessage>;
    if (typeof m.vin !== 'string' || !isValidVin(m.vin) || typeof m.repaired_at !== 'string') return null;
    const t = Date.parse(m.repaired_at);
    return Number.isFinite(t) ? { vin: m.vin, repairedAtMs: t } : null;
  } catch {
    return null;
  }
}
