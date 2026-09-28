import { DuckDBInstance, type DuckDBAppender, type DuckDBConnection } from '@duckdb/node-api';
import type { GroundTruthRow, SimEvent } from '@cw/domain';

/** Canonical telemetry columns (SI units), shared by history Parquet and later batch jobs. */
export const EVENT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ev (
  vin VARCHAR, oem_id INTEGER, seq DOUBLE, event_ts_ms DOUBLE, evt VARCHAR,
  lat DOUBLE, lon DOUBLE, speed_kmh DOUBLE, odo_km DOUBLE, ambient_c DOUBLE,
  coolant_c DOUBLE, rpm DOUBLE, batt_temp_c DOUBLE, soc_pct DOUBLE, fuel_pct DOUBLE, lv_batt_v DOUBLE,
  ignition BOOLEAN, charging BOOLEAN, harsh_brake INTEGER, harsh_accel INTEGER, idle_s INTEGER,
  dtc VARCHAR, firmware VARCHAR)`;

/** Typed projection written to Parquet (timestamps as TIMESTAMP, seq as BIGINT). */
export const EVENT_SELECT = `SELECT vin, oem_id, CAST(seq AS BIGINT) AS seq,
  make_timestamp(CAST(event_ts_ms * 1000 AS BIGINT)) AS event_ts, evt, lat, lon, speed_kmh, odo_km, ambient_c,
  coolant_c, CAST(rpm AS INTEGER) AS rpm, batt_temp_c, soc_pct, fuel_pct, lv_batt_v, ignition, charging,
  harsh_brake, harsh_accel, idle_s, dtc, firmware FROM ev`;

export async function openDuck(): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '2' });
  const conn = await instance.connect();
  return { instance, conn };
}

const num = (a: DuckDBAppender, x: number | null) => (x === null ? a.appendNull() : a.appendDouble(x));

export function appendEvent(a: DuckDBAppender, e: SimEvent): void {
  a.appendVarchar(e.vin);
  a.appendInteger(e.oemId);
  a.appendDouble(e.seq);
  a.appendDouble(e.eventTs);
  a.appendVarchar(e.evt);
  a.appendDouble(e.lat);
  a.appendDouble(e.lon);
  a.appendDouble(e.speedKmh);
  a.appendDouble(e.odoKm);
  a.appendDouble(e.ambientC);
  num(a, e.coolantC);
  num(a, e.rpm);
  num(a, e.battTempC);
  num(a, e.socPct);
  num(a, e.fuelPct);
  a.appendDouble(e.lvBattV);
  a.appendBoolean(e.ignition);
  a.appendBoolean(e.charging);
  a.appendInteger(e.harshBrake);
  a.appendInteger(e.harshAccel);
  a.appendInteger(e.idleS);
  a.appendVarchar(e.dtc.join('|'));
  a.appendVarchar(e.firmware);
  a.endRow();
}

const sqlPath = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, "''")}'`;

export async function copyToParquet(conn: DuckDBConnection, select: string, path: string): Promise<void> {
  await conn.run(`COPY (${select}) TO ${sqlPath(path)} (FORMAT parquet, COMPRESSION zstd)`);
}

/** Ground truth -> Parquet (simulator-private file). */
export async function writeGroundTruthParquet(rows: GroundTruthRow[], path: string): Promise<void> {
  const { instance, conn } = await openDuck();
  try {
    await conn.run(`CREATE TABLE gt (vin VARCHAR, scenario_id VARCHAR, role VARCHAR, fault_family VARCHAR,
      onset_ms DOUBLE, late BOOLEAN, limit_ms DOUBLE, expected_campaign VARCHAR, repair_outcome VARCHAR)`);
    const a = await conn.createAppender('gt');
    const str = (x: string | null) => (x === null ? a.appendNull() : a.appendVarchar(x));
    for (const r of rows) {
      a.appendVarchar(r.vin);
      str(r.scenarioId);
      a.appendVarchar(r.role);
      str(r.faultFamily);
      num(a, r.onsetTs);
      a.appendBoolean(r.late);
      num(a, r.limitTs);
      str(r.expectedCampaign);
      str(r.repairOutcome);
      a.endRow();
    }
    a.closeSync();
    const ts = (c: string) => `CASE WHEN ${c} IS NULL THEN NULL ELSE make_timestamp(CAST(${c} * 1000 AS BIGINT)) END`;
    await copyToParquet(
      conn,
      `SELECT vin, scenario_id, role, fault_family, ${ts('onset_ms')} AS onset_ts, late, ${ts('limit_ms')} AS limit_ts,
        expected_campaign, repair_outcome FROM gt ORDER BY vin`,
      path,
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
