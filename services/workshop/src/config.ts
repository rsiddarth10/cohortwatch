import { FixParamsSchema, QueueParamsSchema, type FixParams, type QueueParams } from '@cw/domain';
import { z } from 'zod';

/** Workshop (S4 queue + S6 fix confirmation) configuration: environment only; defaults work in compose. */
export const WorkshopConfigSchema = z.object({
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  /** cw_app: detection data only (no access to schema sim). */
  DATABASE_URL: z.string().default('postgres://cw_app:cw_app_dev@localhost:15432/cohortwatch'),
  INCIDENT_TOPIC: z.string().default('incidents.v1'),
  CAMPAIGN_TOPIC: z.string().default('campaign.events.v1'),
  REPAIRS_TOPIC: z.string().default('workshop.repairs.v1'),
  QUEUE_TOPIC: z.string().default('queue.events.v1'),
  OUTCOMES_TOPIC: z.string().default('workshop.outcomes.v1'),
  GROUP_ID: z.string().default('cg.workshop'),
  FROM_BEGINNING: z.enum(['true', 'false']).default('true'),
  BATCH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(20).default(200),
  OUTBOX_BATCH: z.coerce.number().int().min(1).default(500),
  MAX_OUTBOX_BACKLOG: z.coerce.number().int().min(1).default(5_000),
  /** How often (wall ms) the leader checks whether event time moved a sim-hour (queue refresh + fix confirmation). */
  TICK_POLL_MS: z.coerce.number().int().min(100).default(2_000),
  REGISTRY_REFRESH_MS: z.coerce.number().int().min(1000).default(60_000),
  METRICS_PORT: z.coerce.number().int().default(9477),
  LOG_LEVEL: z.string().default('info'),
});

export type WorkshopConfig = z.infer<typeof WorkshopConfigSchema> & { queue: QueueParams; fix: FixParams };

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

export function queueParamsFrom(env: NodeJS.ProcessEnv): QueueParams {
  const base = QueueParamsSchema.parse({});
  return QueueParamsSchema.parse({
    ...base,
    minBayScore: num(env.QUEUE_MIN_BAY_SCORE) ?? base.minBayScore,
    slotsPerBayPerDay: num(env.QUEUE_SLOTS_PER_BAY) ?? base.slotsPerBayPerDay,
  });
}

export function fixParamsFrom(env: NodeJS.ProcessEnv): FixParams {
  const base = FixParamsSchema.parse({});
  return FixParamsSchema.parse({
    band: num(env.FIX_BAND_Z) ?? base.band,
    insideK: num(env.FIX_INSIDE_K) ?? base.insideK,
    insideN: num(env.FIX_INSIDE_N) ?? base.insideN,
    minDrivenH: num(env.FIX_MIN_DRIVEN_H) ?? base.minDrivenH,
    notFixedAfterH: num(env.FIX_NOT_FIXED_AFTER_H) ?? base.notFixedAfterH,
    windowH: num(env.FIX_WINDOW_H) ?? base.windowH,
  });
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): WorkshopConfig => ({
  ...WorkshopConfigSchema.parse(env),
  queue: queueParamsFrom(env),
  fix: fixParamsFrom(env),
});
