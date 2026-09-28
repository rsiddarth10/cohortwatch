import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DUTIES, MODELS, OEMS, REGIONS, type Registry } from '@cw/domain';
import type { Logger } from '@cw/common';
import type pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

type Cell = string | number | boolean | null;

/** CSV-encode one row for COPY ... (FORMAT csv). Empty unquoted field = NULL. */
export function csvRow(cells: readonly Cell[]): string {
  return (
    cells
      .map((c) => {
        if (c === null) return '';
        const s = typeof c === 'boolean' ? (c ? 't' : 'f') : String(c);
        return /[",\n\r]/.test(s) || s === '' ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(',') + '\n'
  );
}

const iso = (ms: number) => new Date(ms).toISOString();
/** Postgres tstzrange literal [from, to) ; open upper bound when `to` is null. */
export const range = (from: number, to: number | null) => `[${iso(from)},${to === null ? '' : iso(to)})`;

interface TableCopy {
  table: string;
  columns: string[];
  rows: () => Iterable<Cell[]>;
}

/** Every registry table, in foreign-key order. */
export function registryCopies(reg: Registry): TableCopy[] {
  return [
    {
      table: 'core.tenant',
      columns: ['id', 'code', 'name'],
      rows: () => reg.tenants.map((t) => [t.id, t.code, t.name]),
    },
    {
      table: 'core.subscription',
      columns: ['id', 'tenant_id', 'plan', 'valid'],
      rows: () => reg.subscriptions.map((s) => [s.id, s.tenantId, s.plan, range(s.validFromMs, s.validToMs)]),
    },
    {
      table: 'core.fleet',
      columns: ['id', 'tenant_id', 'name'],
      rows: () => reg.fleets.map((f) => [f.id, f.tenantId, f.name]),
    },
    {
      table: 'core.region',
      columns: ['id', 'code', 'name', 'climate_zone', 'ambient_mean_c', 'ambient_amp_c'],
      rows: () => REGIONS.map((r) => [r.id, r.code, r.name, r.climate, r.ambientMeanC, r.ambientAmpC]),
    },
    {
      table: 'core.depot',
      columns: ['id', 'code', 'fleet_id', 'region_id', 'lat', 'lon', 'geohash5', 'size_class'],
      rows: () => reg.depots.map((d) => [d.id, d.code, d.fleetId, d.regionId, d.lat, d.lon, d.geohash5, d.sizeClass]),
    },
    {
      table: 'core.workshop_bay',
      columns: ['id', 'depot_id', 'bay_no', 'capability'],
      rows: () => reg.bays.map((b) => [b.id, b.depotId, b.bayNo, b.capability]),
    },
    {
      table: 'core.oem',
      columns: ['id', 'code', 'name', 'wmi', 'payload_format'],
      rows: () => OEMS.map((o) => [o.id, o.code, o.name, o.wmi, o.payloadFormat]),
    },
    {
      table: 'core.vehicle_model',
      columns: ['id', 'oem_id', 'code', 'name', 'powertrain'],
      rows: () => MODELS.map((m) => [m.id, m.oemId, m.code, m.name, m.powertrain]),
    },
    {
      table: 'core.duty_type',
      columns: ['id', 'code', 'name', 'active_hours', 'load_factor'],
      rows: () => DUTIES.map((d) => [d.id, d.code, d.name, d.activeH, d.load]),
    },
    {
      table: 'core.firmware_release',
      columns: ['id', 'model_id', 'version', 'released_at'],
      rows: () => reg.firmwareReleases.map((f) => [f.id, f.modelId, f.version, iso(f.releasedAtMs)]),
    },
    {
      table: 'core.vehicle',
      columns: ['vin', 'tenant_id', 'fleet_id', 'model_id', 'duty_type_id', 'model_year', 'registered_at'],
      rows: () =>
        reg.vehicles.map((v) => [
          v.vin,
          v.tenantId,
          v.fleetId,
          v.modelId,
          v.dutyId,
          v.modelYear,
          iso(v.registeredAtMs),
        ]),
    },
    {
      table: 'core.vehicle_depot_assignment',
      columns: ['vin', 'depot_id', 'valid'],
      rows: () => reg.vehicles.map((v) => [v.vin, v.homeDepotId, range(v.registeredAtMs, null)]),
    },
    {
      table: 'core.vehicle_firmware_history',
      columns: ['vin', 'firmware_id', 'installed_at'],
      rows: function* () {
        for (const v of reg.vehicles) for (const f of v.firmware) yield [v.vin, f.releaseId, iso(f.installedAtMs)];
      },
    },
    {
      table: 'core.driver',
      columns: ['id', 'fleet_id', 'pseudonym'],
      rows: () => reg.drivers.map((d) => [d.id, d.fleetId, d.pseudonym]),
    },
    {
      table: 'core.driver_assignment',
      columns: ['driver_id', 'vin', 'valid'],
      rows: () => reg.driverAssignments.map((a) => [a.driverId, a.vin, range(a.validFromMs, a.validToMs)]),
    },
    {
      table: 'sim.vehicle_profile',
      columns: [
        'vin',
        'coolant_offset_c',
        'batt_temp_offset_c',
        'lv_offset_v',
        'efficiency',
        'style',
        'naturally_hot',
        'odo_base_km',
      ],
      rows: () =>
        reg.vehicles.map((v) => {
          const p = v.profile;
          return [
            v.vin,
            p.coolantOffsetC,
            p.battTempOffsetC,
            p.lvOffsetV,
            p.efficiency,
            p.style,
            p.naturallyHot,
            p.odoBaseKm,
          ];
        }),
    },
  ];
}

/** Rows as CSV text, chunked so a 100K-vehicle table streams without one giant string. */
function* csvChunks(rows: Iterable<Cell[]>, rowsPerChunk = 5_000): Generator<string> {
  let buf = '';
  let n = 0;
  for (const r of rows) {
    buf += csvRow(r);
    if (++n % rowsPerChunk === 0) {
      yield buf;
      buf = '';
    }
  }
  if (buf) yield buf;
}

/**
 * Idempotent registry seeding with COPY, in one transaction.
 * Same (seed, N, T0) already seeded -> skip. Anything else -> replace the registry.
 */
export async function seedRegistry(client: pg.Client, reg: Registry, log: Logger): Promise<'skipped' | 'seeded'> {
  const t0 = new Date(reg.t0Ms).toISOString();
  await client.query('BEGIN');
  try {
    // One seeder at a time, even if two simulators start together.
    await client.query('SELECT pg_advisory_xact_lock(424242)');
    const { rows } = await client.query<{ seed: string; n: number; t0: Date }>(
      'SELECT seed, n, t0 FROM sim.seed_state',
    );
    const current = rows[0];
    if (current && current.seed === reg.seed && current.n === reg.n && current.t0.toISOString() === t0) {
      await client.query('COMMIT');
      log.info({ seed: reg.seed, n: reg.n }, 'registry already seeded; skipping');
      return 'skipped';
    }
    if (current)
      log.warn({ from: current, to: { seed: reg.seed, n: reg.n, t0 } }, 'seed/N changed; replacing registry');

    const started = Date.now();
    const copies = registryCopies(reg);
    // DELETE (not TRUNCATE) in reverse FK order: later-step tables referencing the registry are not ours to truncate.
    for (const c of [...copies].reverse()) await client.query(`DELETE FROM ${c.table}`);
    await client.query('DELETE FROM sim.seed_state');

    for (const c of copies) {
      const t = Date.now();
      const sql = `COPY ${c.table} (${c.columns.join(', ')}) FROM STDIN WITH (FORMAT csv)`;
      await pipeline(Readable.from(csvChunks(c.rows())), client.query(copyFrom(sql)));
      log.debug({ table: c.table, ms: Date.now() - t }, 'copied');
    }
    const duration = Date.now() - started;
    await client.query('INSERT INTO sim.seed_state (seed, n, t0, duration_ms) VALUES ($1, $2, $3, $4)', [
      reg.seed,
      reg.n,
      t0,
      duration,
    ]);
    await client.query('COMMIT');
    log.info(
      { seed: reg.seed, n: reg.n, vehicles: reg.vehicles.length, drivers: reg.drivers.length, ms: duration },
      'registry seeded',
    );
    return 'seeded';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
