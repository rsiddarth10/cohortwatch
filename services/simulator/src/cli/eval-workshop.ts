import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';
import { table } from '../eval/common.js';
import { evalWorkshop } from '../eval/workshop.js';

/**
 * `npm run eval:workshop` (S4 + S6 scorecard). An EVALUATION tool, not detection: it runs as cw_sim and joins the
 * workshop's output (core.queue_snapshot, core.repair*, core.alert_card, core.campaign*) with sim.ground_truth.
 * Queue questions are point-in-time at T0 + EVAL_AT_H (default 29 h). Run with AUTO_REPAIRS=on to a produced
 * horizon ≥ T0+84 h.
 */
async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const t0 = new Date(cfg.t0).getTime();
    const atH = Number(process.env.EVAL_AT_H ?? 29);
    const { checks, facts } = await evalWorkshop({ client, t0, scale: cfg.scale }, atH);
    const hz = facts.horizonH === null ? '–' : `T0+${facts.horizonH.toFixed(1)} h`;
    console.log(`produced horizon: ${hz} · queue snapshot at T0+${atH.toFixed(1)} h · N = ${cfg.scale}\n`);
    console.log(table(['Check', 'Expected', 'Result'], checks));
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
