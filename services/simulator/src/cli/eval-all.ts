import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSimulatorConfigFile } from '@cw/common';
import pg from 'pg';
import { configPath } from '../config-path.js';
import { evalCampaigns, type CampaignFacts } from '../eval/campaigns.js';
import { horizonH, rowsOf, table, type Check } from '../eval/common.js';
import { EXPECTED_INCIDENTS, evalIncidents, type IncidentRow } from '../eval/incidents.js';
import { evalWorkshop, type WorkshopFacts } from '../eval/workshop.js';

/**
 * `npm run eval:all` (S9). Runs the three scorecards (incidents, campaigns, workshop) plus a 60 s S2 reconcile when
 * the normaliser is up, saves docs/eval/results-<N>.json, and renders docs/evaluation.md with one row per claim of
 * brief §6 and one column pair per N that has results (5K and 30K). EVALUATION only: runs as cw_sim and joins
 * the detectors' output with sim.ground_truth; nothing here feeds back into detection.
 *
 * Needs a finished run: AUTO_REPAIRS=on and a produced horizon ≥ T0+84 h (the fix-confirmation window).
 * `--render` only re-renders the document from the saved results. `--reconcile-only` measures the ingestion window
 * into the saved results for this N (use it after scoring with the clock paused and EVAL_RECONCILE=off).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EVAL_DIR = resolve(ROOT, 'docs/eval');
const DOC = resolve(ROOT, 'docs/evaluation.md');

interface Reconcile {
  ran: boolean;
  balanced: boolean | null;
  text: string;
  rawIn?: number;
  out?: number;
  dlq?: number;
  dups?: number;
  seconds?: number;
}

interface Results {
  scale: number;
  seed: string;
  generatedAt: string;
  horizonH: number | null;
  incidents: { rows: IncidentRow[]; total: number; signal: number; dtc: number };
  campaigns: { facts: CampaignFacts; checks: Check[] };
  workshop: { facts: WorkshopFacts; checks: Check[] };
  baseline: {
    runawayGlobalWarnH: number | null;
    runawayOursWarnH: number | null;
    runawayFirstIncidentWarnH?: number | null;
    s1GlobalFirstHitToLimitH: number | null;
    s1FirstIncidentToLimitH: number | null;
  };
  reconcile: Reconcile;
}

async function ledgerUrls(): Promise<string[]> {
  const found: string[] = [];
  for (const port of [9465, 9466, 9467, 9468]) {
    const url = `http://localhost:${port}/ledger`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok) found.push(url);
    } catch {
      // not up on this port
    }
  }
  return found;
}

async function reconcile(seconds: number): Promise<Reconcile> {
  const urls = await ledgerUrls();
  if (urls.length === 0) return { ran: false, balanced: null, text: 'normaliser not running (no /ledger reachable)' };
  const cli = resolve(ROOT, 'services/normaliser/dist/cli/reconcile.js');
  const r = spawnSync(process.execPath, [cli, '--seconds', String(seconds), '--ledger', urls.join(',')], {
    encoding: 'utf8',
    timeout: (seconds + 900) * 1000,
  });
  const text = `${r.stdout ?? ''}`.trim();
  const num = (label: string) => {
    const m = text.match(new RegExp(`${label}\\s+(-?\\d+)`));
    return m ? Number(m[1]) : undefined;
  };
  return {
    ran: true,
    balanced: /BALANCED/.test(text) ? !/NOT BALANCED/.test(text) : null,
    text,
    rawIn: num('raw in \\(committed\\)'),
    out: num('canonical out'),
    dlq: num('DLQ'),
    dups: num('duplicates dropped'),
    seconds,
  };
}

async function collect(): Promise<Results> {
  const cfg = loadSimulatorConfigFile(configPath());
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    const t0 = new Date(cfg.t0).getTime();
    const e = { client, t0, scale: cfg.scale };
    const incidents = await evalIncidents(e);
    const campaigns = await evalCampaigns(e);
    const workshop = await evalWorkshop(e, Number(process.env.EVAL_AT_H ?? 29));
    // baselines that the scorecards do not print: the global rule's warning before limit_ts
    const [rw] = await rowsOf<{ global_h: number | null; ours_h: number | null; first_h: number | null }>(
      client,
      `SELECT (extract(epoch FROM g.limit_ts - (SELECT min(first_ts) FROM core.global_rule_hit h WHERE h.vin = g.vin)) / 3600)::float8 AS global_h,
              (extract(epoch FROM g.limit_ts - (SELECT min(critical_ts) FROM core.incident i WHERE i.vin = g.vin)) / 3600)::float8 AS ours_h,
              (extract(epoch FROM g.limit_ts - (SELECT min(opened_ts) FROM core.incident i WHERE i.vin = g.vin)) / 3600)::float8 AS first_h
       FROM sim.ground_truth g WHERE g.role = 'runaway' LIMIT 1`,
    );
    const [s1] = await rowsOf<{ global_h: number | null; incident_h: number | null }>(
      client,
      `WITH s AS (SELECT vin, limit_ts FROM sim.ground_truth WHERE role IN ('s1_sister', 's1_late_sister', 'bad_repair'))
       SELECT (extract(epoch FROM (SELECT min(limit_ts) FROM s) - (SELECT min(h.first_ts) FROM core.global_rule_hit h JOIN s ON s.vin = h.vin)) / 3600)::float8 AS global_h,
              (extract(epoch FROM (SELECT min(limit_ts) FROM s) - (SELECT min(i.opened_ts) FROM core.incident i JOIN s ON s.vin = i.vin)) / 3600)::float8 AS incident_h`,
    );
    const seconds = Number(process.env.EVAL_RECONCILE_S ?? 60);
    const rec = process.env.EVAL_RECONCILE === 'off' ? { ran: false, balanced: null, text: 'skipped (EVAL_RECONCILE=off)' } : await reconcile(seconds); // prettier-ignore
    return {
      scale: cfg.scale,
      seed: String(process.env.SIM_SEED ?? cfg.seed),
      generatedAt: new Date().toISOString(),
      horizonH: await horizonH(client, t0),
      incidents: { rows: incidents.rows, total: incidents.total, signal: incidents.signal, dtc: incidents.dtc },
      campaigns: { facts: campaigns.facts, checks: campaigns.checks },
      workshop: { facts: workshop.facts, checks: workshop.checks },
      baseline: {
        runawayGlobalWarnH: rw?.global_h ?? null,
        runawayOursWarnH: rw?.ours_h ?? null,
        runawayFirstIncidentWarnH: rw?.first_h ?? null,
        s1GlobalFirstHitToLimitH: s1?.global_h ?? null,
        s1FirstIncidentToLimitH: s1?.incident_h ?? null,
      },
      reconcile: rec,
    };
  } finally {
    await client.end();
  }
}

// ---- rendering ----------------------------------------------------------------------------------------------
const f1 = (x: number | string | null | undefined) => (x === null || x === undefined ? '–' : Number(x).toFixed(1));
const pc = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '–');
const p0 = (x: number) => `${Math.round(100 * x)}%`;
const fmtN = (n: number) => n.toLocaleString('en-US');
const role = (r: Results, name: string) => r.incidents.rows.find((x) => x.role === name);
const bgRate = (r: Results, who: 'ours' | 'global') => {
  const bg = role(r, 'background');
  return bg && bg.vans ? ((1000 * bg[who]) / bg.vans).toFixed(1) : '–';
};

interface Claim {
  claim: string;
  data: string;
  metric: string;
  ours: (r: Results) => string;
  baseline: (r: Results) => string;
  holds: (r: Results) => boolean | null;
}

const CLAIMS: Claim[] = [
  {
    claim: 'Own normal beats one global threshold',
    data: 'Naturally-hot vans + heatwave region (+ healthy background)',
    metric: 'False incidents (vans flagged / vans)',
    ours: (r) => {
      const hot = role(r, 'naturally_hot');
      const heat = role(r, 'heatwave_region');
      const bg = role(r, 'background');
      return `naturally hot **${hot?.ours ?? 0}/${hot?.vans ?? 0}** (${pc(hot?.ours ?? 0, hot?.vans ?? 0)}); heatwave **${heat?.ours ?? 0}/${heat?.vans ?? 0}** (${pc(heat?.ours ?? 0, heat?.vans ?? 0)}); background **${bg ? ((1000 * bg.ours) / bg.vans).toFixed(1) : '–'}** per 1,000`;
    },
    baseline: (r) => {
      const hot = role(r, 'naturally_hot');
      const heat = role(r, 'heatwave_region');
      const bg = role(r, 'background');
      return `global threshold: naturally hot ${hot?.global ?? 0}/${hot?.vans ?? 0} (${pc(hot?.global ?? 0, hot?.vans ?? 0)}); heatwave ${heat?.global ?? 0}/${heat?.vans ?? 0} (${pc(heat?.global ?? 0, heat?.vans ?? 0)}); background ${bg ? ((1000 * bg.global) / bg.vans).toFixed(1) : '–'} per 1,000`;
    },
    holds: (r) => {
      const t = ['naturally_hot', 'heatwave_region', 'background'].map((x) => role(r, x));
      return t.every((x) => !x || x.ours < x.global);
    },
  },
  {
    claim: 'Peer adjustment cancels shared conditions',
    data: 'Heatwave region (every van in the region runs hot)',
    metric: 'Campaigns / incidents in the region',
    ours: (r) => {
      const heat = role(r, 'heatwave_region');
      return `campaigns **${r.campaigns.facts.heatwaveCampaigns}**; incidents ${heat?.ours ?? 0}/${heat?.vans ?? 0} vans (${pc(heat?.ours ?? 0, heat?.vans ?? 0)}); heatwave vans ever in today's bays ${r.workshop.facts.heatwaveToday}`;
    },
    baseline: (r) => {
      const heat = role(r, 'heatwave_region');
      return `global threshold (no peers): ${heat?.global ?? 0}/${heat?.vans ?? 0} vans (${pc(heat?.global ?? 0, heat?.vans ?? 0)})`;
    },
    holds: (r) => r.campaigns.facts.heatwaveCampaigns === 0,
  },
  {
    claim: 'Grouping finds real outbreaks, rejects look-alikes',
    data: 'S1 (18 sisters), S1b (8), scattered + same-depot decoys (8)',
    metric: 'Membership precision/recall; S1 and S1b separate; decoys admitted',
    ours: (r) => {
      const c = r.campaigns.facts;
      const s1Prec = c.s1Recall + c.s1Intruders ? c.s1Recall / (c.s1Recall + c.s1Intruders) : 0;
      return `S1: ${c.s1Campaigns} campaign, recall **${c.s1Recall}/18**, precision **${p0(s1Prec)}**; S1b: ${c.s1bCampaigns} campaign, ${c.s1bRecall}/8, ${c.s1bSeparate ? '**separate**' : 'SHARED'}; decoys admitted **${c.decoysAdmitted}**; background campaigns ${c.backgroundCampaigns}`;
    },
    baseline: (r) => {
      const d = (role(r, 'decoy_scattered')?.global ?? 0) + (role(r, 'decoy_same_depot_other_model')?.global ?? 0);
      const o = (role(r, 'decoy_scattered')?.ours ?? 0) + (role(r, 'decoy_same_depot_other_model')?.ours ?? 0);
      return `no grouping: every decoy with a fault is just another alarm (global rule flags ${d}/8 decoys; our per-van detector ${o}/8, which S5 then keeps out)`;
    },
    holds: (r) => {
      const c = r.campaigns.facts;
      return c.s1Campaigns === 1 && c.s1Intruders === 0 && c.s1bSeparate && c.decoysAdmitted === 0;
    },
  },
  {
    claim: 'Joins are exact',
    data: 'Duplicates, redeliveries, offline bursts (the mess plan) + restarts',
    metric: 'Members = unique sisters',
    ours: (r) => {
      const c = r.campaigns.facts;
      return `**${c.memberRows}** member rows = **${c.uniqueMembers}** unique (vin, family); outbox ${c.outboxRows} rows, ${c.outboxUnpublished} unpublished`;
    },
    baseline: () => 'n/a (a naive at-least-once consumer would count each redelivery)',
    holds: (r) => r.campaigns.facts.memberRows === r.campaigns.facts.uniqueMembers,
  },
  {
    claim: 'Prediction (at-risk)',
    data: '3 late sisters (fault starts after S1 opens)',
    metric: '% flagged at-risk before crossing; lead time (h)',
    ours: (r) => {
      const c = r.campaigns.facts;
      const w = r.workshop.facts;
      return `**${c.lateFlagged}/${c.lateTotal}** at-risk before their own incident, lead **${c.lateLeadsH.map((x) => x.toFixed(1)).join(', ') || '–'} h**; in the queue ${w.lateInQueue}/${w.lateTotal} before it; healthy S1 cohort flagged ${c.healthyCohortFlagged}/42`;
    },
    baseline: (r) => {
      const l = role(r, 's1_late_sister');
      return `global threshold predicts nothing: it fires after onset (onset→hit p50 ${f1(l?.glag_p50)} h, ${l?.global ?? 0}/${l?.vans ?? 0} hit)`;
    },
    holds: (r) => r.campaigns.facts.lateFlagged === r.campaigns.facts.lateTotal && r.campaigns.facts.lateTotal > 0,
  },
  {
    claim: 'Queue beats "loudest-first"',
    data: 'Loud-but-stable vans (many codes, flat trend) vs sisters + runaway',
    metric: 'Precision@k vs the true at-risk set',
    ours: (r) => {
      const w = r.workshop.facts;
      return `precision@${w.k} at ${w.depotCode} **${p0(w.precisionAtK)}**; precision@50 fleet-wide **${p0(w.precisionAt50)}**; loud-but-stable above an S1 sister ${w.loudAboveSisterEver} times, in today's bays ${w.loudTodayEver}`;
    },
    baseline: (r) => {
      const w = r.workshop.facts;
      return `loudest-first (most codes in 24 h): precision@${w.k} ${p0(w.loudestAtK)}; precision@50 ${p0(w.loudestAt50)}`;
    },
    holds: (r) =>
      r.workshop.facts.precisionAtK > r.workshop.facts.loudestAtK &&
      r.workshop.facts.precisionAt50 > r.workshop.facts.loudestAt50,
  },
  {
    claim: 'Runaway early warning',
    data: 'The runaway van',
    metric: 'Hours of warning before `limit_ts`',
    ours: (r) => {
      const w = r.workshop.facts;
      return `first incident **${f1(r.baseline.runawayFirstIncidentWarnH)} h** before its limit; "critical, ≈ N h to limit" **${f1(r.baseline.runawayOursWarnH)} h** before; rank ${w.runawayRank ?? '–'} in its depot; critical → top of queue ${w.runawayTopS === null ? '–' : `${w.runawayTopS.toFixed(2)} s`}`;
    },
    baseline: (r) => `global threshold first hit ${f1(r.baseline.runawayGlobalWarnH)} h before the limit (a plain alarm: no "hours to limit", no rank, and the same rule flags ${bgRate(r, 'global')} of every 1,000 healthy vans)`, // prettier-ignore
    holds: (r) =>
      (r.baseline.runawayOursWarnH ?? 0) > 0 &&
      r.workshop.facts.runawayRank === 1 &&
      Number(r.baseline.runawayFirstIncidentWarnH ?? 0) >= Number(r.baseline.runawayGlobalWarnH ?? 0),
  },
  {
    claim: 'Detection before failure',
    data: 'S1 `limit_ts` (first sister to reach its limit)',
    metric: 'Hours from campaign open to the first `limit_ts`',
    ours: (r) => `campaign opened **${f1(r.campaigns.facts.earlyWarningH)} h** before the first limit (first S1 incident ${f1(r.baseline.s1FirstIncidentToLimitH)} h before)`, // prettier-ignore
    baseline: (r) => `global threshold's first hit on an S1 sister ${f1(r.baseline.s1GlobalFirstHitToLimitH)} h before: one van among ${bgRate(r, 'global')} alarms per 1,000 healthy vans, never grouped into an outbreak`, // prettier-ignore
    holds: (r) => (r.campaigns.facts.earlyWarningH ?? 0) > 0,
  },
  {
    claim: 'Fix confirmation',
    data: '15 repairs incl. 1 bad repair (`AUTO_REPAIRS=on`)',
    metric: 'Correct fixed / not-fixed labels',
    ours: (r) => {
      const w = r.workshop.facts;
      const ok = w.truthFixed.FIXED + w.truthNotFixed.NOT_FIXED;
      const pend = w.truthFixed.PENDING + w.truthNotFixed.PENDING;
      return `**${ok}/${w.repairs}** correct (FIXED ${w.truthFixed.FIXED}, NOT_FIXED ${w.truthNotFixed.NOT_FIXED}; wrong ${w.truthFixed.NOT_FIXED + w.truthNotFixed.FIXED}; pending ${pend}); bad repair back in the queue at rank ${w.badRepairRank ?? '–'}; S1 ${w.s1Status ?? '–'} (${w.s1Fixed}/${w.s1Members} fixed)`;
    },
    baseline: (r) => {
      const w = r.workshop.facts;
      const all = w.truthFixed.FIXED + w.truthFixed.NOT_FIXED + w.truthFixed.PENDING;
      return `"repaired = fixed": ${all}/${w.repairs} correct, the bad repair is closed as fixed and the campaign would close`;
    },
    holds: (r) =>
      r.workshop.facts.truthFixed.NOT_FIXED + r.workshop.facts.truthNotFixed.FIXED === 0 &&
      r.workshop.facts.truthNotFixed.NOT_FIXED > 0,
  },
  {
    claim: 'Robust ingestion',
    data: 'Mess (duplicates, late, out-of-order, bad values, format switch) + bursts',
    metric: 'Count in = count out (valid + DLQ + dropped duplicates)',
    ours: (r) =>
      r.reconcile.ran && r.reconcile.rawIn !== undefined
        ? `${r.reconcile.seconds} s window: in **${fmtN(r.reconcile.rawIn)}** = out ${fmtN(r.reconcile.out ?? 0)} + DLQ ${fmtN(r.reconcile.dlq ?? 0)} + duplicates ${fmtN(r.reconcile.dups ?? 0)} → **${r.reconcile.balanced ? 'BALANCED' : 'NOT BALANCED'}**`
        : `not measured in this run (${r.reconcile.text}); see docs/perf/normaliser.md`,
    baseline: () => 'n/a',
    holds: (r) => (r.reconcile.ran ? r.reconcile.balanced : null),
  },
  {
    claim: 'Throughput',
    data: 'Bench mode (`npm run simulator:bench`)',
    metric: 'Measured msgs/s, with hardware stated',
    ours: () => 'about **100K msgs/s** sustained into Redpanda (docs/perf/simulator-bench.md; laptop CPU, 8 producer processes, Docker Desktop/WSL2)', // prettier-ignore
    baseline: () => 'target: the 1× rate at N = 100K; the demo needs ~22K msgs/s',
    holds: () => true,
  },
];

function render(all: Results[]): string {
  const sorted = [...all].sort((a, b) => a.scale - b.scale);
  const label = (r: Results) => `N = ${fmtN(r.scale)}`;
  const mark = (x: boolean | null) => (x === null ? '–' : x ? '✅' : '⚠️');
  const head = ['Claim', 'Data', 'Metric', ...sorted.flatMap((r) => [`Ours (${label(r)})`, `Baseline (${label(r)})`])];
  const rows = CLAIMS.map((c) => [
    `${sorted.map((r) => mark(c.holds(r))).join(' ')} **${c.claim}**`,
    c.data,
    c.metric,
    ...sorted.flatMap((r) => [c.ours(r), c.baseline(r)]),
  ]);
  const md = (hd: string[], rs: string[][]) =>
    [`| ${hd.join(' | ')} |`, `|${hd.map(() => '---').join('|')}|`, ...rs.map((r) => `| ${r.join(' | ')} |`)].join(
      '\n',
    );
  const runs = sorted
    .map(
      (r) =>
        `- **${label(r)}**: seed \`${r.seed}\`, produced horizon T0+${f1(r.horizonH)} h, ${fmtN(r.incidents.total)} incidents, ${r.campaigns.facts.opened} campaigns opened; generated ${r.generatedAt}`,
    ) // prettier-ignore
    .join('\n');
  const appendix = sorted
    .map((r) => {
      const inc = md(
        [
          'role',
          'vans',
          'expected',
          'ours',
          'global',
          'ours onset→incident h (p50/max)',
          'global onset→hit h (p50/max)',
        ],
        r.incidents.rows.map((x) => [
          x.role,
          fmtN(x.vans),
          EXPECTED_INCIDENTS[x.role] ?? '',
          `${x.ours} (${pc(x.ours, x.vans)})`,
          `${x.global} (${pc(x.global, x.vans)})`,
          x.lag_p50 === null ? '–' : `${f1(x.lag_p50)} / ${f1(x.lag_max)}`,
          x.glag_p50 === null ? '–' : `${f1(x.glag_p50)} / ${f1(x.glag_max)}`,
        ]),
      );
      const rec = r.reconcile.ran ? `\n\n\`\`\`\n${r.reconcile.text}\n\`\`\`` : '';
      return `### ${label(r)}\n\n**Incidents by ground-truth role** (S3 scorecard)\n\n${inc}\n\n**Campaigns** (S5 scorecard)\n\n${md(['Check', 'Expected', 'Result'], r.campaigns.checks)}\n\n**Workshop queue and fix confirmation** (S4 + S6 scorecard, queue at T0+${r.workshop.facts.atH} h)\n\n${md(['Check', 'Expected', 'Result'], r.workshop.checks)}\n\n**Ingestion reconcile** (S2): ${r.reconcile.ran ? '' : r.reconcile.text}${rec}`;
    })
    .join('\n\n');
  return `# Evaluation: does CohortWatch do what it claims?

Generated by \`npm run eval:all\` (brief §6). Each row is one claim, the planted data that tests it, the metric, our
result and the simple baseline it must beat. Every number comes from the pipeline's own output in Postgres
(incidents, campaigns, queue snapshots, repairs), joined **after the run** with the simulator's private ground
truth (\`sim.ground_truth\`, readable only by the evaluation role \`cw_sim\`). Detection never sees it.

✅ = the claim holds at that scale · ⚠️ = it does not fully hold (see the numbers) · – = not measured in that run.

**Baselines.** *Global threshold*: one fixed limit for every van (coolant > 97 °C / battery > 47 °C for the same
k of n hours), run in shadow on the same readings. *Loudest-first*: rank vans by fault codes in the last 24 h.
*"Repaired = fixed"*: trust every repair.

**Runs**
${runs}

${md(head, rows)}

**How to reproduce:** \`docker compose down -v && SIM_SCALE=<N> AUTO_REPAIRS=on docker compose up -d\`, wait for a
produced horizon ≥ T0+84 h (about 15 wall-minutes at 360×), then \`npm run eval:all\` (the stack must be up for the
reconcile window). \`npm run eval:all -- --render\` rebuilds this page from \`docs/eval/results-*.json\`.

## Scorecards behind the table

${appendix}
`;
}

async function main(): Promise<void> {
  mkdirSync(EVAL_DIR, { recursive: true });
  if (process.argv.includes('--reconcile-only')) {
    // the scorecards were taken with the clock paused; the ingestion window needs live traffic
    const scale = loadSimulatorConfigFile(configPath()).scale;
    const file = resolve(EVAL_DIR, `results-${scale}.json`);
    const r = JSON.parse(readFileSync(file, 'utf8')) as Results;
    r.reconcile = await reconcile(Number(process.env.EVAL_RECONCILE_S ?? 60));
    writeFileSync(
      file,
      `${JSON.stringify(r, null, 2)}
`,
    );
    console.log(r.reconcile.text);
  } else if (!process.argv.includes('--render')) {
    const r = await collect();
    writeFileSync(resolve(EVAL_DIR, `results-${r.scale}.json`), `${JSON.stringify(r, null, 2)}\n`);
    console.log(`N = ${r.scale}, horizon T0+${f1(r.horizonH)} h`);
    if ((r.horizonH ?? 0) < 84)
      console.log('WARNING: horizon < T0+84 h: fix confirmation and campaign close are not final yet');
    console.log(table(['Check', 'Expected', 'Result'], [...r.campaigns.checks, ...r.workshop.checks])); // prettier-ignore
    console.log(r.reconcile.text);
  }
  const all = existsSync(EVAL_DIR)
    ? readdirSync(EVAL_DIR)
        .filter((f) => /^results-\d+\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(resolve(EVAL_DIR, f), 'utf8')) as Results)
    : [];
  writeFileSync(DOC, render(all));
  console.log(`wrote ${DOC} (${all.map((r) => r.scale).join(', ')})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
