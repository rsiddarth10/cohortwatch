-- 004: step 1b simulator-private tables. All in schema sim (cw_app has no access).

-- Registry parameters are part of what is seeded (e.g. the healthy offset sd changed in 1b).
ALTER TABLE sim.seed_state ADD COLUMN IF NOT EXISTS registry_hash text;

-- Every plant choice and timing (brief 5.4), plus scenario-level entries (heatwave, surge, thresholds).
CREATE TABLE sim.scenario_manifest (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scenario_hash  text NOT NULL,
  scenario_id    text NOT NULL,
  role           text NOT NULL,
  vin            char(17) REFERENCES core.vehicle (vin),
  depot_id       integer REFERENCES core.depot (id),
  onset_ts       timestamptz,
  params         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX scenario_manifest_scenario_idx ON sim.scenario_manifest (scenario_id);

-- Brief 5.7. Also written to data/sim-private/ground_truth.parquet.
CREATE TABLE sim.ground_truth (
  vin                char(17) PRIMARY KEY REFERENCES core.vehicle (vin),
  scenario_id        text,
  role               text NOT NULL,
  fault_family       text,
  onset_ts           timestamptz,
  late               boolean NOT NULL DEFAULT false,
  limit_ts           timestamptz,
  expected_campaign  text,
  repair_outcome     text CHECK (repair_outcome IN ('fixed', 'not_fixed'))
);
CREATE INDEX ground_truth_role_idx ON sim.ground_truth (role);

-- Where the simulated clock is, so a restart resumes instead of replaying the scenario.
CREATE TABLE sim.run_state (
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  scenario_hash     text NOT NULL,
  mode              text NOT NULL,
  speed             double precision NOT NULL,
  sim_ts            timestamptz NOT NULL,
  auto_repairs_done boolean NOT NULL DEFAULT false,
  transfers_done    boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Repairs received on workshop.repairs.v1 (replayed into the model after a restart).
CREATE TABLE sim.repair_log (
  vin           char(17) NOT NULL REFERENCES core.vehicle (vin),
  repaired_at   timestamptz NOT NULL,
  effective_at  timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vin, repaired_at)
);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA sim TO cw_sim;
