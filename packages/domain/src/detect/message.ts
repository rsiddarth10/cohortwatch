import { z } from 'zod';
import { FAMILIES, METRICS } from './params.js';

/**
 * The `incidents.v1` message (key = family key "family|model|duty|depot"). JSON; consumers (S4 queue, S5
 * campaigns) dedupe by incident_id + action: a replay after a crash re-sends the same id, never a new one.
 */
export const IncidentMessageSchema = z.object({
  incident_id: z.uuid(),
  action: z.enum(['OPEN', 'ESCALATE', 'CLOSE']),
  vin: z.string().length(17),
  fault_family: z.enum(FAMILIES as [string, ...string[]]),
  family_key: z.string(),
  window_bucket: z.number().int(),
  /** Event time of the reading behind this action (ISO 8601 UTC) and its seq. */
  event_ts: z.string(),
  seq: z.number().int().nonnegative(),
  trigger: z.enum(['SIGNAL', 'DTC_RATE']),
  metric: z.enum(METRICS).nullable(),
  severity: z.enum(['WARN', 'HIGH', 'CRITICAL']),
  runaway: z.boolean(),
  hours_to_limit: z.number().nullable(),
  depot_id: z.number().int(),
  model_id: z.number().int(),
  duty_type_id: z.number().int(),
  region_id: z.number().int(),
  firmware: z.string().nullable(),
  baseline_source: z.enum(['VAN', 'COHORT']).nullable(),
  numbers: z.object({
    level: z.number().nullable(),
    baseline_median: z.number().nullable(),
    deviation: z.number().nullable(),
    peer_adj: z.number().nullable(),
    z_level: z.number().nullable(),
    z_slope: z.number().nullable(),
    slope_per_h: z.number().nullable(),
    dtc_count_24h: z.number().int(),
    dtc_usual_per_day: z.number(),
  }),
  clues: z.array(z.object({ type: z.string(), text: z.string(), value: z.number(), unit: z.string() })),
});
export type IncidentMessage = z.infer<typeof IncidentMessageSchema>;
