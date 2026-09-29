import { DetectParamsSchema, type DetectParams } from '@cw/domain';
import { z } from 'zod';

/** State-processor configuration: environment only (12-factor); every value has a default that works in compose. */
export const StateConfigSchema = z.object({
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  SCHEMA_REGISTRY_URL: z.string().default('http://localhost:18081'),
  REDIS_URL: z.string().default('redis://localhost:16379'),
  /** cw_app: detection never reads sim.* (enforced by the role). */
  DATABASE_URL: z.string().default('postgres://cw_app:cw_app_dev@localhost:15432/cohortwatch'),
  INPUT_TOPIC: z.string().default('telemetry.canonical.v1'),
  INCIDENT_TOPIC: z.string().default('incidents.v1'),
  GROUP_ID: z.string().default('cg.state'),
  /** Input encoding: avro (Confluent wire format, schema fetched by id) or json (the normaliser's fallback). */
  ENCODING: z.enum(['avro', 'json']).default('avro'),
  /** Partitions processed concurrently per replica. */
  CONCURRENCY: z.coerce.number().int().min(1).max(64).default(48),
  /** Per-partition state is written to Redis this often (wall ms) and on revoke; offsets are committed after it. */
  CHECKPOINT_MS: z.coerce.number().int().min(200).default(10_000),
  /** Redis key prefix for checkpoints (a bench or test uses its own). */
  STATE_PREFIX: z.string().default('sp'),
  /** Checkpoints expire after this long without a write (seconds). */
  STATE_TTL_S: z.coerce
    .number()
    .int()
    .min(60)
    .default(7 * 24 * 3600),
  /** Registry (depot, model, duty) and baselines are reloaded this often (wall ms). */
  REGISTRY_REFRESH_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Pause input while more than this many incident writes are pending. */
  MAX_PENDING_WRITES: z.coerce.number().int().min(1).default(5_000),
  /** Telemetry writer: on/off, bucket size in sim-minutes, flush interval (wall ms). */
  TELEMETRY: z.enum(['on', 'off']).default('on'),
  TELEMETRY_BUCKET_MIN: z.coerce.number().int().min(1).max(1440).default(60),
  TELEMETRY_FLUSH_MS: z.coerce.number().int().min(200).default(5_000),
  METRICS_PORT: z.coerce.number().int().default(9466),
  LOG_LEVEL: z.string().default('info'),
  FROM_BEGINNING: z.enum(['true', 'false']).default('true'),
});

export type StateConfig = z.infer<typeof StateConfigSchema> & { detect: DetectParams };

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

/** Detection thresholds: domain defaults (reference plan §9.3–9.5), overridable from env. */
export function detectParamsFrom(env: NodeJS.ProcessEnv): DetectParams {
  const base = DetectParamsSchema.parse({});
  const pick = <T extends number>(name: string, dflt: T): T => (num(env[name]) ?? dflt) as T;
  const metrics = structuredClone(base.metrics);
  metrics.coolant_c.globalThreshold = pick('GLOBAL_COOLANT_THRESHOLD_C', metrics.coolant_c.globalThreshold ?? 97);
  metrics.batt_temp_c.globalThreshold = pick('GLOBAL_BATT_TEMP_THRESHOLD_C', metrics.batt_temp_c.globalThreshold ?? 45);
  metrics.coolant_c.hardLimit = pick('COOLANT_LIMIT_C', metrics.coolant_c.hardLimit ?? 110);
  metrics.batt_temp_c.hardLimit = pick('BATT_TEMP_LIMIT_C', metrics.batt_temp_c.hardLimit ?? 60);
  return DetectParamsSchema.parse({
    tauH: pick('DETECT_TAU_H', base.tauH),
    fastTauH: pick('DETECT_FAST_TAU_H', base.fastTauH),
    zLevel: pick('DETECT_Z_LEVEL', base.zLevel),
    zSlope: pick('DETECT_Z_SLOPE', base.zSlope),
    zLevelWithSlope: pick('DETECT_Z_LEVEL_WITH_SLOPE', base.zLevelWithSlope),
    k: pick('DETECT_K', base.k),
    n: pick('DETECT_N', base.n),
    closeAfterNormal: pick('DETECT_CLOSE_AFTER', base.closeAfterNormal),
    warmupMin: pick('DETECT_WARMUP_MIN', base.warmupMin),
    peerWindowH: pick('DETECT_PEER_WINDOW_H', base.peerWindowH),
    minPeers: pick('DETECT_MIN_PEERS', base.minPeers),
    runawayHours: pick('RUNAWAY_HOURS', base.runawayHours),
    runawayConsecutive: pick('RUNAWAY_CONSECUTIVE', base.runawayConsecutive),
    dtcFactor: pick('DTC_RATE_FACTOR', base.dtcFactor),
    dtcMinCount: pick('DTC_MIN_COUNT', base.dtcMinCount),
    windowBucketH: pick('INCIDENT_WINDOW_H', base.windowBucketH),
    metrics,
  });
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): StateConfig => ({
  ...StateConfigSchema.parse(env),
  detect: detectParamsFrom(env),
});
