import { z } from 'zod';

/**
 * Campaign parameters (S5). Defaults from the S5 plan and the reference plan §9.6–9.9; every value is config
 * (the campaign engine reads overrides from env). Times are EVENT time.
 */
export const CampaignParamsSchema = z.object({
  /** Event-time bucket per family key (sim-hours). Buckets of one key that touch (gap ≤ 1 bucket) merge. */
  bucketH: z.number().positive().default(24),
  /** Opening: at least minVans distinct vans AND Poisson tail P(X ≥ n | λ) < alpha. */
  minVans: z.number().int().positive().default(5),
  /** 1e-4 (the reference plan's value): 1e-3 let a synchronised heatwave response open a campaign (S5 tuning). */
  alpha: z.number().positive().max(1).default(0.0001),
  /** Floor on the expected rate (incidents per 1,000 van-days), so a tiny baseline never makes 5 look huge. */
  rateFloorPer1000: z.number().positive().default(2),
  /** Window for the current regional rate of the same family (outside this depot). */
  regionalWindowH: z.number().positive().default(72),
  atRisk: z
    .object({
      /** ≥ k of the last n hourly rows with adjusted z_level ≥ zLevel … */
      zLevel: z.number().default(1.5),
      k: z.number().int().positive().default(3),
      n: z.number().int().positive().default(4),
      /** … or the newest row with z_slope ≥ zSlope and a positive adjusted deviation. */
      zSlope: z.number().default(2),
      /** Re-evaluated at least once per this many sim-hours. */
      everySimH: z.number().positive().default(1),
    })
    .default({ zLevel: 1.5, k: 3, n: 4, zSlope: 2, everySimH: 1 }),
  /** A dismissed campaign is re-raised when members reach +growthPct or +growthAbs (whichever comes first). */
  reraise: z
    .object({ growthPct: z.number().positive().default(50), growthAbs: z.number().int().positive().default(3) })
    .default({ growthPct: 50, growthAbs: 3 }),
  firmware: z
    .object({
      windowDays: z.number().positive().default(3),
      /** Shown only if at least this share of members got it, and the gap to healthy sisters is this many points. */
      minMemberShare: z.number().min(0).max(1).default(0.6),
      minGapPts: z.number().min(0).max(100).default(30),
    })
    .default({ windowDays: 3, minMemberShare: 0.6, minGapPts: 30 }),
  /** Money (assumptions, INR per van): expected breakdown cost if not fixed, minus the planned fix. */
  money: z
    .object({
      towInr: z.number().nonnegative().default(8_000),
      downtimeDays: z.number().nonnegative().default(3),
      dailyRevenueInr: z.number().nonnegative().default(6_000),
      repairPremiumInr: z.number().nonnegative().default(25_000),
      plannedFixInr: z.number().nonnegative().default(12_000),
    })
    .default({
      towInr: 8_000,
      downtimeDays: 3,
      dailyRevenueInr: 6_000,
      repairPremiumInr: 25_000,
      plannedFixInr: 12_000,
    }),
});
export type CampaignParams = z.infer<typeof CampaignParamsSchema>;

export const DEFAULT_CAMPAIGN: CampaignParams = CampaignParamsSchema.parse({});
