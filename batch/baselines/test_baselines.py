"""Unit test for the baselines job: synthetic history in a local Parquet file, no S3 or Postgres."""

import math

import duckdb
import pytest

from baselines import compute


@pytest.fixture()
def con(tmp_path):
    c = duckdb.connect()
    # 2 diesel vans, 4 days, driving 06:00-18:00 with a PERIODIC reading every 30 min
    c.execute(
        """
        CREATE TABLE ev (vin VARCHAR, event_ts TIMESTAMP, evt VARCHAR, ignition BOOLEAN, charging BOOLEAN,
                         speed_kmh DOUBLE, coolant_c DOUBLE, batt_temp_c DOUBLE, lv_batt_v DOUBLE, dtc VARCHAR)
        """
    )
    rows = []
    for vin, level in (("VANA0000000000001", 90.0), ("VANB0000000000002", 97.0)):
        for day in range(4):
            for k in range(25):
                ts = f"2026-09-{21 + day:02d} {6 + k // 2:02d}:{30 * (k % 2):02d}:00"
                y = level + 0.5 * math.sin(k / 3)
                rows.append((vin, ts, "PERIODIC", True, False, 40.0, y, None, 14.1, None))
            # parked heartbeat (never counts), a hot warm-up spike on a non-PERIODIC event (never counts)
            rows.append((vin, f"2026-09-{21 + day:02d} 22:00:00", "HEARTBEAT", False, False, 0.0, None, None, 12.6, None))
            rows.append((vin, f"2026-09-{21 + day:02d} 06:05:00", "TRIP_START", True, False, 5.0, 140.0, None, 14.0, None))
        rows.append((vin, "2026-09-22 09:00:00", "DTC", True, False, 30.0, None, None, 14.1, "P0217|P9999"))
    c.executemany("INSERT INTO ev VALUES (?, CAST(? AS TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    path = str(tmp_path / "h.parquet").replace("\\", "/")
    c.execute(f"COPY ev TO '{path}' (FORMAT parquet)")
    c.execute(
        "CREATE TABLE veh AS SELECT * FROM (VALUES ('VANA0000000000001', 6, 1, 10, 3), ('VANB0000000000002', 6, 1, 10, 3)) "
        "t(vin, model_id, duty_type_id, depot_id, region_id)"
    )
    c.execute("CREATE TABLE codes AS SELECT * FROM (VALUES ('P0217', 'COOLING'), ('P2463', 'EXHAUST')) t(code, family)")
    c.execute(f"CREATE VIEW src AS SELECT * FROM read_parquet('{path}')")
    return c


def test_vehicle_baselines_are_each_vans_own_normal(con):
    stats = compute(con, "src")
    assert stats["vins"] == 2
    got = dict(con.execute("SELECT vin, median FROM vb WHERE metric = 'coolant_c'").fetchall())
    assert got["VANA0000000000001"] == pytest.approx(90.0, abs=0.3)
    assert got["VANB0000000000002"] == pytest.approx(97.0, abs=0.3)  # naturally hot is its own normal
    mad, slope_mad, windows = con.execute(
        "SELECT mad, slope_mad, windows FROM vb WHERE vin = 'VANA0000000000001' AND metric = 'coolant_c'"
    ).fetchone()
    assert 0 <= mad < 0.3 and slope_mad >= 0 and windows >= 4
    # batt_temp is null for diesel vans: no baseline row
    assert con.execute("SELECT count(*) FROM vb WHERE metric = 'batt_temp_c'").fetchone()[0] == 0


def test_cohort_dtc_and_fault_rate(con):
    compute(con, "src")
    cohorts = con.execute("SELECT region_id, vins FROM cb WHERE metric = 'coolant_c' ORDER BY region_id").fetchall()
    assert cohorts == [(0, 2), (3, 2)]  # all regions + this region
    fams = dict(con.execute("SELECT family, codes_per_day FROM dtcb WHERE vin = 'VANA0000000000001'").fetchall())
    assert fams == {"COOLING": pytest.approx(0.25), "OTHER": pytest.approx(0.25)}  # 1 code over 4 days each
    rate = con.execute("SELECT codes, vehicle_days, per_1000 FROM fr WHERE family = 'COOLING'").fetchone()
    assert rate == (2, 8.0, pytest.approx(250.0))
    assert con.execute("SELECT codes FROM fr WHERE family = 'EXHAUST'").fetchone()[0] == 0
