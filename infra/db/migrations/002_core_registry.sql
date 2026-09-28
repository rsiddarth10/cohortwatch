-- 002: core registry, 3NF (brief §4.2 [1a]).
-- Deliberate denormalisation: vehicle.tenant_id duplicates fleet.tenant_id so row-level security (S7)
-- can filter on the vehicle row alone. A composite FK (fleet_id, tenant_id) keeps the two consistent.

CREATE TABLE core.tenant (
  id    smallint PRIMARY KEY,
  code  text NOT NULL UNIQUE,
  name  text NOT NULL
);

CREATE TABLE core.subscription (
  id         integer PRIMARY KEY,
  tenant_id  smallint NOT NULL REFERENCES core.tenant (id),
  plan       text NOT NULL CHECK (plan IN ('ENTERPRISE', 'GROWTH', 'STARTER')),
  valid      tstzrange NOT NULL CHECK (NOT isempty(valid)),
  EXCLUDE USING gist (tenant_id WITH =, valid WITH &&)
);

CREATE TABLE core.fleet (
  id         integer PRIMARY KEY,
  tenant_id  smallint NOT NULL REFERENCES core.tenant (id),
  name       text NOT NULL,
  UNIQUE (id, tenant_id)
);

-- Climate belongs to the region, not the depot (3NF: depot -> region -> climate).
CREATE TABLE core.region (
  id              smallint PRIMARY KEY,
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  climate_zone    text NOT NULL CHECK (climate_zone IN ('HOT_DRY', 'HOT_HUMID', 'TEMPERATE', 'COLD')),
  ambient_mean_c  numeric(4, 1) NOT NULL,
  ambient_amp_c   numeric(4, 1) NOT NULL
);

CREATE TABLE core.depot (
  id          integer PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  fleet_id    integer NOT NULL REFERENCES core.fleet (id),
  region_id   smallint NOT NULL REFERENCES core.region (id),
  lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon         double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  geohash5    char(5) NOT NULL,
  size_class  text NOT NULL CHECK (size_class IN ('S', 'M', 'L', 'XL'))
);
CREATE INDEX depot_region_idx ON core.depot (region_id);

CREATE TABLE core.workshop_bay (
  id          integer PRIMARY KEY,
  depot_id    integer NOT NULL REFERENCES core.depot (id),
  bay_no      smallint NOT NULL CHECK (bay_no > 0),
  capability  text NOT NULL CHECK (capability IN ('EV', 'ICE', 'ANY')),
  UNIQUE (depot_id, bay_no)
);

CREATE TABLE core.oem (
  id              smallint PRIMARY KEY,
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  wmi             char(3) NOT NULL UNIQUE,
  payload_format  text NOT NULL
);

CREATE TABLE core.vehicle_model (
  id          smallint PRIMARY KEY,
  oem_id      smallint NOT NULL REFERENCES core.oem (id),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  powertrain  text NOT NULL CHECK (powertrain IN ('EV', 'DIESEL', 'HYBRID'))
);

CREATE TABLE core.duty_type (
  id               smallint PRIMARY KEY,
  code             text NOT NULL UNIQUE CHECK (code IN ('URBAN', 'LINEHAUL', 'RENTAL', 'FIELD', 'YARD')),
  name             text NOT NULL,
  active_hours     numeric(4, 1),          -- null = variable (rental)
  load_factor      numeric(3, 2) NOT NULL
);

CREATE TABLE core.firmware_release (
  id           integer PRIMARY KEY,
  model_id     smallint NOT NULL REFERENCES core.vehicle_model (id),
  version      text NOT NULL,
  released_at  timestamptz NOT NULL,
  UNIQUE (model_id, version)
);

CREATE TABLE core.vehicle (
  vin            char(17) PRIMARY KEY CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  tenant_id      smallint NOT NULL,
  fleet_id       integer NOT NULL,
  model_id       smallint NOT NULL REFERENCES core.vehicle_model (id),
  duty_type_id   smallint NOT NULL REFERENCES core.duty_type (id),
  model_year     smallint NOT NULL CHECK (model_year BETWEEN 2000 AND 2100),
  registered_at  timestamptz NOT NULL,
  in_service     boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'DECOMMISSIONED')),
  FOREIGN KEY (fleet_id, tenant_id) REFERENCES core.fleet (id, tenant_id)
);
CREATE INDEX vehicle_model_duty_idx ON core.vehicle (model_id, duty_type_id);
CREATE INDEX vehicle_tenant_idx ON core.vehicle (tenant_id);

-- History tables use validity ranges, so a depot transfer never rewrites the past.
CREATE TABLE core.vehicle_depot_assignment (
  vin       char(17) NOT NULL REFERENCES core.vehicle (vin),
  depot_id  integer NOT NULL REFERENCES core.depot (id),
  valid     tstzrange NOT NULL CHECK (NOT isempty(valid)),
  PRIMARY KEY (vin, valid),
  EXCLUDE USING gist (vin WITH =, valid WITH &&)
);
-- "who is at this depot now": partial index on open-ended assignments
CREATE INDEX vda_current_depot_idx ON core.vehicle_depot_assignment (depot_id) WHERE upper_inf(valid);

CREATE TABLE core.vehicle_firmware_history (
  vin           char(17) NOT NULL REFERENCES core.vehicle (vin),
  firmware_id   integer NOT NULL REFERENCES core.firmware_release (id),
  installed_at  timestamptz NOT NULL,
  PRIMARY KEY (vin, installed_at)
);
CREATE INDEX vfh_firmware_idx ON core.vehicle_firmware_history (firmware_id, installed_at);

-- Pseudonym only: no names, phone numbers or licence numbers anywhere.
CREATE TABLE core.driver (
  id         integer PRIMARY KEY,
  fleet_id   integer NOT NULL REFERENCES core.fleet (id),
  pseudonym  text NOT NULL UNIQUE
);

CREATE TABLE core.driver_assignment (
  driver_id  integer NOT NULL REFERENCES core.driver (id),
  vin        char(17) NOT NULL REFERENCES core.vehicle (vin),
  valid      tstzrange NOT NULL CHECK (NOT isempty(valid)),
  PRIMARY KEY (driver_id, valid),
  EXCLUDE USING gist (vin WITH =, valid WITH &&),
  EXCLUDE USING gist (driver_id WITH =, valid WITH &&)
);

-- Table only in 1a; filled from the stream in S3.
CREATE TABLE core.trip (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vin          char(17) NOT NULL REFERENCES core.vehicle (vin),
  driver_id    integer REFERENCES core.driver (id),
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  distance_km  numeric(8, 2),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (vin, started_at)
);

-- Table only in 1a; used by the API in S7.
CREATE TABLE core.app_user (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     smallint NOT NULL REFERENCES core.tenant (id),
  oidc_sub      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('lead', 'planner', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Registry tables: the simulator owns their contents; services only read them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant', 'subscription', 'fleet', 'region', 'depot', 'workshop_bay', 'oem', 'vehicle_model',
    'duty_type', 'firmware_release', 'vehicle', 'vehicle_depot_assignment', 'vehicle_firmware_history',
    'driver', 'driver_assignment'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON core.%I TO cw_sim', t);
    EXECUTE format('GRANT SELECT ON core.%I TO cw_app', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.trip, core.app_user TO cw_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO cw_app;
