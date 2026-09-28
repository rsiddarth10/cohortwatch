import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { loadSimulatorConfigFile } from '@cw/common';
import {
  HOUR_MS,
  VehicleStream,
  dutyById,
  isDrivingReading,
  isValidVin,
  makeWorldContext,
  messUp,
  modelById,
  regionById,
  skewMs,
  type SimEvent,
} from '@cw/domain';
import pg from 'pg';
import { configPath } from '../config-path.js';
import { manifestKey, type HistoryManifest } from '../history.js';
import { Lake } from '../lake.js';
import { openDuck } from '../parquet.js';
import { buildWorld, type World } from '../world.js';

/**
 * npm run simulator:verify — the 14 checks of brief §5.8 (amended), at the configured N.
 * Runs on the host as cw_sim (simulator-private access is allowed here; this is not detection code).
 * Pure-model checks regenerate streams (the model is deterministic); #12 and #13 sample the live topics.
 */

interface Check {
  id: number;
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (id: number, name: string, pass: boolean, detail: string) => {
  checks.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  #${String(id).padStart(2)} ${name}\n        ${detail}`);
};
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const hT0 = (w: World, t: number) =>
  `T0${t >= w.registry.t0Ms ? '+' : ''}${((t - w.registry.t0Ms) / HOUR_MS).toFixed(1)}h`;

function streamOf(world: World, vin: string, from: number, to: number, plants = true): SimEvent[] {
  const v = world.registry.vehicles.find((x) => x.vin === vin)!;
  const ctx = makeWorldContext(world.registry, world.params, plants ? world.scenario : undefined);
  const s = new VehicleStream(v, ctx, from);
  const out: SimEvent[] = [];
  for (let e = s.next(); e.eventTs < to; e = s.next()) out.push(e);
  return out;
}

async function main(): Promise<void> {
  const cfg = loadSimulatorConfigFile(configPath());
  // The running stack decides N, seed and T0 (compose sets SIM_SCALE=100000; the host yaml says 5000).
  // Comparing against a different world would fail checks for the wrong reason, so refuse instead.
  const seeded = await seededWorld(cfg.databaseUrl);
  if (!seeded || seeded.n !== cfg.scale || seeded.seed !== cfg.seed || seeded.t0.getTime() !== Date.parse(cfg.t0)) {
    console.error(
      `verify is configured for N=${cfg.scale} seed=${cfg.seed} T0=${cfg.t0}, but the stack is seeded with ` +
        (seeded ? `N=${seeded.n} seed=${seeded.seed} T0=${seeded.t0.toISOString()}` : 'nothing') +
        `.
Set SIM_SCALE / SIM_SEED / SIM_T0 to match, e.g. SIM_SCALE=${seeded?.n ?? 100000} npm run simulator:verify`,
    );
    process.exit(2);
  }
  const sampleS = Number(process.env.VERIFY_SAMPLE_S ?? 120);
  const out = process.env.VERIFY_OUT ?? 'docs/perf/verify-1b.txt';
  const world = buildWorld(cfg);
  const { registry: reg, scenario: sc, params: P } = world;
  const T0 = reg.t0Ms;
  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  const q = async <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) =>
    (await client.query<T>(sql, args)).rows;
  const role = (r: string) => [...sc.plants.values()].filter((p) => p.role === r).map((p) => p.vin);
  const byVin = new Map(reg.vehicles.map((v) => [v.vin, v]));
  const depotRegion = new Map(reg.depots.map((d) => [d.id, d.regionId]));
  console.log(`CohortWatch simulator:verify  N=${cfg.scale}  seed=${cfg.seed}  T0=${cfg.t0}  plants=${cfg.plants}\n`);

  // #1 vehicle count and VINs ----------------------------------------------------------------------
  const vins = await q<{ vin: string }>('SELECT vin FROM core.vehicle');
  const bad = vins.filter((r) => !isValidVin(r.vin)).length;
  check(
    1,
    'vehicle count = N; all VINs valid',
    vins.length === cfg.scale && bad === 0,
    `count=${vins.length} (N=${cfg.scale}), invalid VINs=${bad}`,
  );

