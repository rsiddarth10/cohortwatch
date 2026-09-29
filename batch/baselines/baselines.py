"""Batch analytics job (S3): "each van's normal" + fault-rate table, from the history lake.

Reads the history Parquet (s3://<bucket>/history/dt=*/*.parquet, written by the simulator in 1b) with DuckDB
and writes, in ONE Postgres transaction (as cw_app; detection never reads sim.*):

  core.vehicle_baseline      per VIN x metric: median + MAD of the 12-h window means, median + MAD of the
                             12-h window OLS slopes (unit/h). The stream's EW trend has tau = 12 sim-h, so
                             the baseline is on the same scale as what it is compared with.
  core.cohort_baseline       fallback for vans without history: model x duty x region (region_id 0 = all
                             regions), the median of the vans' own values
  core.vehicle_dtc_baseline  a van's usual codes per day, per family
  core.fault_rate            codes per 1,000 vehicle-days by family x model x duty x depot (S5 expected rate)
  core.baseline_run          rows scanned, seconds, source hash

Readings used for the level/slope are the ones detection uses: PERIODIC, ignition on, in physical range;
temperatures also driving (speed > 0) and not charging. PERIODIC readings start one cadence (30 sim-min)
after ignition on, past the stream's 25-min warm-up rule. History is plant-free, so there are no incidents to
exclude; it has no quality flags (the simulator writes it without mess), so the range checks stand in for them.

Idempotent: the source hash is sha256(history manifest + job version). Same history -> "skip" (exit 0).
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time

import duckdb

JOB_VERSION = "baselines-v1"
WINDOW_H = 12
MIN_READINGS_PER_WINDOW = 4
MIN_WINDOWS = 3

# Physical ranges (same as the normaliser's validation, packages/domain canonical/validate.ts).
RANGES = {"coolant_c": (-40, 150), "batt_temp_c": (-40, 90), "lv_batt_v": (6, 18)}
DRIVING_ONLY = {"coolant_c", "batt_temp_c"}


def _metric_rows_sql(src: str) -> str:
    parts = []
    for m, (lo, hi) in RANGES.items():
        driving = " AND NOT charging AND speed_kmh > 0" if m in DRIVING_ONLY else ""
        parts.append(
            f"SELECT vin, '{m}' AS metric, epoch(event_ts) / 3600.0 AS th, {m} AS y FROM {src} "
            f"WHERE evt = 'PERIODIC' AND ignition AND {m} BETWEEN {lo} AND {hi}{driving}"
        )
    return "\nUNION ALL\n".join(parts)


def compute(con: duckdb.DuckDBPyConnection, src: str) -> dict[str, int]:
    """Builds result tables vb, cb, dtcb, fr in `con`. Needs tables veh(vin, model_id, duty_type_id,
    depot_id, region_id) and codes(code, family); `src` is a relation (e.g. read_parquet(...)) of history rows."""
    con.execute(f"CREATE OR REPLACE TEMP VIEW hist AS SELECT * FROM {src}")
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE win AS
        SELECT vin, metric, floor(th / {WINDOW_H}) AS w, count(*) AS n, avg(y) AS level,
               CASE WHEN max(th) - min(th) >= 1 THEN regr_slope(y, th) END AS slope
        FROM ({_metric_rows_sql('hist')})
        GROUP BY ALL HAVING count(*) >= {MIN_READINGS_PER_WINDOW}
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE vb AS
        SELECT vin, metric, median(level) AS median, mad(level) AS mad,
               coalesce(median(slope), 0) AS slope_median, coalesce(mad(slope), 0) AS slope_mad,
               count(*)::SMALLINT AS windows, sum(n)::INTEGER AS readings
        FROM win GROUP BY ALL HAVING count(*) >= {MIN_WINDOWS}
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE cb AS
        SELECT v.model_id, v.duty_type_id, coalesce(v.region_id, 0)::SMALLINT AS region_id, b.metric,
               median(b.median) AS median, median(b.mad) AS mad, median(b.slope_median) AS slope_median,
               median(b.slope_mad) AS slope_mad, count(*)::INTEGER AS vins
        FROM vb b JOIN veh v USING (vin)
        GROUP BY GROUPING SETS ((v.model_id, v.duty_type_id, v.region_id, b.metric), (v.model_id, v.duty_type_id, b.metric))
        """
    )
    # codes: one row per code in the pipe-joined dtc column; unknown valid codes are OTHER
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE code_rows AS
        SELECT h.vin, coalesce(c.family, 'OTHER') AS family
        FROM (SELECT vin, unnest(string_split(dtc, '|')) AS code FROM hist WHERE dtc IS NOT NULL AND dtc <> '') h
        LEFT JOIN codes c USING (code)
        WHERE h.code <> ''
        """
    )
    con.execute(
        "CREATE OR REPLACE TEMP TABLE vdays AS "
        "SELECT vin, count(DISTINCT CAST(event_ts AS DATE))::DOUBLE AS days FROM hist GROUP BY vin"
    )
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE dtcb AS
        SELECT r.vin, r.family, count(*) / d.days AS codes_per_day
        FROM code_rows r JOIN vdays d USING (vin) GROUP BY r.vin, r.family, d.days
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE fr AS
        WITH g AS (
          SELECT v.model_id, v.duty_type_id, v.depot_id, sum(d.days) AS vehicle_days
          FROM vdays d JOIN veh v USING (vin) GROUP BY ALL
        ), c AS (
          SELECT v.model_id, v.duty_type_id, v.depot_id, r.family, count(*)::INTEGER AS codes
          FROM code_rows r JOIN veh v USING (vin) GROUP BY ALL
        )
        SELECT f.family, g.model_id, g.duty_type_id, g.depot_id, g.vehicle_days,
               coalesce(c.codes, 0) AS codes, 1000.0 * coalesce(c.codes, 0) / g.vehicle_days AS per_1000
        FROM g CROSS JOIN (SELECT DISTINCT family FROM codes UNION SELECT 'OTHER') f
        LEFT JOIN c ON c.model_id = g.model_id AND c.duty_type_id = g.duty_type_id
                   AND c.depot_id = g.depot_id AND c.family = f.family
        """
    )
    rows = con.execute("SELECT count(*) FROM hist").fetchone()[0]
    vins = con.execute("SELECT count(DISTINCT vin) FROM vb").fetchone()[0]
    return {"rows": int(rows), "vins": int(vins)}


