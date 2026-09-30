import { z } from 'zod';

/**
 * Workshop queue parameters (S4). Weights follow the reference plan §9.10; every value is config and documented in
 * ADR 0014. Hazards are rough daily breakdown probabilities for the cost of waiting (assumptions, not data).
 */
export const QueueParamsSchema = z.object({
  weights: z
    .object({
      severity: z.number().default(0.35),
      trend: z.number().default(0.25),
      campaign: z.number().default(0.2),
      inService: z.number().default(0.1),
      /** Behaviour is capped: it can add at most this much (10% of a perfect score). */
      behaviourCap: z.number().default(0.1),
      /** Added when a repair did not hold. */
      notFixed: z.number().default(0.15),
    })
    .default({ severity: 0.35, trend: 0.25, campaign: 0.2, inService: 0.1, behaviourCap: 0.1, notFixed: 0.15 }),
  severity: z
    .object({ WARN: z.number().default(0.4), HIGH: z.number().default(0.7), CRITICAL: z.number().default(1), atRisk: z.number().default(0.2) })
    .default({ WARN: 0.4, HIGH: 0.7, CRITICAL: 1, atRisk: 0.2 }),
  /** z_slope that counts as a full trend score; hours to limit below which the trend score is full. */
  fullTrendZ: z.number().positive().default(4),
  trendHorizonH: z.number().positive().default(72),
  /** Campaign factor = log2(1 + members) / log2(1 + campaignFullAt); at-risk sisters get atRiskFactor of it. */
  campaignFullAt: z.number().positive().default(20),
  atRiskFactor: z.number().min(0).max(1).default(0.5),
  /** Behaviour ratio (harsh events per driven hour vs the duty's median) at which the capped weight is full. */
  behaviourFullRatio: z.number().positive().default(3),
  /** Bays: slots per bay per day; only items at or above minBayScore take a bay (runaways always do). */
  slotsPerBayPerDay: z.number().int().positive().default(1),
  minBayScore: z.number().min(0).max(1).default(0.35),
  /** Daily breakdown hazard used for the cost of waiting when no time to limit is known. */
  hazardPerDay: z
    .object({ WARN: z.number().default(0.05), HIGH: z.number().default(0.15), CRITICAL: z.number().default(0.5), member: z.number().default(0.1), atRisk: z.number().default(0.03), notFixed: z.number().default(0.2) })
    .default({ WARN: 0.05, HIGH: 0.15, CRITICAL: 0.5, member: 0.1, atRisk: 0.03, notFixed: 0.2 }),
}); // prettier-ignore
export type QueueParams = z.infer<typeof QueueParamsSchema>;

export const DEFAULT_QUEUE: QueueParams = QueueParamsSchema.parse({});
