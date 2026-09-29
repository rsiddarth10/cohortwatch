-- S3: detection. Fault-code reference, per-van baselines (batch job), fault-rate table, incidents + clues,
-- the global-threshold shadow rule (evaluation baseline) and the telemetry hypertable for the vehicle chart.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---- fault families and codes (same table as packages/domain catalog.ts; a unit test keeps them equal) ----
CREATE TABLE core.fault_family (
  code    text PRIMARY KEY,
  name    text NOT NULL,
  metric  text CHECK (metric IN ('coolant_c', 'batt_temp_c', 'lv_batt_v'))
);
INSERT INTO core.fault_family (code, name, metric) VALUES
  ('COOLING', 'Engine cooling', 'coolant_c'),
  ('HV_BATTERY_THERMAL', 'HV battery thermal', 'batt_temp_c'),
  ('LV_ELECTRICAL', '12 V electrical', 'lv_batt_v'),
  ('EXHAUST', 'Exhaust and emissions', NULL),
  ('BRAKE_SENSOR', 'Brake sensors', NULL),
  ('OTHER', 'Other or unknown code', NULL);

CREATE TABLE core.fault_code (
  code          text PRIMARY KEY CHECK (code ~ '^[PCBU][0-3][0-9A-F]{3}$'),
  fault_family  text NOT NULL REFERENCES core.fault_family (code)
);
INSERT INTO core.fault_code (code, fault_family) VALUES
  ('P0217', 'COOLING'), ('P0118', 'COOLING'), ('P0480', 'COOLING'),
  ('P0A7E', 'HV_BATTERY_THERMAL'), ('P0A80', 'HV_BATTERY_THERMAL'),
  ('P0562', 'LV_ELECTRICAL'), ('P0620', 'LV_ELECTRICAL'),
  ('P2463', 'EXHAUST'), ('P0401', 'EXHAUST'),
  ('C0035', 'BRAKE_SENSOR');