def _configure_s3(con: duckdb.DuckDBPyConnection) -> None:
    endpoint = os.environ.get("S3_ENDPOINT", "http://localhost:19000")
    ssl = endpoint.startswith("https://")
    host = endpoint.split("://", 1)[-1].rstrip("/")
    con.execute("LOAD httpfs")
    con.execute(
        "CREATE OR REPLACE SECRET lake (TYPE s3, KEY_ID $k, SECRET $s, REGION $r, ENDPOINT $e, "
        "URL_STYLE $u, USE_SSL $ssl)",
        {
            "k": os.environ.get("S3_ACCESS_KEY_ID", "cohortwatch"),
            "s": os.environ.get("S3_SECRET_ACCESS_KEY", "cohortwatch-dev-secret"),
            "r": os.environ.get("S3_REGION", "us-east-1"),
            "e": host,
            "u": "path" if os.environ.get("S3_FORCE_PATH_STYLE", "true") == "true" else "vhost",
            "ssl": ssl,
        },
    )


def _write(pg, run: dict, con: duckdb.DuckDBPyConnection) -> None:
    """One transaction: new run row, replace every baseline table (COPY)."""
    with pg.transaction():
        cur = pg.cursor()
        # children first (their FKs point at older runs); a forced rebuild replaces its own run row
        for t in ("fault_rate", "vehicle_dtc_baseline", "cohort_baseline", "vehicle_baseline"):
            cur.execute(f"DELETE FROM core.{t}")
        cur.execute("DELETE FROM core.baseline_run WHERE source_hash = %s", (run["hash"],))
        cur.execute(
            "INSERT INTO core.baseline_run (source_hash, history_from, history_to, rows_scanned, vins, seconds, engine) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (run["hash"], run["from"], run["to"], run["rows"], run["vins"], run["seconds"], run["engine"]),
        )
        run_id = cur.fetchone()[0]
        specs = [
            ("vehicle_baseline", "vin, metric, median, mad, slope_median, slope_mad, windows, readings",
             "SELECT vin, metric, median, mad, slope_median, slope_mad, windows, readings FROM vb"),
            ("cohort_baseline", "model_id, duty_type_id, region_id, metric, median, mad, slope_median, slope_mad, vins",
             "SELECT model_id, duty_type_id, region_id, metric, median, mad, slope_median, slope_mad, vins FROM cb"),
            ("vehicle_dtc_baseline", "vin, fault_family, codes_per_day",
             "SELECT vin, family, codes_per_day FROM dtcb"),
            ("fault_rate", "fault_family, model_id, duty_type_id, depot_id, vehicle_days, codes, per_1000_vehicle_days",
             "SELECT family, model_id, duty_type_id, depot_id, vehicle_days, codes, per_1000 FROM fr"),
        ]  # fmt: skip
        for table, cols, q in specs:
            with cur.copy(f"COPY core.{table} ({cols}, run_id) FROM STDIN") as cp:
                for row in con.execute(q).fetchall():
                    cp.write_row((*row, run_id))
        cur.execute("SELECT count(*) FROM core.vehicle_baseline")
        print(f"written run {run_id}: {cur.fetchone()[0]} vehicle baselines", flush=True)