  // #2 reserved depots --------------------------------------------------------------------------
  const cohort = await q<{ depot: number; n: string }>(
    `SELECT a.depot_id AS depot, count(*) AS n FROM core.vehicle v
     JOIN core.vehicle_depot_assignment a ON a.vin = v.vin AND upper_inf(a.valid)
     JOIN core.vehicle_model m ON m.id = v.model_id JOIN core.duty_type t ON t.id = v.duty_type_id
     WHERE m.code = 'KS-D1' AND t.code = 'URBAN' AND a.depot_id = ANY($1) GROUP BY a.depot_id`,
    [[reg.reserved.s1DepotId, reg.reserved.s1bDepotId]],
  );
  const c = (d: number) => Number(cohort.find((r) => r.depot === d)?.n ?? 0);
  const s1n = c(reg.reserved.s1DepotId);
  const s1bn = c(reg.reserved.s1bDepotId);
  check(2, 'Depot S1 >= 60 S1-model urban vans; S1b >= 30', s1n >= 60 && s1bn >= 30, `S1=${s1n}, S1b=${s1bn}`);

  // #3 powertrains ------------------------------------------------------------------------------
  const pt = (vin: string) => modelById(byVin.get(vin)!.modelId).powertrain;
  const sisterVins = [...role('s1_sister'), ...role('bad_repair'), ...role('s1_late_sister'), ...role('s1b_sister')];
  const runaway = role('runaway')[0]!;
  check(
    3,
    'plant powertrains (S1/S1b diesel; runaway has a coolant signal)',
    sisterVins.every((v) => pt(v) === 'DIESEL') && pt(runaway) !== 'EV',
    `sisters=${sisterVins.length} all ${[...new Set(sisterVins.map(pt))].join('/')}; runaway=${pt(runaway)} ${modelById(byVin.get(runaway)!.modelId).code}`,
  );

  // #4 no overlap -------------------------------------------------------------------------------
  const reserved = new Set([reg.reserved.s1DepotId, reg.reserved.s1bDepotId]);
  const reservedRegions = new Set([...reserved].map((d) => depotRegion.get(d)));
  const decoys = role('decoy_scattered');
  const s1Key = (vin: string) => `${modelById(byVin.get(vin)!.modelId).code}|${dutyById(byVin.get(vin)!.dutyId).code}`;
  const overlaps = [
    ...decoys.filter((v) => reserved.has(byVin.get(v)!.homeDepotId) || s1Key(v) === 'KS-D1|URBAN'),
    ...(reserved.has(byVin.get(runaway)!.homeDepotId) ? [runaway] : []),
    ...(sc.heatwave && reservedRegions.has(sc.heatwave.regionId) ? ['heatwave'] : []),
  ];
  check(
    4,
    'decoys, heatwave region and runaway do not overlap S1/S1b depots or keys',
    overlaps.length === 0,
    `scattered decoys at ${new Set(decoys.map((v) => byVin.get(v)!.homeDepotId)).size} distinct depots; heatwave region ${sc.heatwave ? regionById(sc.heatwave.regionId).code : '-'}; overlaps=${overlaps.length}`,
  );

