-- 003: simulator-private schema (brief §4.2 [1a]). cw_app has no USAGE on schema sim,
-- so detection services physically cannot read hidden profiles (or, from 1b, ground truth).

CREATE TABLE sim.vehicle_profile (
  vin                  char(17) PRIMARY KEY REFERENCES core.vehicle (vin),
  coolant_offset_c     real NOT NULL,
  batt_temp_offset_c   real NOT NULL,
  lv_offset_v          real NOT NULL,
  efficiency           real NOT NULL CHECK (efficiency > 0),
  style                real NOT NULL CHECK (style > 0),
  naturally_hot        boolean NOT NULL,
  odo_base_km          double precision NOT NULL CHECK (odo_base_km >= 0)
);

-- One row: what is seeded, so seeding is skipped when (seed, n, t0) already match.
CREATE TABLE sim.seed_state (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  seed        text NOT NULL,
  n           integer NOT NULL CHECK (n > 0),
  t0          timestamptz NOT NULL,
  seeded_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA sim TO cw_sim;
