-- S4 + S6: the daily workshop queue per depot (current + point-in-time snapshots), alert cards, repairs and their
-- confirmed outcomes, and idempotency for the workshop service. Changes leave through core.outbox (topics
-- queue.events.v1 and workshop.outcomes.v1).

-- Current queue of a depot; replaced as a whole on each new version.
CREATE TABLE core.queue_item (
  depot_id    integer NOT NULL REFERENCES core.depot (id),
  vin         char(17) NOT NULL REFERENCES core.vehicle (vin),
  rank        integer NOT NULL,
  slot        text NOT NULL CHECK (slot IN ('TODAY', 'TOMORROW', 'WAITING')),
  score       double precision NOT NULL,
  pinned      boolean NOT NULL,
  parts       jsonb NOT NULL,                 -- score components (for the "why", never shown as the reason)
  reasons     jsonb NOT NULL,                 -- [{type, text}] phrases
  cost_inr    integer NOT NULL,
  cost_text   text NOT NULL,
  version     integer NOT NULL,
  PRIMARY KEY (depot_id, vin)
);
CREATE INDEX queue_item_rank_idx ON core.queue_item (depot_id, rank);

-- Version per depot: the UI shows "changed since you last looked".
CREATE TABLE core.queue_version (
  depot_id    integer PRIMARY KEY REFERENCES core.depot (id),
  version     integer NOT NULL,
  as_of_ts    timestamptz NOT NULL,           -- event time the queue was computed for
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every version's ranked list, for point-in-time questions ("who was in today's bays at T0+29 h?").
CREATE TABLE core.queue_snapshot (
  depot_id    integer NOT NULL REFERENCES core.depot (id),
  version     integer NOT NULL,
  as_of_ts    timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  items       jsonb NOT NULL,                 -- [{vin, rank, slot, score, pinned, reasons: [type]}]
  PRIMARY KEY (depot_id, version)
);
CREATE INDEX queue_snapshot_ts_idx ON core.queue_snapshot (as_of_ts);

-- Cards for the agent (S7/S8): only runaways and new/growing campaigns. Solo incidents enter the queue quietly.
CREATE TABLE core.alert_card (
  id                   uuid PRIMARY KEY,      -- uuid5(type, subject): a replay never makes a second card
  card_type            text NOT NULL CHECK (card_type IN ('RUNAWAY', 'CAMPAIGN_OPENED', 'CAMPAIGN_GREW', 'CAMPAIGN_REOPENED')),
  depot_id             integer REFERENCES core.depot (id),
  vin                  char(17) REFERENCES core.vehicle (vin),
  campaign_id          uuid REFERENCES core.campaign (id),
  incident_id          uuid,
  title                text NOT NULL,
  body                 text NOT NULL,
  event_ts             timestamptz NOT NULL,  -- event time of the cause
  source_written_at    timestamptz,           -- wall time the incident / campaign event was written upstream
  queue_top_at         timestamptz,           -- wall time the van reached rank 1 of its depot (runaways)
  status               text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'SEEN', 'DONE')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Repairs (from workshop.repairs.v1) and their confirmed outcome (S6).
CREATE TABLE core.repair (
  id            uuid PRIMARY KEY,             -- uuid5(vin, repaired_at)
  vin           char(17) NOT NULL REFERENCES core.vehicle (vin),
  repaired_ts   timestamptz NOT NULL,         -- event time
  fault_family  text,                         -- the fault being fixed (its open incident / campaign), if any
  metric        text,                         -- the metric judged (coolant_c, batt_temp_c, lv_batt_v)
  status        text NOT NULL CHECK (status IN ('REPAIRED', 'PENDING', 'FIXED', 'NOT_FIXED')),
  driven_hours  integer NOT NULL DEFAULT 0,
  text          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repair_open_idx ON core.repair (vin) WHERE status IN ('REPAIRED', 'PENDING');

CREATE TABLE core.repair_outcome (
  repair_id     uuid PRIMARY KEY REFERENCES core.repair (id),
  vin           char(17) NOT NULL REFERENCES core.vehicle (vin),
  outcome       text NOT NULL CHECK (outcome IN ('FIXED', 'NOT_FIXED')),
  decided_ts    timestamptz NOT NULL,         -- event time of the newest driven hour used
  driven_hours  integer NOT NULL,
  text          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for every consumed event (incidents, campaign events, repairs): a replay is a no-op.
CREATE TABLE core.processed_event (
  source        text NOT NULL,
  id            text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.queue_item, core.queue_version, core.queue_snapshot, core.alert_card,
  core.repair, core.repair_outcome, core.processed_event TO cw_app;
GRANT SELECT ON core.queue_item, core.queue_version, core.queue_snapshot, core.alert_card, core.repair,
  core.repair_outcome TO cw_sim;
