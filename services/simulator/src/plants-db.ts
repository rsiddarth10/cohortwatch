import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildGroundTruth, type GroundTruthRow } from '@cw/domain';
import type { Logger } from '@cw/common';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { writeGroundTruthParquet } from './parquet.js';
import { csvRow } from './seed.js';
import type { World } from './world.js';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export const groundTruthPath = (dir: string) => join(dir, 'ground_truth.parquet');

/** Manifest rows: every plant van, plus scenario-level entries and the thresholds used by verify. */
function manifestRows(world: World): (string | number | boolean | null)[][] {
  const s = world.scenario;
  const p = world.params;
  const rows: (string | number | boolean | null)[][] = [];
  const h = world.scenarioHash;
  for (const x of s.plants.values()) {
    const params = {
      faultFamily: x.faultFamily,
      late: x.late,
      expectedCampaign: x.expectedCampaign,
      drift: x.drift,
      badRepair: x.badRepair,
      gentleDay: x.gentleDay,
      glitchDay: x.glitchDay,
      loudCodesPerDay: x.loudCodesPerDay,
    };
    rows.push([h, x.scenarioId, x.role, x.vin, null, iso(x.drift?.onsetMs ?? null), JSON.stringify(params)]);
  }
  const at = (role: string, depotId: number | null, onset: number | null, params: object) =>
    rows.push([h, 'SCENARIO', role, null, depotId, iso(onset), JSON.stringify(params)]);
  at('s1_depot', s.s1.depotId, null, { s1bDepotId: s.s1.s1bDepotId });
  if (s.heatwave) at('heatwave', null, s.heatwave.fromMs, s.heatwave);
  at('surge', null, s.surge.fromMs, s.surge);
  at('aurex_v2_switch', null, s.aurexV2FromMs, {});
  at('scenario_end', null, s.scenarioEndMs, { autoRepairAtMs: s.autoRepairAtMs });
  if (s.runaway) at('runaway_drive', null, s.runaway.driveFromMs, s.runaway);
  if (s.firmware) {
    const { installs, ...rest } = s.firmware;
    at('firmware_rollout', s.s1.depotId, s.firmware.releasedAtMs, { ...rest, installs: installs.length });
  }
  for (const t of s.transfers) at('depot_transfer', t.toDepotId, t.atMs, t);
  at('thresholds', null, null, {
    globalCoolantThresholdC: p.globalCoolantThresholdC,
    globalBattTempThresholdC: p.globalBattTempThresholdC,
    healthyCoolantOffsetSdC: p.coolant.offsetSdC,
    hardLimitC: p.coolant.hardLimitC,
    drivingReadingsOnly: true,
  });
  at('mess', null, null, world.mess.cfg);
  return rows;
}

async function copy(client: pg.Client, sql: string, rows: Iterable<(string | number | boolean | null)[]>) {
  await pipeline(
    Readable.from(
      (function* () {
        for (const r of rows) yield csvRow(r);
      })(),
    ),
    client.query(copyFrom(sql)),
  );
}

/**
 * Write plants to the database and the private ground-truth file. Idempotent: skipped when the stored
 * scenario hash matches. Firmware 4.2.1 is added as new rows (no reseed).
 */
export async function applyPlants(
  client: pg.Client,
  world: World,
  simPrivateDir: string,
  log: Logger,
): Promise<GroundTruthRow[] | null> {
  const s = world.scenario;
  const { rows } = await client.query<{ scenario_hash: string }>(
    'SELECT scenario_hash FROM sim.scenario_manifest LIMIT 1',
  );
  if (rows[0]?.scenario_hash === world.scenarioHash) {
    log.info({ scenarioHash: world.scenarioHash }, 'plants already applied; skipping');
    return null;
  }
  const started = Date.now();
  const gt = buildGroundTruth(world.registry, world.params, s);
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM sim.scenario_manifest');
    await client.query('DELETE FROM sim.ground_truth');
    await client.query('DELETE FROM sim.repair_log');
    await client.query('DELETE FROM sim.run_state');
    await copy(
      client,
      'COPY sim.scenario_manifest (scenario_hash, scenario_id, role, vin, depot_id, onset_ts, params) FROM STDIN WITH (FORMAT csv)',
      manifestRows(world),
    );
    await copy(
      client,
      `COPY sim.ground_truth (vin, scenario_id, role, fault_family, onset_ts, late, limit_ts, expected_campaign, repair_outcome)
       FROM STDIN WITH (FORMAT csv)`,
      gt.map((r) => [
        r.vin,
        r.scenarioId,
        r.role,
        r.faultFamily,
        iso(r.onsetTs),
        r.late,
        iso(r.limitTs),
        r.expectedCampaign,
        r.repairOutcome,
      ]),
    );
    if (s.firmware) {
      const f = s.firmware;
      await client.query(
        `INSERT INTO core.firmware_release (id, model_id, version, released_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [f.releaseId, f.modelId, f.version, iso(f.releasedAtMs)],
      );
      await client.query('DELETE FROM core.vehicle_firmware_history WHERE firmware_id = $1', [f.releaseId]);
      await copy(
        client,
        'COPY core.vehicle_firmware_history (vin, firmware_id, installed_at) FROM STDIN WITH (FORMAT csv)',
        f.installs.map((i) => [i.vin, f.releaseId, iso(i.installedAtMs)]),
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  mkdirSync(simPrivateDir, { recursive: true });
  await writeGroundTruthParquet(gt, groundTruthPath(simPrivateDir));
  log.info(
    {
      plants: s.plants.size,
      groundTruthRows: gt.length,
      firmwareInstalls: s.firmware?.installs.length ?? 0,
      ms: Date.now() - started,
    },
    'plants applied; ground truth written',
  );
  return gt;
}

/** Record a repair outcome and refresh the private Parquet copy. */
export async function recordRepairOutcome(
  client: pg.Client,
  world: World,
  vin: string,
  simPrivateDir: string,
): Promise<void> {
  const p = world.scenario.plants.get(vin);
  if (!p?.drift) return;
  await client.query('UPDATE sim.ground_truth SET repair_outcome = $2 WHERE vin = $1', [
    vin,
    p.badRepair ? 'not_fixed' : 'fixed',
  ]);
  const { rows } = await client.query<{
    vin: string;
    scenario_id: string | null;
    role: GroundTruthRow['role'];
    fault_family: GroundTruthRow['faultFamily'];
    onset_ts: Date | null;
    late: boolean;
    limit_ts: Date | null;
    expected_campaign: string | null;
    repair_outcome: GroundTruthRow['repairOutcome'];
  }>('SELECT * FROM sim.ground_truth');
  await writeGroundTruthParquet(
    rows.map((r) => ({
      vin: r.vin,
      scenarioId: r.scenario_id,
      role: r.role,
      faultFamily: r.fault_family,
      onsetTs: r.onset_ts?.getTime() ?? null,
      late: r.late,
      limitTs: r.limit_ts?.getTime() ?? null,
      expectedCampaign: r.expected_campaign,
      repairOutcome: r.repair_outcome,
    })),
    groundTruthPath(simPrivateDir),
  );
}
