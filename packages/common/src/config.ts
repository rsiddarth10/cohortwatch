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
  const merged = {
    ...file,
    scale: env.SIM_SCALE ?? file.scale,
    seed: env.SIM_SEED ?? file.seed,
    workers: env.SIM_WORKERS ?? file.workers,
    t0: env.SIM_T0 ?? file.t0,
    plants: env.PLANTS ?? file.plants,
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
  if (parsed.data.plants === 'on') {
    // Plants are a step-1b feature; refuse rather than silently stream a plant-free fleet.
    throw new Error('PLANTS=on is not available yet (step 1b). Use PLANTS=off.');
  }
  return parsed.data;
}

export function loadSimulatorConfigFile(path: string, env: Env = process.env): SimulatorConfig {
  return loadSimulatorConfig(readFileSync(path, 'utf8'), env);
}