  // History (#5, #6, #11) from the lake ------------------------------------------------------------
  const lake = new Lake(cfg.lake);
  const manifest = await lake.getJson<HistoryManifest>(manifestKey('history/'));
  const tmp = mkdtempSync(join(tmpdir(), 'cw-verify-'));
  const { instance, conn } = await openDuck();
  try {
    const objects = (await lake.list('history/')).filter((o) => o.Key!.endsWith('.parquet'));
    for (const o of objects) {
      const local = join(tmp, o.Key!.replace(/[/=]/g, '_'));
      writeFileSync(local, await lake.getBytes(o.Key!));
    }
    await conn.run(`CREATE VIEW h AS SELECT * FROM read_parquet('${tmp.replace(/\\/g, '/')}/*.parquet')`);
    const one = async (sql: string) =>
      (await conn.runAndReadAll(sql)).getRowObjectsJson()[0] as Record<string, unknown>;

    // #5 history ends before first onset and has zero plant drift
    const firstOnset = Math.min(...[...sc.plants.values()].filter((p) => p.drift).map((p) => p.drift!.onsetMs));
    const span = await one(
      'SELECT count(*) AS n, epoch_ms(max(event_ts)) AS max_ms, epoch_ms(min(event_ts)) AS min_ms FROM h',
    );
    const maxMs = Number(span.max_ms);
    // Plant-free: sisters' history must equal the plant-free model exactly (compare their last history day).
    const sample = sisterVins.slice(0, 6);
    let mismatches = 0;
    for (const vin of sample) {
      const rows = (
        await conn.runAndReadAll(
          `SELECT seq, coolant_c FROM h WHERE vin = '${vin}' AND event_ts >= make_timestamp(${(T0 - 24 * HOUR_MS) * 1000}) ORDER BY seq`,
        )
      ).getRowObjectsJson() as { seq: string; coolant_c: number | null }[];
      const model = streamOf(world, vin, T0 - 24 * HOUR_MS, T0, false);
      if (rows.length !== model.length) mismatches++;
      else
        rows.forEach((r, i) => {
          const m = model[i]!;
          if (Number(r.seq) !== m.seq || (m.coolantC !== null && Math.abs(Number(r.coolant_c) - m.coolantC) > 1e-6))
            mismatches++;
        });
    }
    check(
      5,
      'history ends before the first onset and contains zero plant drift',
      maxMs < T0 && maxMs < firstOnset && mismatches === 0 && !!manifest,
      `rows=${span.n} (manifest ${manifest?.rows}), ends ${hT0(world, maxMs)} < first onset ${hT0(world, firstOnset)}; sisters' last history day identical to plant-free model: ${mismatches === 0 ? 'yes' : `NO (${mismatches} diffs)`}`,
    );

    // #6 urban readings per day
    const urbanVins = reg.vehicles.filter((v) => dutyById(v.dutyId).code === 'URBAN').map((v) => `'${v.vin}'`);
    await conn.run(`CREATE TABLE urban AS SELECT unnest([${urbanVins.join(',')}]) AS vin`);
    const days = manifest?.days ?? P.historyDays;
    const r6 = await one(
      `SELECT count(*) / (SELECT count(*) FROM urban) / ${days}.0 AS per_day,
              count(*) FILTER (WHERE ignition) / (SELECT count(*) FROM urban) / ${days}.0 AS on_per_day
       FROM h JOIN urban USING (vin)`,
    );
    const perDay = Number(r6.per_day);
    const onPerDay = Number(r6.on_per_day);
    check(
      6,
      'urban vans >= 20 readings/sim-day, >= 18 with ignition on',
      perDay >= 20 && onPerDay >= 18,
      `per day=${perDay.toFixed(1)}, ignition on=${onPerDay.toFixed(1)} (history, ${days} days)`,
    );

    // #11 naturally-hot vs global coolant threshold (driving readings, normal operation = history)
    const th = P.globalCoolantThresholdC;
    const hot = reg.vehicles.filter((v) => v.profile.naturallyHot).map((v) => `'${v.vin}'`);
    await conn.run(`CREATE TABLE hot AS SELECT unnest([${hot.join(',') || "'-'"}]) AS vin`);
    const drivingSql = `ignition AND evt IN ('PERIODIC','HARSH_BRAKE','HARSH_ACCEL','DTC','TRIP_END') AND coolant_c IS NOT NULL`;
    const r11 = await one(
      `SELECT avg(CASE WHEN coolant_c > ${th} THEN 1 ELSE 0 END) FILTER (WHERE vin IN (SELECT vin FROM hot)) AS hot_rate,
              avg(CASE WHEN coolant_c > ${th} THEN 1 ELSE 0 END) FILTER (WHERE vin NOT IN (SELECT vin FROM hot)) AS other_rate
       FROM h WHERE ${drivingSql} AND oem_id IS NOT NULL AND fuel_pct IS NOT NULL`,
    );
    const hotRate = Number(r11.hot_rate);
    const otherRate = Number(r11.other_rate);
    check(
      11,
      `naturally-hot vans exceed GLOBAL_COOLANT_THRESHOLD_C=${th} (>= 50% of driving readings) while other healthy diesel < 1%`,
      hotRate >= 0.5 && otherRate < 0.01,
      `naturally hot=${pct(hotRate)} (${hot.length} vans), other healthy diesel=${(100 * otherRate).toFixed(2)}%`,
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
    rmSync(tmp, { recursive: true, force: true });
  }

  // #7 runaway -------------------------------------------------------------------------------------
  const gt = await q<{ vin: string; role: string; limit_ts: Date | null; onset_ts: Date | null }>(
    'SELECT vin, role, limit_ts, onset_ts FROM sim.ground_truth WHERE limit_ts IS NOT NULL OR onset_ts IS NOT NULL',
  );
  const limit = gt.find((r) => r.vin === runaway)?.limit_ts?.getTime() ?? NaN;
  const run = streamOf(world, runaway, limit - 13 * HOUR_MS, limit + 1).filter(
    (e) => isDrivingReading(e) && e.eventTs >= limit - 12 * HOUR_MS && e.eventTs < limit,
  );
  check(
    7,
    'runaway: >= 15 driving readings between "< 12 h to limit" and limit_ts',
    run.length >= 15,
    `limit_ts=${hT0(world, limit)}, driving readings in [limit-12h, limit)=${run.length}`,
  );

  // #8 S1 main sisters: readings between onset and +8 C ----------------------------------------------
  const main = [...role('s1_sister'), ...role('bad_repair')];
  const counts8 = main.map((vin) => {
    const p = sc.plants.get(vin)!;
    const events = streamOf(world, vin, p.drift!.onsetMs, p.drift!.onsetMs + 60 * HOUR_MS);
    const eightAt = p.drift!.onsetMs + (8 / p.drift!.ratePerH) * HOUR_MS;
    return events.filter((e) => e.eventTs < eightAt).length;
  });
  check(
    8,
    'S1: >= 20 readings per main sister between onset and the +8 C point',
    counts8.every((n) => n >= 20),
    `min=${Math.min(...counts8)}, max=${Math.max(...counts8)} over ${main.length} main sisters`,
  );

  // #9 firmware split at depot S1 ------------------------------------------------------------------
  const fw = await q<{ grp: string; n: string }>(
    `SELECT CASE WHEN g.expected_campaign = 'S1' THEN 'sister' ELSE 'healthy' END AS grp, count(DISTINCT h.vin) AS n
     FROM sim.ground_truth g
     JOIN core.vehicle_firmware_history h ON h.vin = g.vin
     JOIN core.firmware_release r ON r.id = h.firmware_id AND r.version = '4.2.1'
     WHERE g.role IN ('s1_sister','bad_repair','s1_late_sister','s1_healthy_cohort')
       AND h.installed_at >= $1::timestamptz - interval '72 hours' AND h.installed_at < $1::timestamptz + interval '6 hours'
     GROUP BY 1`,
    [new Date(T0).toISOString()],
  );
  const fwS = Number(fw.find((r) => r.grp === 'sister')?.n ?? 0);
  const fwH = Number(fw.find((r) => r.grp === 'healthy')?.n ?? 0);
  const man = sc.firmware;
  check(
    9,
    'firmware 4.2.1 split at Depot S1 matches the manifest',
    !!man && fwS === man.s1SistersUpdated && fwH === man.s1HealthyUpdated,
    `sisters ${fwS}/18 (manifest ${man?.s1SistersUpdated}), healthy peers ${fwH}/42 = ${pct(fwH / 42)} (manifest ${man?.s1HealthyUpdated})`,
  );

  // #10 heatwave vs control window ------------------------------------------------------------------
  if (sc.heatwave) {
    const hw = sc.heatwave;
    const len = hw.toMs - hw.fromMs;
    const region = reg.vehicles.filter((v) => depotRegion.get(v.homeDepotId) === hw.regionId && !sc.plants.has(v.vin));
    const ctx = makeWorldContext(reg, P, sc);
    const res = { eng: { n: 0, pre: 0, hw: 0 }, ev: { n: 0, pre: 0, hw: 0 } };
    for (const v of region) {
      const ev = modelById(v.modelId).powertrain === 'EV';
      const k = ev ? 'ev' : 'eng';
      const th = ev ? P.globalBattTempThresholdC : P.globalCoolantThresholdC;
      const s = new VehicleStream(v, ctx, hw.fromMs - len);
      let a = false;
      let b = false;
      for (let e = s.next(); e.eventTs < hw.toMs; e = s.next()) {
        if (!isDrivingReading(e)) continue;
        const val = ev ? e.battTempC : e.coolantC;
        if (val !== null && val > th) {
          if (e.eventTs < hw.fromMs) a = true;
          else b = true;
        }
      }
      res[k].n++;
      if (a) res[k].pre++;
      if (b) res[k].hw++;
    }
    const f = (k: 'eng' | 'ev') => ({ pre: res[k].pre / res[k].n, hw: res[k].hw / res[k].n });
    const e = f('eng');
    const b = f('ev');
    check(
      10,
      'heatwave is hard: >= 30% of the region exceeds the global threshold during it, <= 5% in the equal window before',
      e.hw >= 0.3 && e.pre <= 0.05 && b.hw >= 0.3 && b.pre <= 0.05,
      `region ${regionById(hw.regionId).code}, window ${len / HOUR_MS}h. engines (coolant > ${P.globalCoolantThresholdC}): before ${pct(e.pre)}, during ${pct(e.hw)} (n=${res.eng.n}); EVs (battery > ${P.globalBattTempThresholdC}): before ${pct(b.pre)}, during ${pct(b.hw)} (n=${res.ev.n})`,
    );
  } else check(10, 'heatwave is hard', false, 'PLANTS=off: no heatwave');

  // #12 + #13 sample the live raw topics -----------------------------------------------------------
  const messBefore = await scrapeMess(cfg.metricsPort);
  const sample = await sampleTopics(cfg.kafka.brokers, sampleS);
  // Observed on the topics: duplicates, malformed, invalid VIN, unknown DTC, impossible values, late (seq below max).
  const seen = new Set<string>();
  const maxSeq = new Map<string, number>();
  let dup = 0,
    malformed = 0,
    invalidVin = 0,
    unknownDtc = 0,
    impossible = 0,
    late = 0,
    total = 0;
  const dtcRe = /^[PCBU][0-3][0-9A-F]{3}$/;
  const parsed: { vin: string; seq: number; value: string }[] = [];
  for (const m of sample.messages) {
    total++;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(m.value) as Record<string, unknown>;
    } catch {
      malformed++;
      continue;
    }
    const vin = (body.id ?? (body.vehicle as { vin?: string } | undefined)?.vin) as string | undefined;
    const seq = (body.sq ?? body.n ?? body.seqNo) as number | undefined;
    const ts = body.ts ?? body.t ?? body.time;
    if (!vin || seq === undefined || ts === undefined) {
      malformed++;
      continue;
    }
    if (!isValidVin(vin)) {
      invalidVin++;
      continue;
    }
    const key = `${vin}:${seq}`;
    if (seen.has(key)) {
      dup++;
      continue;
    }
    seen.add(key);
    if (seq < (maxSeq.get(vin) ?? -1)) late++;
    maxSeq.set(vin, Math.max(seq, maxSeq.get(vin) ?? -1));
    parsed.push({ vin, seq, value: m.value });
    const codes =
      (body.codes as string[] | undefined) ?? (typeof body.dtc === 'string' && body.dtc ? body.dtc.split('|') : []);
    if (codes.some((x) => !dtcRe.test(x))) unknownDtc++;
    const socRaw =
      body.soc ??
      (body.batt as { soc?: number } | undefined)?.soc ??
      (body.battery as { socPct?: number } | undefined)?.socPct;
    const soc = typeof socRaw === 'number' ? (body.id ? socRaw * 100 : socRaw) : null;
    const speed = (body.s ?? body.spd ?? body.speedKmh) as number;
    if ((soc !== null && soc > 100) || speed < 0) impossible++;
  }
  const messAfter = await scrapeMess(cfg.metricsPort);
  const gen = (k: string) => (messAfter[k] ?? 0) - (messBefore[k] ?? 0);
  const cfgMess = world.mess.cfg;
  const obs: [string, number, number][] = [
    ['duplicate', dup / total, cfgMess.duplicateRate],
    ['malformed', malformed / total, cfgMess.malformedRate],
    ['invalid_vin', invalidVin / total, cfgMess.invalidVinRate],
    ['unknown_dtc', unknownDtc / total, cfgMess.unknownDtcRate],
  ];
  // Impossible values: only speed<0 and SoC>100 are visible without per-van history -> compare to generator count.
  const within = (o: number, e: number) => o >= e * 0.7 && o <= e * 1.3;
  const lines = obs.map(
    ([k, o, e]) =>
      `${k}: observed ${(100 * o).toFixed(3)}% vs config ${(100 * e).toFixed(3)}% ${within(o, e) ? 'ok' : 'OUT'}`,
  );
  const genTotal = gen('__messages__');
  // Skew is a per-van property (constant offset), so it is measured over the whole fleet.
  const skewVans = reg.vehicles.filter((v) => skewMs(world.mess, v.vin) !== 0).length / reg.n;
  const offlineShare = gen('offline') / Math.max(1, genTotal);
  lines.push(
    `late (seq < max seen, from out-of-order + offline): observed ${(100 * (late / total)).toFixed(2)}% (config ooo ${100 * cfgMess.outOfOrderRate}% + offline backlog)`,
    `generator counters over the same window: out_of_order ${(100 * (gen('out_of_order') / Math.max(1, genTotal))).toFixed(2)}%, offline ${(100 * offlineShare).toFixed(2)}%, impossible ${(100 * (gen('impossible') / Math.max(1, genTotal))).toFixed(3)}% (observable on topic ${(100 * (impossible / total)).toFixed(3)}%), skewed vans ${pct(skewVans)} (config ${pct(cfgMess.skewVanRate)} of vans)`,
  );
  const oooGen = gen('out_of_order') / Math.max(1, genTotal);
  const impGen = gen('impossible') / Math.max(1, genTotal);
  const pass12 =
    total > 10_000 &&
    obs.every(([, o, e]) => within(o, e)) &&
    within(oooGen, cfgMess.outOfOrderRate) &&
    within(impGen, cfgMess.impossibleRate) &&
    within(skewVans, cfgMess.skewVanRate);
  check(
    12,
    `mess rates in a ${sampleS} s live sample within ±30% of config`,
    pass12,
    `${total} messages sampled\n        ${lines.join('\n        ')}`,
  );

