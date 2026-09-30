"""Export one run's per-van-per-hour dataset for the at-risk classifier (S9).

Features: ONLY what detection can see at hour t (core.telemetry score columns written by S3, DTC and driving
counts, the van's model / duty / climate, and the cohort / campaign context known at t).
Label: ground truth, offline (sim.ground_truth, read by the evaluation role cw_sim). A van is a real fault
if its planted role is a true fault; the label at hour t is 1 when that van's first confirmed incident for its
fault family opens in (t, t + 24 h]. Rows after that incident are dropped (the van is no longer "at risk", it is
faulty). In production the label would come from confirmed repairs (S6 outcomes), not from a simulator.

Also exported for EVALUATION only (never features): the rule at-risk flag (S5), the global-threshold rule and
the ground-truth role (for the heatwave / naturally-hot false-positive counts).

Usage: python export.py <out.csv.gz>   (env DATABASE_URL = cw_sim, T0, HORIZON_H)
"""

import os
import sys
import time

import pandas as pd
import psycopg

TRUE_ROLES = (
    "s1_sister",
    "s1_late_sister",
    "s1b_sister",
    "runaway",
    "decoy_scattered",
    "decoy_same_depot_other_model",
    "bad_repair",
)

SQL = """
WITH v AS (
  SELECT v.vin, v.model_id, v.duty_type_id, m.powertrain, a.depot_id, r.climate_zone
  FROM core.vehicle v
  JOIN core.vehicle_model m ON m.id = v.model_id
  JOIN core.vehicle_depot_assignment a ON a.vin = v.vin AND upper_inf(a.valid)
  JOIN core.depot d ON d.id = a.depot_id
  JOIN core.region r ON r.id = d.region_id
),
gt AS (
  SELECT g.vin, g.role, g.fault_family, g.role = ANY(%(true_roles)s) AS is_fault,
         coalesce((SELECT min(i.opened_ts) FROM core.incident i WHERE i.vin = g.vin AND i.fault_family = g.fault_family),
                  g.limit_ts) AS event_ts
  FROM sim.ground_truth g
),
tel AS (
  SELECT t.vin, t.ts,
    t.coolant_dev, t.coolant_z, t.coolant_zs, t.batt_dev, t.batt_z, t.batt_zs, t.lv_dev, t.lv_zs,
    t.dtc_count, coalesce(t.harsh_count, 0) AS harsh_count, t.ambient_c, t.readings,
    avg(t.coolant_zs) OVER w3 AS coolant_zs_3h, max(t.coolant_zs) OVER w6 AS coolant_zs_max6h,
    t.coolant_dev - lag(t.coolant_dev, 6) OVER w AS coolant_dev_delta6h,
    avg(t.batt_zs) OVER w3 AS batt_zs_3h, max(t.batt_zs) OVER w6 AS batt_zs_max6h,
    t.batt_dev - lag(t.batt_dev, 6) OVER w AS batt_dev_delta6h,
    avg(t.lv_zs) OVER w3 AS lv_zs_3h,
    sum(t.dtc_count) OVER w24 AS dtc_24h, sum(t.dtc_count) OVER w6 AS dtc_6h,
    sum(coalesce(t.harsh_count, 0)) OVER w24 AS harsh_24h
  FROM core.telemetry t
  WHERE t.ts >= %(t0)s AND t.ts < %(t0)s::timestamptz + make_interval(hours => %(horizon)s)
  WINDOW w AS (PARTITION BY t.vin ORDER BY t.ts),
         w3 AS (PARTITION BY t.vin ORDER BY t.ts ROWS BETWEEN 2 PRECEDING AND CURRENT ROW),
         w6 AS (PARTITION BY t.vin ORDER BY t.ts ROWS BETWEEN 5 PRECEDING AND CURRENT ROW),
         w24 AS (PARTITION BY t.vin ORDER BY t.ts ROWS BETWEEN 23 PRECEDING AND CURRENT ROW)
),
cohort_inc AS (  -- incidents per (model, duty, depot) cohort, for "how many peers went faulty in the last 24 h"
  SELECT i.vin, i.opened_ts, v.model_id, v.duty_type_id, v.depot_id FROM core.incident i JOIN v ON v.vin = i.vin
)
SELECT tel.*, v.model_id, v.duty_type_id, v.powertrain, v.climate_zone, v.depot_id,
  (SELECT count(*) FROM cohort_inc c WHERE c.model_id = v.model_id AND c.duty_type_id = v.duty_type_id
     AND c.depot_id = v.depot_id AND c.vin <> tel.vin
     AND c.opened_ts > tel.ts - interval '24 hours' AND c.opened_ts <= tel.ts + interval '1 hour') AS cohort_incidents_24h,
  EXISTS (SELECT 1 FROM core.campaign c WHERE c.model_id = v.model_id AND c.duty_type_id = v.duty_type_id
     AND c.depot_id = v.depot_id AND c.opened_ts <= tel.ts + interval '1 hour') AS cohort_campaign_open,
  EXISTS (SELECT 1 FROM core.incident i WHERE i.vin = tel.vin AND i.opened_ts <= tel.ts + interval '1 hour'
     AND (i.closed_ts IS NULL OR i.closed_ts > tel.ts)) AS own_incident_open,
  -- evaluation-only columns (never used as features)
  EXISTS (SELECT 1 FROM core.campaign_at_risk a WHERE a.vin = tel.vin AND a.first_ts <= tel.ts + interval '1 hour'
     AND a.last_ts >= tel.ts) AS rule_at_risk,
  EXISTS (SELECT 1 FROM core.global_rule_hit h WHERE h.vin = tel.vin AND h.first_ts <= tel.ts + interval '1 hour') AS rule_global,
  coalesce(gt.role, 'background') AS gt_role,
  coalesce(gt.is_fault, false) AS gt_fault,
  gt.event_ts AS gt_event_ts
FROM tel JOIN v ON v.vin = tel.vin LEFT JOIN gt ON gt.vin = tel.vin
"""


