import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Simulator configuration: config/simulator.yaml, then environment overrides.
 * Env always wins so compose and CI can change scale without editing files.
 */
const ModelOverrides = z
  .object({
    historyDays: z.number().int().min(1).max(60),
    dayStartHourUtc: z.number().int().min(0).max(23),
    cadenceMin: z.number().positive(),
    heartbeatH: z.number().positive(),
    dtcPerVehicleDay: z.number().min(0),
    naturallyHotShare: z.number().min(0).max(1),
    chargeRatePctPerH: z.number().positive(),
    vansPerDepot: z.number().int().positive(),
    s1CohortSize: z.number().int().positive(),
    s1OtherModelSize: z.number().int().min(2),
    s1bCohortSize: z.number().int().positive(),
    globalCoolantThresholdC: z.number(),
    globalBattTempThresholdC: z.number(),
    coolant: z
      .object({
        baseC: z.number(),
        warmupTauMin: z.number().positive(),
        cooldownTauMin: z.number().positive(),
        noiseSdC: z.number().min(0),
        dutyLoadC: z.number(),
        ambientCoef: z.number(),
        hotAmbientCoef: z.number(),
        hotAmbientThresholdC: z.number(),
        offsetSdC: z.number().positive(),
        hardLimitC: z.number(),
      })
      .partial(),
  })
  .partial();

export const SimulatorConfigSchema = z.object({
  scale: z.coerce.number().int().min(500),
  seed: z.string().min(1),
  workers: z.coerce.number().int().min(1).max(64),
  /** T0 = start of the live stream = end of history (ISO). */
  t0: z.iso.datetime(),
  plants: z.enum(['on', 'off']),
  /** Streaming mode for `main.js` with no explicit mode argument. */
  mode: z.enum(['demo', 'live']),
  /** Simulated seconds per wall second in demo mode (360: 1 wall-second = 6 sim-minutes). */
  speed: z.coerce.number().positive(),
  mess: z.enum(['on', 'off']),
  autoRepairs: z.enum(['on', 'off']),
  depotTransfer: z.enum(['on', 'off']),
  /** Directory for simulator-private files (ground truth). Mounted only into the simulator + evaluation. */
  simPrivateDir: z.string().min(1),
  lake: z.object({
    endpoint: z.string().min(1),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    bucket: z.string().min(1),
    forcePathStyle: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]),
  }),
  history: z.object({
    days: z.coerce.number().int().min(1).max(60),
    intervalMin: z.coerce.number().positive(),
  }),
  kafka: z.object({
    brokers: z.string().min(1),
    clientId: z.string().min(1),
    lingerMs: z.coerce.number().int().min(0).max(1000),
  }),
  databaseUrl: z.string().min(1),
  metricsPort: z.coerce.number().int().min(1).max(65535),
  tickMs: z.coerce.number().int().min(10).max(5000),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  model: ModelOverrides.default({}),
});

export type SimulatorConfig = z.infer<typeof SimulatorConfigSchema>;

type Env = Record<string, string | undefined>;

/** Merge YAML defaults with env overrides and validate. Throws a readable error on bad config. */
export function loadSimulatorConfig(yamlText: string, env: Env = process.env): SimulatorConfig {
  const file = (parse(yamlText) ?? {}) as Record<string, unknown>;
  const kafka = (file.kafka ?? {}) as Record<string, unknown>;
  const lake = (file.lake ?? {}) as Record<string, unknown>;
  const history = (file.history ?? {}) as Record<string, unknown>;
  const model = (file.model ?? {}) as Record<string, unknown>;
  const merged = {
    ...file,
    scale: env.SIM_SCALE ?? file.scale,
    seed: env.SIM_SEED ?? file.seed,
    workers: env.SIM_WORKERS ?? file.workers,
    t0: env.SIM_T0 ?? file.t0,
    plants: env.PLANTS ?? file.plants,
    mode: env.SIM_MODE ?? file.mode,
    speed: env.SIM_SPEED ?? file.speed,
    mess: env.MESS ?? file.mess,
    autoRepairs: env.AUTO_REPAIRS ?? file.autoRepairs,
    depotTransfer: env.DEPOT_TRANSFER ?? file.depotTransfer,
    simPrivateDir: env.SIM_PRIVATE_DIR ?? file.simPrivateDir,
    lake: {
      ...lake,
      endpoint: env.S3_ENDPOINT ?? lake.endpoint,
      region: env.S3_REGION ?? lake.region,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? lake.accessKeyId,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? lake.secretAccessKey,
      bucket: env.LAKE_BUCKET ?? lake.bucket,
      forcePathStyle: env.S3_FORCE_PATH_STYLE ?? lake.forcePathStyle,
    },
    history: { ...history },
    model: {
      ...model,
      ...(env.GLOBAL_COOLANT_THRESHOLD_C ? { globalCoolantThresholdC: Number(env.GLOBAL_COOLANT_THRESHOLD_C) } : {}),
      ...(env.GLOBAL_BATT_TEMP_THRESHOLD_C
        ? { globalBattTempThresholdC: Number(env.GLOBAL_BATT_TEMP_THRESHOLD_C) }
        : {}),
    },
    kafka: {
      ...kafka,
      brokers: env.KAFKA_BROKERS ?? kafka.brokers,
    },
    databaseUrl: env.DATABASE_URL ?? file.databaseUrl,
    metricsPort: env.METRICS_PORT ?? file.metricsPort,
    logLevel: env.LOG_LEVEL ?? file.logLevel,
  };
  const parsed = SimulatorConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`invalid simulator config:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function loadSimulatorConfigFile(path: string, env: Env = process.env): SimulatorConfig {
  return loadSimulatorConfig(readFileSync(path, 'utf8'), env);
}
