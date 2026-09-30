-- S5: campaigns ("the same fault spreading through a group of sister vans"), members (join once), at-risk sisters,
-- clues, overrides, similar past campaigns (pgvector) and the transactional outbox.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per group of a family key (fault family | model | duty | depot). WATCHING groups are rows too, so
-- touching windows merge the same way (union-find, persisted as merged_into).
CREATE TABLE core.campaign (
  id             uuid PRIMARY KEY,                           -- uuid5(family_key, first bucket)
  family_key     text NOT NULL,
  fault_family   text NOT NULL REFERENCES core.fault_family (code),
  model_id       smallint NOT NULL REFERENCES core.vehicle_model (id),
  duty_type_id   smallint NOT NULL REFERENCES core.duty_type (id),
  depot_id       integer NOT NULL REFERENCES core.depot (id),
  region_id      smallint NOT NULL REFERENCES core.region (id),
  status         text NOT NULL CHECK (status IN ('WATCHING', 'OPEN', 'DISMISSED', 'MERGED', 'CLOSED')),
  first_bucket   integer NOT NULL,
  last_bucket    integer NOT NULL,
  first_ts       timestamptz NOT NULL,                       -- event time of the first member's incident
  last_ts        timestamptz NOT NULL,
  opened_ts      timestamptz,                                -- event time it opened
  opened_at      timestamptz,                                -- wall time it opened (latency)
  merged_into    uuid REFERENCES core.campaign (id),
  member_count   integer NOT NULL DEFAULT 0,                 -- denormalised for the board
  at_risk_count  integer NOT NULL DEFAULT 0,
  lambda         double precision,
  p_value        double precision,
  rate_source    text,
  dismissal      jsonb,                                      -- {atMembers, by, reason, ts, runawaySince}
  cost_inr       bigint,
  version        integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_live_key_idx ON core.campaign (family_key) WHERE status NOT IN ('MERGED', 'CLOSED');
CREATE INDEX campaign_open_idx ON core.campaign (opened_ts) WHERE status = 'OPEN';

-- Join once: PRIMARY KEY (campaign, vin); and a van is in at most one live campaign per fault family.
CREATE TABLE core.campaign_member (
  campaign_id        uuid NOT NULL REFERENCES core.campaign (id),
  vin                char(17) NOT NULL REFERENCES core.vehicle (vin),
  fault_family       text NOT NULL REFERENCES core.fault_family (code),
  active             boolean NOT NULL DEFAULT true,
  first_incident_id  uuid NOT NULL,
  joined_ts          timestamptz NOT NULL,                   -- event time of its first incident
  runaway            boolean NOT NULL DEFAULT false,
  deviation          double precision,
  slope_per_h        double precision,
  last_code          text,
  firmware           text,
  PRIMARY KEY (campaign_id, vin)
);
CREATE UNIQUE INDEX campaign_member_one_live_idx ON core.campaign_member (vin, fault_family) WHERE active;

-- At-risk sisters: first_ts is the EVENT time of the hourly score that first flagged the van.
CREATE TABLE core.campaign_at_risk (
  campaign_id  uuid NOT NULL REFERENCES core.campaign (id),
  vin          char(17) NOT NULL REFERENCES core.vehicle (vin),
  active       boolean NOT NULL DEFAULT true,
  first_ts     timestamptz NOT NULL,
  last_ts      timestamptz NOT NULL,
  reason       text NOT NULL,
  PRIMARY KEY (campaign_id, vin)
);

CREATE TABLE core.campaign_clue (
  campaign_id  uuid NOT NULL REFERENCES core.campaign (id),
  ord          smallint NOT NULL,
  clue_type    text NOT NULL,
  text         text NOT NULL,
  value        double precision NOT NULL,
  unit         text NOT NULL,
  PRIMARY KEY (campaign_id, ord)
);

CREATE TABLE core.campaign_override (
  id           bigserial PRIMARY KEY,
  campaign_id  uuid NOT NULL REFERENCES core.campaign (id),
  action       text NOT NULL CHECK (action IN ('DISMISS')),
  by_user      text NOT NULL,
  reason       text NOT NULL,
  members_at   integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Synthetic, fictional past campaigns (declared in docs/DECLARATIONS.md) with a 31-dim feature vector.
CREATE TABLE core.past_campaign (
  id            uuid PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  year          smallint NOT NULL,
  fault_family  text NOT NULL,
  powertrain    text NOT NULL,
  duty          text NOT NULL,
  climate       text NOT NULL,
  members       integer NOT NULL,
  deviation     double precision NOT NULL,
  slope_per_h   double precision NOT NULL,
  codes         text[] NOT NULL,
  root_cause    text NOT NULL,
  resolution    text NOT NULL,
  embedding     vector(31) NOT NULL
);
CREATE INDEX past_campaign_embedding_idx ON core.past_campaign USING hnsw (embedding vector_cosine_ops);

CREATE TABLE core.campaign_similar (
  campaign_id       uuid NOT NULL REFERENCES core.campaign (id),
  rank              smallint NOT NULL,
  past_campaign_id  uuid NOT NULL REFERENCES core.past_campaign (id),
  similarity        double precision NOT NULL,
  PRIMARY KEY (campaign_id, rank)
);

-- Transactional outbox: written in the same transaction as the campaign change; a relay publishes to
-- campaign.events.v1 (key = campaign_id) and marks published_at. id = event_id = uuid5(campaign, type, version).
CREATE TABLE core.outbox (
  id            uuid PRIMARY KEY,
  topic         text NOT NULL,
  key           text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished_idx ON core.outbox (created_at) WHERE published_at IS NULL;

-- Idempotency: an incident action (a replay after a crash, a duplicate delivery) is applied once.
CREATE TABLE core.processed_incident_action (
  incident_id   uuid NOT NULL,
  action        text NOT NULL,
  seq           bigint NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, action, seq)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.campaign, core.campaign_member, core.campaign_at_risk, core.campaign_clue,
  core.campaign_override, core.past_campaign, core.campaign_similar, core.outbox, core.processed_incident_action TO cw_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO cw_app;
-- the evaluation job (cw_sim) reads detection output
GRANT SELECT ON core.campaign, core.campaign_member, core.campaign_at_risk, core.campaign_clue, core.campaign_override,
  core.past_campaign, core.campaign_similar, core.outbox TO cw_sim;
