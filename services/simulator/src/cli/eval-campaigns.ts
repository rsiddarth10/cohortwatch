import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';
import { evalCampaigns } from '../eval/campaigns.js';
import { sinceT0, table } from '../eval/common.js';

/**
 * `npm run eval:campaigns` (S5 scorecard). An EVALUATION tool, not detection: it runs as cw_sim and joins the
 * campaign engine's output (core.campaign*, core.incident) with sim.ground_truth.
 */
async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const t0 = new Date(cfg.t0).getTime();
    const { checks, facts, list } = await evalCampaigns({ client, t0, scale: cfg.scale });
    const hz = facts.horizonH === null ? '–' : `T0+${facts.horizonH.toFixed(1)} h`;
    console.log(`produced horizon: ${hz} (latest hourly telemetry row) · N = ${cfg.scale}`);
    console.log(`campaigns: ${facts.opened} opened, ${facts.watching} watching groups, ${facts.merged} merged\n`);
    console.log(table(['Check', 'Expected', 'Result'], checks));
    console.log('\nopened campaigns:');
    for (const c of list) {
      console.log(
        `  ${c.key.padEnd(22)} ${c.status.padEnd(9)} members ${String(c.members).padStart(3)}  at-risk ${String(c.at_risk).padStart(3)}  opened ${sinceT0(t0, c.opened_ts)}  p=${c.p?.toExponential(1)}`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
