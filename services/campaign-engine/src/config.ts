import { CampaignParamsSchema, type CampaignParams } from '@cw/domain';
import { z } from 'zod';

/** Campaign-engine configuration: environment only (12-factor); every value has a default that works in compose. */
export const EngineConfigSchema = z.object({
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  /** cw_app: detection never reads sim.* (enforced by the role). */
  DATABASE_URL: z.string().default('postgres://cw_app:cw_app_dev@localhost:15432/cohortwatch'),
  INPUT_TOPIC: z.string().default('incidents.v1'),
  OUTPUT_TOPIC: z.string().default('campaign.events.v1'),
  GROUP_ID: z.string().default('cg.campaign'),
  FROM_BEGINNING: z.enum(['true', 'false']).default('true'),
  /** A batch that takes longer than this (wall ms) is a hang: the process exits and restarts (crash-only). */
  BATCH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  /** Outbox relay poll interval and batch size. */
  OUTBOX_POLL_MS: z.coerce.number().int().min(20).default(200),
  OUTBOX_BATCH: z.coerce.number().int().min(1).default(500),
  /** Pause input while more than this many outbox rows are unpublished. */
  MAX_OUTBOX_BACKLOG: z.coerce.number().int().min(1).default(5_000),
  /** How often (wall ms) the leader checks whether event time moved a sim-hour (at-risk refresh). */
  AT_RISK_POLL_MS: z.coerce.number().int().min(100).default(2_000),
  REGISTRY_REFRESH_MS: z.coerce.number().int().min(1000).default(60_000),
  METRICS_PORT: z.coerce.number().int().default(9475),
  LOG_LEVEL: z.string().default('info'),
});

export type EngineConfig = z.infer<typeof EngineConfigSchema> & { campaign: CampaignParams };

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

/** Campaign thresholds: domain defaults, overridable from env. */
export function campaignParamsFrom(env: NodeJS.ProcessEnv): CampaignParams {
  const base = CampaignParamsSchema.parse({});
  const pick = (name: string, dflt: number) => num(env[name]) ?? dflt;
  return CampaignParamsSchema.parse({
    ...base,
    bucketH: pick('CAMPAIGN_BUCKET_H', base.bucketH),
    minVans: pick('CAMPAIGN_MIN_VANS', base.minVans),
    alpha: pick('CAMPAIGN_ALPHA', base.alpha),
    rateFloorPer1000: pick('CAMPAIGN_RATE_FLOOR_PER_1000', base.rateFloorPer1000),
    regionalWindowH: pick('CAMPAIGN_REGIONAL_WINDOW_H', base.regionalWindowH),
    atRisk: {
      zLevel: pick('AT_RISK_Z_LEVEL', base.atRisk.zLevel),
      k: pick('AT_RISK_K', base.atRisk.k),
      n: pick('AT_RISK_N', base.atRisk.n),
      zSlope: pick('AT_RISK_Z_SLOPE', base.atRisk.zSlope),
      everySimH: pick('AT_RISK_EVERY_SIM_H', base.atRisk.everySimH),
    },
  });
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): EngineConfig => ({
  ...EngineConfigSchema.parse(env),
  campaign: campaignParamsFrom(env),
});
