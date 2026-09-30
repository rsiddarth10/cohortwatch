import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';
import { table } from '../eval/common.js';
import { EXPECTED_INCIDENTS, evalIncidents } from '../eval/incidents.js';

/**
 * `npm run eval:incidents` (S3 scorecard). An EVALUATION tool, not detection: it runs as cw_sim and joins the
 * detector's output (core.incident, core.global_rule_hit) with sim.ground_truth, per role.
 *
 * "ours" = incidents from the state processor (own normal − peers, k of n). "global" = the simple
 * global-threshold rule (coolant > GLOBAL_COOLANT_THRESHOLD_C or battery > GLOBAL_BATT_TEMP_THRESHOLD_C for
 * the same k of n), run in shadow by the state processor on the same readings.
 */
const f1 = (x: number | null) => (x === null ? '–' : x.toFixed(1));
const pct = (n: number, d: number) => (d === 0 ? '–' : `${((100 * n) / d).toFixed(1)}%`);

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const t0 = new Date(cfg.t0).getTime();
    const r = await evalIncidents({ client, t0, scale: cfg.scale });
    const hours = (d: Date | null) => (d ? ((d.getTime() - t0) / 3_600_000).toFixed(1) : '–');
    console.log(
      `incidents: ${r.total} (signal ${r.signal}, DTC-rate ${r.dtc}); opened T0+${hours(r.from)} h … T0+${hours(r.to)} h; N = ${cfg.scale}`,
    );
    console.log(
      `global rule: coolant > ${process.env.GLOBAL_COOLANT_THRESHOLD_C ?? cfg.model.globalCoolantThresholdC ?? 97} °C, battery > ${
        process.env.GLOBAL_BATT_TEMP_THRESHOLD_C ?? cfg.model.globalBattTempThresholdC ?? 47
      } °C, same k of n
`,
    );
    const head = ['role', 'vans', 'expected', 'ours', 'ours %', 'signal', 'DTC-rate', 'global', 'global %',
      'onset→incident h (p50/max)', 'global onset→hit h', 'critical', 'warning h']; // prettier-ignore
    const lines = r.rows.map((x) => [
      x.role,
      String(x.vans),
      EXPECTED_INCIDENTS[x.role] ?? '',
      String(x.ours),
      pct(x.ours, x.vans),
      String(x.ours_signal),
      String(x.ours_dtc),
      String(x.global),
      pct(x.global, x.vans),
      x.lag_p50 === null ? '–' : `${f1(x.lag_p50)} / ${f1(x.lag_max)}`,
      x.glag_p50 === null ? '–' : `${f1(x.glag_p50)} / ${f1(x.glag_max)}`,
      x.critical ? String(x.critical) : '',
      x.warn_min === null ? '' : x.warn_min === x.warn_max ? f1(x.warn_min) : `${f1(x.warn_min)}–${f1(x.warn_max)}`,
    ]); // prettier-ignore
    console.log(table(head, lines));
    const bg = r.rows.find((x) => x.role === 'background');
    if (bg && bg.vans > 0) {
      const per1000 = (n: number) => ((1000 * n) / bg.vans).toFixed(1);
      console.log(
        `
background false-incident rate per 1,000 vans: ours ${per1000(bg.ours)} (signal ${per1000(bg.ours_signal)}, DTC-rate ${per1000(bg.ours_dtc)}); global rule ${per1000(bg.global)}`,
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
