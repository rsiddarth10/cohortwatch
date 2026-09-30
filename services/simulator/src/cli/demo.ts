import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';

/**
 * Video helper (S9): `npm run demo:pause` / `demo:resume` freeze and resume the simulator's clock (so the whole story
 * waits while you talk), and `npm run demo:status` prints the sim time and which story moments are ready now, with
 * the web URL for each. A presenter tool: it runs as cw_sim and may use the ground truth to find the planted vans.
 */
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';

async function clockCall(cfg: { metricsPort: number }, path: string, method = 'GET'): Promise<Record<string, unknown>> {
  const url = process.env.CLOCK_URL ?? `http://localhost:${cfg.metricsPort}/clock`;
  const r = await fetch(`${url}${path}`, { method, signal: AbortSignal.timeout(5000) });
  return (await r.json()) as Record<string, unknown>;
}

async function status(cfg: ReturnType<typeof loadSimulatorConfigFile>): Promise<void> {
  const clock = await clockCall(cfg, '').catch(() => null);
  const t0 = new Date(cfg.t0).getTime();
  if (clock)
    console.log(
      `sim time ${String(clock.simIso)} (T0+${Number(clock.sinceT0H).toFixed(1)} h)${clock.paused ? '  ** PAUSED **' : ''}`,
    );
  else console.log('simulator clock not reachable (is the stack up?)');
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  const one = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) =>
    (await client.query<T>(sql, args)).rows[0];
  try {
    const s1 = await one<{ id: string; status: string; members: number; at_risk: number; depot_id: number; code: string; opened_ts: Date | null }>(
      `SELECT c.id, c.status, c.member_count AS members, c.at_risk_count AS at_risk, c.depot_id, d.code, c.opened_ts
       FROM core.campaign c JOIN core.depot d ON d.id = c.depot_id
       WHERE EXISTS (SELECT 1 FROM core.campaign_member m JOIN sim.ground_truth g ON g.vin = m.vin
                     WHERE m.campaign_id = c.id AND g.role IN ('s1_sister', 's1_late_sister', 'bad_repair'))
         AND c.status IN ('OPEN', 'DISMISSED', 'CLOSED')
       ORDER BY c.member_count DESC LIMIT 1`,
    ); // prettier-ignore
    const prop = await one<{ id: string; depot: string; n: number; title: string }>(
      `SELECT p.id, d.code AS depot, jsonb_array_length(p.payload) AS n, p.title FROM core.proposal p
       JOIN core.depot d ON d.id = p.depot_id WHERE p.status = 'PENDING' AND p.action_type = 'BOOK_AT_RISK'
       ORDER BY (p.campaign_id = $1) DESC NULLS LAST, p.created_at DESC LIMIT 1`,
      [s1?.id ?? null],
    );
    const card = await one<{ vin: string; code: string; depot_id: number; title: string }>(
      `SELECT c.vin::text AS vin, d.code, c.depot_id, c.title FROM core.alert_card c JOIN core.depot d ON d.id = c.depot_id
       WHERE c.card_type = 'RUNAWAY' ORDER BY c.created_at DESC LIMIT 1`,
    );
    const fixed = await one<{ n: number; vin: string | null }>(
      `SELECT count(*)::int AS n, min(vin::text) AS vin FROM core.repair WHERE status = 'FIXED'`,
    );
    const bad = await one<{ vin: string; status: string }>(
      `SELECT r.vin::text AS vin, r.status FROM core.repair r JOIN sim.ground_truth g ON g.vin = r.vin
       WHERE g.role = 'bad_repair' ORDER BY r.repaired_ts DESC LIMIT 1`,
    );
    const ready = (ok: boolean) => (ok ? '✅ ready ' : '⏳ not yet');
    const h = (d: Date | null | undefined) => (d ? `T0+${((d.getTime() - t0) / 3_600_000).toFixed(1)} h` : '');
    const lines: [boolean, string, string][] = [
      [
        !!s1 && s1.status === 'OPEN',
        `S1 campaign open${s1 ? ` (${s1.members} vans, ${s1.at_risk} at-risk sisters, ${s1.code}, opened ${h(s1.opened_ts)})` : ''}`,
        s1 ? `${WEB}/campaigns/${s1.id}` : '',
      ],
      [
        !!s1 && s1.at_risk > 0,
        'at-risk sisters visible on the campaign page',
        s1 ? `${WEB}/campaigns/${s1.id}` : '',
      ],
      [!!prop, `pending agent proposal${prop ? `: ${prop.title}` : ''}`, `${WEB}/agent`],
      [!!card, `runaway card${card ? ` (${card.vin} at ${card.code})` : ''}`, card ? `${WEB}/depots/${card.depot_id}` : ''],
      [(fixed?.n ?? 0) > 0, `repaired van FIXED (${fixed?.n ?? 0} so far)`, fixed?.vin ? `${WEB}/vehicles/${fixed.vin}` : ''],
      [bad?.status === 'NOT_FIXED', `bad repair NOT_FIXED${bad ? ` (now ${bad.status})` : ''}`, bad ? `${WEB}/vehicles/${bad.vin}` : ''],
    ]; // prettier-ignore
    for (const [ok, what, url] of lines) console.log(`${ready(ok)}  ${what}${url ? `\n            ${url}` : ''}`);
    console.log(
      `\nboard: ${WEB}${s1 ? `/depots/${s1.depot_id}` : ''} · pause: npm run demo:pause · resume: npm run demo:resume`,
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'pause' || cmd === 'resume') {
    const r = await clockCall(cfg, `/${cmd}`, 'POST');
    console.log(r.error ? `failed: ${String(r.error)}` : `clock ${cmd}d at sim ${String(r.simIso)}`);
  } else await status(cfg);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