  // #13 determinism: first 1,000 sampled messages ordered by (vin, seq), compared by content with a fresh model run
  const repaired = new Set((await q<{ vin: string }>('SELECT vin FROM sim.repair_log')).map((r) => r.vin));
  const firstK = parsed
    .filter((m) => !repaired.has(m.vin))
    .sort((a, b) => (a.vin < b.vin ? -1 : a.vin > b.vin ? 1 : a.seq - b.seq))
    .slice(0, 1000);
  const vinsK = [...new Set(firstK.map((m) => m.vin))];
  const ctx = makeWorldContext(reg, P, sc.enabled ? sc : undefined);
  const expected = new Map<string, Set<string>>();
  for (const vin of vinsK) {
    const seqs = firstK.filter((m) => m.vin === vin).map((m) => m.seq);
    const lo = Math.min(...seqs);
    const hi = Math.max(...seqs);
    const s = new VehicleStream(byVin.get(vin)!, ctx, T0 - 24 * HOUR_MS);
    for (let e = s.next(); e.seq <= hi; e = s.next()) {
      if (e.seq < lo) continue;
      for (const m of messUp(e, world.mess)) {
        const set = expected.get(`${vin}:${e.seq}`) ?? new Set<string>();
        set.add(m.value);
        expected.set(`${vin}:${e.seq}`, set);
      }
    }
  }
  const same = firstK.filter((m) => expected.get(`${m.vin}:${m.seq}`)?.has(m.value)).length;
  check(
    13,
    'same seed => identical first 1,000 messages by (vin, seq), compared by content',
    firstK.length === 1000 && same === 1000,
    `${same}/${firstK.length} sampled messages identical to a fresh deterministic model run (${vinsK.length} VINs)`,
  );