def main(argv: list[str] | None = None) -> int:
    import psycopg  # only needed for the real run (the unit test uses compute() alone)

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true", help="rebuild even if this history was already processed")
    ap.add_argument("--prefix", default=os.environ.get("HISTORY_PREFIX", "history/"))
    args = ap.parse_args(argv)

    bucket = os.environ.get("LAKE_BUCKET", "cohortwatch-lake")
    db_url = os.environ.get("DATABASE_URL", "postgres://cw_app:cw_app_dev@localhost:15432/cohortwatch")
    t_start = time.monotonic()
    con = duckdb.connect(config={"memory_limit": os.environ.get("DUCKDB_MEMORY", "2GB"), "threads": 4})
    _configure_s3(con)

    manifest_url = f"s3://{bucket}/{args.prefix}_manifest.json"
    manifest = con.execute("SELECT content FROM read_text($u)", {"u": manifest_url}).fetchone()[0]
    source_hash = hashlib.sha256((JOB_VERSION + "\n" + manifest).encode()).hexdigest()

    with psycopg.connect(db_url, autocommit=True) as pg:
        done = pg.execute("SELECT id FROM core.baseline_run WHERE source_hash = %s", (source_hash,)).fetchone()
        if done and not args.force:
            print(f"skip: history already processed (run {done[0]})", flush=True)
            return 0

        con.execute("LOAD postgres")
        con.execute(f"ATTACH '{db_url.replace('postgres://', 'postgresql://')}' AS pg (TYPE postgres, READ_ONLY)")
        con.execute(
            """
            CREATE TEMP TABLE veh AS SELECT * FROM postgres_query('pg', $$
              SELECT v.vin::text AS vin, v.model_id, v.duty_type_id, a.depot_id, d.region_id
              FROM core.vehicle v JOIN core.vehicle_depot_assignment a ON a.vin = v.vin AND upper_inf(a.valid)
              JOIN core.depot d ON d.id = a.depot_id $$)
            """
        )
        con.execute("CREATE TEMP TABLE codes AS SELECT code, fault_family AS family FROM pg.core.fault_code")
        src = f"read_parquet('s3://{bucket}/{args.prefix}dt=*/*.parquet')"
        stats = compute(con, src)
        span = con.execute("SELECT min(event_ts), max(event_ts) FROM hist").fetchone()
        seconds = round(time.monotonic() - t_start, 2)
        print(f"computed: rows scanned {stats['rows']}, vins {stats['vins']}, {seconds} s", flush=True)
        run = {
            "hash": source_hash,
            "from": span[0],
            "to": span[1],
            "rows": stats["rows"],
            "vins": stats["vins"],
            "seconds": seconds,
            "engine": f"python {sys.version.split()[0]} + duckdb {duckdb.__version__}",
        }
        _write(pg, run, con)
    print(f"done in {round(time.monotonic() - t_start, 2)} s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