def main() -> None:
    out = sys.argv[1]
    t0 = os.environ.get("T0", "2026-09-28T04:00:00Z")
    horizon = int(os.environ.get("HORIZON_H", "84"))
    started = time.time()
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(SQL, {"t0": t0, "horizon": horizon, "true_roles": list(TRUE_ROLES)})
            cols = [c.name for c in cur.description]
            df = pd.DataFrame(cur.fetchall(), columns=cols)
            cur.execute("SELECT count(*) FROM core.vehicle")
            fleet = cur.fetchone()[0]
            # the queue's full at-risk rule (campaign at-risk + solo at-risk from the van's own trend, S4/S5):
            # the VINs with an AT_RISK reason in each depot snapshot
            cur.execute(
                """SELECT s.depot_id, s.as_of_ts, s.version,
                          coalesce((SELECT array_agg(i->>'vin') FROM jsonb_array_elements(s.items) i
                                    WHERE i->'reasons' ? 'AT_RISK'), '{}') AS vins
                   FROM core.queue_snapshot s ORDER BY s.as_of_ts, s.version"""
            )
            snaps = pd.DataFrame(cur.fetchall(), columns=["depot_id", "as_of_ts", "version", "vins"])
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df["gt_event_ts"] = pd.to_datetime(df["gt_event_ts"], utc=True)
    # a row describes the hour starting at ts; the decision is made at its end, tau = ts + 1 h (features use
    # nothing later). Label: the van's first real-fault incident opens in (tau, tau + 24 h]. A real-fault van's
    # rows from its incident on are dropped.
    tau = df["ts"] + pd.Timedelta(hours=1)
    fault = df["gt_fault"].astype(bool)
    ev = df["gt_event_ts"]
    keep = ~fault | ev.isna() | (tau < ev)
    df = df[keep].copy()
    tau = df["ts"] + pd.Timedelta(hours=1)
    df["label"] = (
        df["gt_fault"].astype(bool)
        & df["gt_event_ts"].notna()
        & (df["gt_event_ts"] > tau)
        & (df["gt_event_ts"] <= tau + pd.Timedelta(hours=24))
    ).astype(int)
    # evaluation only: was the van flagged AT_RISK in its depot's latest queue snapshot at decision time?
    snaps["as_of_ts"] = pd.to_datetime(snaps["as_of_ts"], utc=True)
    snaps = snaps.sort_values("as_of_ts")
    df["tau"] = df["ts"] + pd.Timedelta(hours=1)
    df = df.sort_values("tau")
    m = pd.merge_asof(df[["tau", "depot_id", "vin"]], snaps[["as_of_ts", "depot_id", "vins"]], left_on="tau",
                      right_on="as_of_ts", by="depot_id", direction="backward")  # fmt: skip
    df["rule_queue_at_risk"] = [isinstance(vs, list) and v in vs for v, vs in zip(m["vin"].values, m["vins"].values)]
    df = df.drop(columns=["tau"])
    df["fleet"] = fleet
    df.to_csv(out, index=False, compression="gzip")
    print(
        f"{out}: {len(df):,} van-hours, {df['vin'].nunique():,} vans, positives {int(df['label'].sum()):,} "
        f"({df.loc[df['label'] == 1, 'vin'].nunique()} vans), fleet {fleet:,}, {time.time() - started:.1f} s"
    )


if __name__ == "__main__":
    main()