  // #14 cw_app cannot read sim ---------------------------------------------------------------------
  const appUrl = cfg.databaseUrl.replace(/cw_sim:[^@]*@/, `cw_app:${process.env.CW_APP_PASSWORD ?? 'cw_app_dev'}@`);
  const app = new pg.Client({ connectionString: appUrl });
  await app.connect();
  let denied = '';
  try {
    await app.query('SELECT count(*) FROM sim.ground_truth');
  } catch (err) {
    denied = (err as Error).message;
  }
  await app.end();
  check(
    14,
    'cw_app cannot SELECT from schema sim',
    denied.includes('permission denied'),
    denied || 'query succeeded (LEAK!)',
  );

  await client.end();
  const passed = checks.filter((x) => x.pass).length;
  const summary = `\n${passed}/${checks.length} checks passed`;
  console.log(summary);
  const report = [
    `CohortWatch simulator:verify (step 1b)  ${new Date().toISOString()}`,
    `N=${cfg.scale} seed=${cfg.seed} T0=${cfg.t0} plants=${cfg.plants} mess=${cfg.mess} live sample=${sampleS}s`,
    '',
    ...checks
      .sort((a, b) => a.id - b.id)
      .map((x) => `${x.pass ? 'PASS' : 'FAIL'}  #${String(x.id).padStart(2)} ${x.name}\n        ${x.detail}`),
    summary,
  ].join('\n');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report + '\n');
  console.log(`report written to ${out}`);
  process.exit(passed === checks.length ? 0 : 1);
}