-- ---- baselines ("each van's normal"), written by the batch job ----------------------------------------
CREATE TABLE core.baseline_run (
  id             serial PRIMARY KEY,
  source_hash    text NOT NULL UNIQUE,          -- hash of the history manifest: same history → skipped
  history_from   timestamptz,
  history_to     timestamptz,
  rows_scanned   bigint NOT NULL,
  vins           integer NOT NULL,
  seconds        numeric(10, 2) NOT NULL,
  engine         text NOT NULL,                  -- e.g. "python 3.12 + duckdb 1.x"
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Level = mean of a van's qualifying readings per 12-h window; slope = OLS slope per window (unit/h).
-- median/MAD across windows: the same scale as the stream's EW level and slope (tau = 12 sim-h).
CREATE TABLE core.vehicle_baseline (
  vin           char(17) NOT NULL REFERENCES core.vehicle (vin),
  metric        text NOT NULL CHECK (metric IN ('coolant_c', 'batt_temp_c', 'lv_batt_v')),
  median        double precision NOT NULL,
  mad           double precision NOT NULL,
  slope_median  double precision NOT NULL,
  slope_mad     double precision NOT NULL,
  windows       smallint NOT NULL,
  readings      integer NOT NULL,
  run_id        integer NOT NULL REFERENCES core.baseline_run (id),
  PRIMARY KEY (vin, metric)
);

-- Fallback for vans without history: model × duty cohort (median of the vans' own values).
CREATE TABLE core.cohort_baseline (
  model_id      smallint NOT NULL REFERENCES core.vehicle_model (id),
  duty_type_id  smallint NOT NULL REFERENCES core.duty_type (id),
  metric        text NOT NULL CHECK (metric IN ('coolant_c', 'batt_temp_c', 'lv_batt_v')),
  median        double precision NOT NULL,
  mad           double precision NOT NULL,
  slope_median  double precision NOT NULL,
  slope_mad     double precision NOT NULL,
  vins          integer NOT NULL,
  run_id        integer NOT NULL REFERENCES core.baseline_run (id),
  PRIMARY KEY (model_id, duty_type_id, metric)
);

-- A van's usual fault codes per day, per family (only families it has reported).
CREATE TABLE core.vehicle_dtc_baseline (
  vin            char(17) NOT NULL REFERENCES core.vehicle (vin),
  fault_family   text NOT NULL REFERENCES core.fault_family (code),
  codes_per_day  double precision NOT NULL,
  run_id         integer NOT NULL REFERENCES core.baseline_run (id),
  PRIMARY KEY (vin, fault_family)
);

-- Codes per 1,000 vehicle-days by family × model × duty × depot (S5: expected rate for the Poisson test).
CREATE TABLE core.fault_rate (
  fault_family            text NOT NULL REFERENCES core.fault_family (code),
  model_id                smallint NOT NULL REFERENCES core.vehicle_model (id),
  duty_type_id            smallint NOT NULL REFERENCES core.duty_type (id),
  depot_id                integer NOT NULL REFERENCES core.depot (id),
  vehicle_days            double precision NOT NULL,
  codes                   integer NOT NULL,
  per_1000_vehicle_days   double precision NOT NULL,
  run_id                  integer NOT NULL REFERENCES core.baseline_run (id),
  PRIMARY KEY (fault_family, model_id, duty_type_id, depot_id)
);

-- ---- incidents ---------------------------------------------------------------------------------------
-- One row per (van, family, 24-h event-time window). id = uuid5(vin, family, window_bucket): a replay or a
-- restart re-derives the same id, and the UNIQUE key is the final guard against clones.
CREATE TABLE core.incident (
  id                   uuid PRIMARY KEY,
  vin                  char(17) NOT NULL REFERENCES core.vehicle (vin),
  fault_family         text NOT NULL REFERENCES core.fault_family (code),
  window_bucket        integer NOT NULL,
  family_key           text NOT NULL,                       -- family | model | duty | depot (at event time)
  trigger              text NOT NULL CHECK (trigger IN ('SIGNAL', 'DTC_RATE')),
  metric               text,
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  severity             text NOT NULL CHECK (severity IN ('WARN', 'HIGH', 'CRITICAL')),
  runaway              boolean NOT NULL DEFAULT false,
  opened_ts            timestamptz NOT NULL,                -- event time of the confirming reading
  opened_seq           bigint NOT NULL,
  critical_ts          timestamptz,                         -- event time the runaway rule fired
  hours_to_limit       real,                                -- at the latest action
  closed_ts            timestamptz,
  -- snapshot at event time (a later depot transfer does not rewrite this)
  depot_id             integer NOT NULL REFERENCES core.depot (id),
  model_id             smallint NOT NULL REFERENCES core.vehicle_model (id),
  duty_type_id         smallint NOT NULL REFERENCES core.duty_type (id),
  region_id            smallint NOT NULL REFERENCES core.region (id),
  firmware             text,
  -- the numbers behind the clues
  level                double precision,
  baseline_median      double precision,
  deviation            double precision,
  peer_adj             double precision,
  z_level              double precision,
  z_slope              double precision,
  slope_per_h          double precision,
  dtc_count_24h        integer NOT NULL DEFAULT 0,
  baseline_source      text CHECK (baseline_source IN ('VAN', 'COHORT')),
  -- wall-clock latency: producer x-sent-at of the triggering reading → incident written (ms)
  latency_ms           integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vin, fault_family, window_bucket)
);
CREATE INDEX incident_open_vin_idx ON core.incident (vin) WHERE status = 'OPEN';
CREATE INDEX incident_family_key_idx ON core.incident (family_key, opened_ts);

-- Latest clue set of an incident (replaced on each action). Phrases with numbers and units.
CREATE TABLE core.incident_clue (
  incident_id  uuid NOT NULL REFERENCES core.incident (id) ON DELETE CASCADE,
  ord          smallint NOT NULL,
  clue_type    text NOT NULL,
  text         text NOT NULL,
  value        double precision NOT NULL,
  unit         text NOT NULL,
  PRIMARY KEY (incident_id, ord)
);

-- Simple global-threshold rule run in shadow (same k-of-n, no own normal): the evaluation's comparison.
CREATE TABLE core.global_rule_hit (
  vin        char(17) NOT NULL REFERENCES core.vehicle (vin),
  metric     text NOT NULL,
  first_ts   timestamptz NOT NULL,
  PRIMARY KEY (vin, metric)
);

-- ---- telemetry (Timescale), down-sampled by the state processor: 1 row per van per bucket -------------
-- Temperatures and 12 V are averages of the readings detection uses (driving, warmed up, unflagged), so
-- the chart and the baseline band are on the same footing.
CREATE TABLE core.telemetry (
  vin              char(17) NOT NULL,
  ts               timestamptz NOT NULL,     -- bucket start (event time)
  readings         smallint NOT NULL,
  coolant_c        real,
  coolant_max_c    real,
  batt_temp_c      real,
  batt_temp_max_c  real,
  lv_batt_v        real,
  soc_pct          real,
  ambient_c        real,
  speed_kmh        real,
  dtc_count        smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (vin, ts)
);
SELECT create_hypertable('core.telemetry', by_range('ts', INTERVAL '1 day'));
ALTER TABLE core.telemetry SET (timescaledb.compress, timescaledb.compress_segmentby = 'vin', timescaledb.compress_orderby = 'ts');
-- Wall-clock policy: sim event time runs ahead of the wall clock in demo mode, so compress after a week.
SELECT add_compression_policy('core.telemetry', INTERVAL '7 days');

CREATE MATERIALIZED VIEW core.telemetry_hourly WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT vin,
       time_bucket(INTERVAL '1 hour', ts) AS hour,
       sum(readings)::integer AS readings,
       avg(coolant_c) AS coolant_c,
       max(coolant_max_c) AS coolant_max_c,
       avg(batt_temp_c) AS batt_temp_c,
       max(batt_temp_max_c) AS batt_temp_max_c,
       min(lv_batt_v) AS lv_batt_min_v,
       avg(ambient_c) AS ambient_c,
       sum(dtc_count)::integer AS dtc_count
FROM core.telemetry
GROUP BY vin, time_bucket(INTERVAL '1 hour', ts)
WITH NO DATA;
-- real-time aggregation (materialized_only = false) covers buckets the policy has not materialised yet
SELECT add_continuous_aggregate_policy('core.telemetry_hourly',
  start_offset => NULL, end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '5 minutes');

-- ---- grants ------------------------------------------------------------------------------------------
GRANT SELECT ON core.fault_family, core.fault_code TO cw_app, cw_sim;
-- the batch job and the state processor run as cw_app (detection never reads sim.*)
GRANT SELECT, INSERT, UPDATE, DELETE ON core.baseline_run, core.vehicle_baseline, core.cohort_baseline,
  core.vehicle_dtc_baseline, core.fault_rate, core.incident, core.incident_clue, core.global_rule_hit,
  core.telemetry TO cw_app;
GRANT SELECT ON core.telemetry_hourly TO cw_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO cw_app;
-- the evaluation job (cw_sim, may read ground truth) reads detection output
GRANT SELECT ON core.incident, core.incident_clue, core.global_rule_hit, core.vehicle_baseline,
  core.baseline_run, core.telemetry, core.telemetry_hourly TO cw_sim;
