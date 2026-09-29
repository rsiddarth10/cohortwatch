import { z } from 'zod';
import type { FaultFamily } from '../catalog.js';

/**
 * Detection parameters (S3). Defaults follow the reference plan §9.3–9.5; every value is config
 * (the state processor reads overrides from env). Units: hours of EVENT time, °C, V.
 */

export const METRICS = ['coolant_c', 'batt_temp_c', 'lv_batt_v'] as const;
export type Metric = (typeof METRICS)[number];

/** Fault families including OTHER (a valid DTC with no known family). */
export type Family = FaultFamily | 'OTHER';
export const FAMILIES: readonly Family[] = [
  'COOLING',
  'HV_BATTERY_THERMAL',
  'LV_ELECTRICAL',
  'EXHAUST',
  'BRAKE_SENSOR',
  'OTHER',
];

export const METRIC_FAMILY: Readonly<Record<Metric, FaultFamily>> = {
  coolant_c: 'COOLING',
  batt_temp_c: 'HV_BATTERY_THERMAL',
  lv_batt_v: 'LV_ELECTRICAL',
};

const MetricParamsSchema = z.object({
  /** Word used in clues ("coolant"). */
  label: z.string(),
  unit: z.string(),
  /** +1: only a rise is bad; −1: only a drop is bad. */
  direction: z.union([z.literal(1), z.literal(-1)]),
  /** MAD floors so a very steady van cannot turn a tiny wobble into a large z (unit, unit/h). */
  minMad: z.number().positive(),
  minSlopeMad: z.number().positive(),
  /** Impossible-jump guard: physical maximum rate against the last accepted reading (unit per minute). */
  maxRatePerMin: z.number().positive(),
  /** Impossible-jump guard: maximum distance from the van's fast trend mean (unit). */
  spikeMax: z.number().positive(),
  /** Hard limit for time-to-limit / runaway; null = no runaway rule for this metric. */
  hardLimit: z.number().nullable(),
  /** Minimum fast-trend rate (unit/h, in the bad direction) before time-to-limit is computed at all. */
  runawayMinRatePerH: z.number().positive(),
  /** Simple global-threshold baseline (the rule the evaluation compares against); null = none. */
  globalThreshold: z.number().nullable(),
});
export type MetricParams = z.infer<typeof MetricParamsSchema>;

export const DetectParamsSchema = z.object({
  /** EW regression time constant for level and slope (sim-hours). */
  tauH: z.number().positive().default(12),
  /** Faster EW trend used only for time-to-limit (an accelerating runaway outruns the 12-h trend). */
  fastTauH: z.number().positive().default(3),
  /** Minimum effective weight (Σw) of the slow trend before a van is scored at all. */
  minWeight: z.number().positive().default(3),
  zLevel: z.number().positive().default(3),
  zSlope: z.number().positive().default(3),
  /** A slope alarm also needs at least this adjusted level z. */
  zLevelWithSlope: z.number().positive().default(1.5),
  k: z.number().int().positive().default(4),
  n: z.number().int().positive().max(30).default(6),
  /** Consecutive normal readings before an open incident closes. */
  closeAfterNormal: z.number().int().positive().default(12),
  /** Temperature readings count only this long after ignition on (engine warm-up). */
  warmupMin: z.number().nonnegative().default(25),
  /** Peer context: readings of peers within this much event time; fewer than minPeers → no adjustment. */
  peerWindowH: z.number().positive().default(2),
  minPeers: z.number().int().positive().default(10),
  /** Runaway: hours to limit below this for runawayConsecutive readings in a row → critical. */
  runawayHours: z.number().positive().default(12),
  runawayConsecutive: z.number().int().positive().default(3),
  /** A run of rejected (spiky) readings that agree with each other and span this long is a real level change. */
  rejectResetH: z.number().positive().default(1),
  /** DTC-rate rule: codes of a family in 24 h ≥ max(dtcMinCount, dtcFactor × own usual per day). */
  dtcFactor: z.number().positive().default(4),
  dtcMinCount: z.number().int().positive().default(3),
  /** Incident window bucket (incident_id = uuid5(vin, family, bucket)). */
  windowBucketH: z.number().positive().default(24),
  metrics: z
    .object({
      coolant_c: MetricParamsSchema,
      batt_temp_c: MetricParamsSchema,
      lv_batt_v: MetricParamsSchema,
    })
    .default({
      coolant_c: {
        label: 'coolant',
        unit: '°C',
        direction: 1,
        minMad: 0.5,
        minSlopeMad: 0.05,
        maxRatePerMin: 5,
        spikeMax: 25,
        hardLimit: 110,
        runawayMinRatePerH: 0.5,
        globalThreshold: 97,
      },
      batt_temp_c: {
        label: 'battery temperature',
        unit: '°C',
        direction: 1,
        minMad: 0.5,
        minSlopeMad: 0.05,
        maxRatePerMin: 2,
        spikeMax: 20,
        hardLimit: 60,
        runawayMinRatePerH: 0.5,
        globalThreshold: 47,
      },
      lv_batt_v: {
        label: '12 V battery',
        unit: 'V',
        direction: -1,
        minMad: 0.05,
        minSlopeMad: 0.005,
        maxRatePerMin: 1,
        spikeMax: 3,
        hardLimit: null,
        runawayMinRatePerH: 0.1,
        globalThreshold: null,
      },
    }),
});
export type DetectParams = z.infer<typeof DetectParamsSchema>;

export const DEFAULT_DETECT: DetectParams = DetectParamsSchema.parse({});
