import pg from 'pg';
import { campaignParamsFrom } from '../config.js';
import { CampaignEngine } from '../engine.js';
import { EngineRegistry } from '../registry.js';

/**
 * `npm run campaign:dismiss -- --id <campaign id> --reason "..." [--by <user>]`: "not an outbreak".
 * Sticky: the campaign is re-raised only if it gets materially worse (members +50% or +3, or a member turns
 * runaway). Same domain function the UI will call in S8; override + campaign + outbox in one transaction
 * (the running engine's relay publishes DISMISSED).
 */
async function main(): Promise<void> {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const id = arg('id');
  const reason = arg('reason');
  if (!id || !reason) throw new Error('usage: campaign:dismiss -- --id <campaign id> --reason "..." [--by <user>]');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://cw_app:cw_app_dev@localhost:15432/cohortwatch',
    max: 1,
  });
  try {
    const engine = new CampaignEngine(
      pool,
      new EngineRegistry(pool),
      campaignParamsFrom(process.env),
      'campaign.events.v1',
    );
    const events = await engine.dismiss(id, arg('by') ?? 'lead', reason);
    console.log(
      events.length
        ? `${id}: DISMISSED (version ${events[0]!.version})`
        : `${id}: nothing to do (already dismissed, merged or closed)`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
