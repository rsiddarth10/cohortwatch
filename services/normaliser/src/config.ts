import { z } from 'zod';

/** Normaliser configuration: environment only (12-factor); every value has a default that works in compose. */
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

export const NormaliserConfigSchema = z.object({
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  SCHEMA_REGISTRY_URL: z.string().default('http://localhost:18081'),
  REDIS_URL: z.string().default('redis://localhost:16379'),
  INPUT_TOPICS: csv.default(['raw.oem-a.v1', 'raw.oem-b.v1']),
  OUTPUT_TOPIC: z.string().default('telemetry.canonical.v1'),
  DLQ_TOPIC: z.string().default('telemetry.dlq.v1'),
  GROUP_ID: z.string().default('cg.normaliser'),
  /** avro (schema registry) or json (zod-validated fallback, see docs/adr). */
  ENCODING: z.enum(['avro', 'json']).default('avro'),
  /** Max records per eachBatch call (per partition). */
  BATCH_SIZE: z.coerce.number().int().min(1).max(100_000).default(2000),
  /** Partitions processed concurrently by one replica. */
  CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  /** Pause consumption when more produced-but-unacknowledged events are in flight than this. */
  MAX_INFLIGHT_EVENTS: z.coerce.number().int().min(1).default(50_000),
  /** Pause consumption when the Redis round trip (EWMA) exceeds this. */
  MAX_REDIS_MS: z.coerce.number().positive().default(250),
  /** Event-time ms per ingest (wall) ms: 1 in production, the simulator's speed (e.g. 360) in demo. */
  INGEST_CLOCK_SPEED: z.coerce.number().positive().default(1),
  /** CLOCK_SKEW when event time is this far ahead of the time its ingest implies. */
  SKEW_MS: z.coerce.number().int().min(0).default(120_000),
  /** Per-VIN state TTL in Redis (a van silent for longer starts a fresh window). */
  STATE_TTL_S: z.coerce
    .number()
    .int()
    .min(60)
    .default(7 * 24 * 3600),
  METRICS_PORT: z.coerce.number().int().default(9465),
  LOG_LEVEL: z.string().default('info'),
  /** Start from the earliest offset when the group has no committed offset. */
  FROM_BEGINNING: z.enum(['true', 'false']).default('true'),
});

export type NormaliserConfig = z.infer<typeof NormaliserConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): NormaliserConfig => NormaliserConfigSchema.parse(env);