async function scrapeMess(port: number): Promise<Record<string, number>> {
  try {
    const text = await (await fetch(`http://localhost:${port}/metrics`)).text();
    const out: Record<string, number> = {};
    for (const line of text.split('\n')) {
      const m = /^cw_sim_mess_total\{kind="([a-z_]+)"\} (\d+)/.exec(line);
      if (m) out[m[1]!] = Number(m[2]);
      const s = /^cw_sim_messages_sent_total\{[^}]*\} (\d+)/.exec(line);
      if (s) out.__messages__ = (out.__messages__ ?? 0) + Number(s[1]);
    }
    return out;
  } catch {
    return {};
  }
}

async function seededWorld(databaseUrl: string): Promise<{ seed: string; n: number; t0: Date } | undefined> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<{ seed: string; n: number; t0: Date }>('SELECT seed, n, t0 FROM sim.seed_state'))
      .rows[0];
  } finally {
    await client.end();
  }
}

async function sampleTopics(brokers: string, seconds: number): Promise<{ messages: { value: string }[] }> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: brokers.split(','), clientId: 'cw-verify', logLevel: KafkaJS.logLevel.ERROR },
  });
  const consumer = kafka.consumer({ kafkaJS: { groupId: `cw-verify-${Date.now()}`, fromBeginning: false } });
  const messages: { value: string }[] = [];
  await consumer.connect();
  await consumer.subscribe({ topics: ['raw.oem-a.v1', 'raw.oem-b.v1'] });
  let collecting = false;
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (collecting) messages.push({ value: message.value?.toString() ?? '' });
    },
  });
  // let partitions get assigned before the measurement window starts
  await new Promise((r) => setTimeout(r, 8_000));
  collecting = true;
  console.log(`sampling raw topics for ${seconds} s ...`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  collecting = false;
  await consumer.disconnect();
  return { messages };
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
