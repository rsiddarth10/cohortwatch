import pg from 'pg';

/**
 * `npm run vehicle:normal -- --vin <VIN> [--metric coolant_c]`: one van vs its own normal, hourly.
 * The S8 vehicle chart's query: the continuous aggregate core.telemetry_hourly (index vin, hour) joined with
 * the van's baseline band (median ± 3 robust σ). Runs as cw_app (detection data only).
 */
export const VEHICLE_VS_NORMAL_SQL = `
SELECT h.hour, h.readings, h.value, b.median,
       b.median - 3 * 1.4826 * greatest(b.mad, $3) AS band_lo,
       b.median + 3 * 1.4826 * greatest(b.mad, $3) AS band_hi,
       b.source
FROM (SELECT hour, readings,
             CASE $2 WHEN 'coolant_c' THEN coolant_c WHEN 'batt_temp_c' THEN batt_temp_c ELSE lv_batt_min_v END AS value
      FROM core.telemetry_hourly WHERE vin = $1) h
CROSS JOIN LATERAL (
  SELECT median, mad, 'VAN' AS source FROM core.vehicle_baseline WHERE vin = $1 AND metric = $2
  UNION ALL
  SELECT c.median, c.mad, 'COHORT' FROM core.cohort_baseline c JOIN core.vehicle v ON v.model_id = c.model_id
    AND v.duty_type_id = c.duty_type_id WHERE v.vin = $1 AND c.metric = $2 AND c.region_id = 0
  LIMIT 1) b
WHERE h.value IS NOT NULL
ORDER BY h.hour`;

async function main(): Promise<void> {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const vin = arg('vin');
  const metric = arg('metric') ?? 'coolant_c';
  if (!vin) throw new Error('usage: vehicle:normal -- --vin <VIN> [--metric coolant_c|batt_temp_c|lv_batt_v]');
  const floor = metric === 'lv_batt_v' ? 0.05 : 0.5;
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://cw_app:cw_app_dev@localhost:15432/cohortwatch',
  });
  await client.connect();
  try {
    const t = performance.now();
    const { rows } = await client.query<{
      hour: Date;
      readings: number;
      value: number;
      median: number;
      band_lo: number;
      band_hi: number;
      source: string;
    }>(VEHICLE_VS_NORMAL_SQL, [vin, metric, floor]);
    const ms = (performance.now() - t).toFixed(1);
    console.log(`${vin} ${metric}: ${rows.length} hours (query ${ms} ms); baseline ${rows[0]?.source ?? '–'}`);
    console.log('hour (UTC)        | readings | value  | own normal | band            | vs normal');
    for (const r of rows) {
      const flag = r.value > r.band_hi ? 'ABOVE' : r.value < r.band_lo ? 'below' : '';
      console.log(
        `${r.hour.toISOString().slice(0, 16)} | ${String(r.readings).padStart(8)} | ${r.value.toFixed(1).padStart(6)} | ${r.median.toFixed(1).padStart(10)} | ${r.band_lo.toFixed(1)} … ${r.band_hi.toFixed(1)} | ${flag}`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
