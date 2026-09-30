-- S7/S8: the API's own role with row-level security by tenant, audit, agent proposals and notes, queue bookings
-- (an approved proposal), and erasure support. Internal services (cw_sim seeds with COPY, cw_app runs S3–S6) bypass
-- RLS: COPY FROM is not allowed on RLS tables for roles subject to it, and they are not user-facing. RLS applies to
-- cw_api, which serves users and sets app.tenant_id per request (ADR 0019).

SELECT format('CREATE ROLE cw_api LOGIN PASSWORD %L', :'cw_api_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cw_api') \gexec
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cw_api', current_database());
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO cw_api', current_database());
END $$;
ALTER ROLE cw_sim BYPASSRLS;
ALTER ROLE cw_app BYPASSRLS;
GRANT USAGE ON SCHEMA core TO cw_api;
GRANT SELECT ON ALL TABLES IN SCHEMA core TO cw_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO cw_api;

-- ---- new tables --------------------------------------------------------------------------------
CREATE TABLE core.audit (
  id           bigserial PRIMARY KEY,
  tenant_id    smallint NOT NULL REFERENCES core.tenant (id),
  at           timestamptz NOT NULL DEFAULT now(),
  actor        text NOT NULL,
  role         text NOT NULL,
  action       text NOT NULL,              -- e.g. VIEW, DISMISS, REPAIR, APPROVE, REJECT, ERASE
  resource     text NOT NULL,              -- e.g. depot_queue, campaign, vehicle
  resource_id  text,
  details      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_tenant_idx ON core.audit (tenant_id, id DESC);

CREATE TABLE core.proposal (
  id           uuid PRIMARY KEY,           -- uuid5(trigger): a replayed trigger never makes a second proposal
  tenant_id    smallint NOT NULL REFERENCES core.tenant (id),
  depot_id     integer REFERENCES core.depot (id),
  campaign_id  uuid REFERENCES core.campaign (id),
  trigger      text NOT NULL,              -- the event that caused it (campaign event id, card id)
  action_type  text NOT NULL CHECK (action_type IN ('BOOK_AT_RISK', 'MOVE_RUNAWAY')),
  title        text NOT NULL,
  body         text NOT NULL,
  evidence     jsonb NOT NULL,             -- [{source, id, text}]: cited clues and numbers only
  diff         jsonb NOT NULL,             -- dry-run of the queue change: [{vin, from, to}] + summary
  payload      jsonb NOT NULL,             -- what approval applies: [{vin, slot}]
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  version      integer NOT NULL DEFAULT 1,
  created_by   text NOT NULL DEFAULT 'agent',
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> created_by)   -- the agent never approves its own proposals
);
CREATE INDEX proposal_pending_idx ON core.proposal (tenant_id, created_at DESC) WHERE status = 'PENDING';

CREATE TABLE core.agent_note (
  id           bigserial PRIMARY KEY,
  tenant_id    smallint NOT NULL REFERENCES core.tenant (id),
  campaign_id  uuid REFERENCES core.campaign (id),
  vin          char(17) REFERENCES core.vehicle (vin),
  kind         text NOT NULL CHECK (kind IN ('NOTE', 'INSPECT_NEXT_VISIT')),
  text         text NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, campaign_id, vin)
);

-- An approved proposal books vans into a slot; the workshop places them first ("booked by lead").
CREATE TABLE core.queue_booking (
  depot_id     integer NOT NULL REFERENCES core.depot (id),
  vin          char(17) NOT NULL REFERENCES core.vehicle (vin),
  slot         text NOT NULL CHECK (slot IN ('TODAY', 'TOMORROW')),
  proposal_id  uuid REFERENCES core.proposal (id),
  booked_by    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (depot_id, vin)
);

ALTER TABLE core.driver ADD COLUMN erased_at timestamptz;
ALTER TABLE core.alert_card ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE INDEX campaign_keyset_idx ON core.campaign (opened_ts DESC, id DESC) WHERE status IN ('OPEN', 'DISMISSED', 'CLOSED');

GRANT SELECT, INSERT, UPDATE, DELETE ON core.proposal, core.agent_note, core.queue_booking, core.audit TO cw_app;
GRANT SELECT ON core.proposal, core.agent_note, core.queue_booking, core.audit TO cw_api, cw_sim;
GRANT INSERT ON core.audit, core.outbox, core.campaign_override, core.queue_booking TO cw_api;
GRANT UPDATE ON core.outbox TO cw_api; -- its relay publishes audit.v1 / agent.proposals.v1 rows
GRANT UPDATE ON core.campaign, core.proposal, core.driver, core.alert_card TO cw_api;
GRANT DELETE ON core.driver_assignment TO cw_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO cw_api, cw_app;

-- ---- row-level security (cw_api only; the owner and BYPASSRLS roles are unaffected) -------------
CREATE FUNCTION core.current_tenant() RETURNS smallint LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::smallint $$;
CREATE FUNCTION core.depot_tenant(integer) RETURNS smallint LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT f.tenant_id FROM core.depot d JOIN core.fleet f ON f.id = d.fleet_id WHERE d.id = $1 $$;
CREATE FUNCTION core.vin_tenant(char) RETURNS smallint LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT tenant_id FROM core.vehicle WHERE vin = $1 $$;
CREATE FUNCTION core.campaign_tenant(uuid) RETURNS smallint LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT core.depot_tenant(depot_id) FROM core.campaign WHERE id = $1 $$;
CREATE FUNCTION core.incident_tenant(uuid) RETURNS smallint LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT core.vin_tenant(vin) FROM core.incident WHERE id = $1 $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('vehicle',          'tenant_id = core.current_tenant()'),
    ('depot',            'core.depot_tenant(id) = core.current_tenant()'),
    ('workshop_bay',     'core.depot_tenant(depot_id) = core.current_tenant()'),
    ('driver',           'EXISTS (SELECT 1 FROM core.fleet f WHERE f.id = fleet_id AND f.tenant_id = core.current_tenant())'),
    ('driver_assignment','core.vin_tenant(vin) = core.current_tenant()'),
    ('incident',         'core.vin_tenant(vin) = core.current_tenant()'),
    ('incident_clue',    'core.incident_tenant(incident_id) = core.current_tenant()'),
    ('campaign',         'core.depot_tenant(depot_id) = core.current_tenant()'),
    ('campaign_member',  'core.campaign_tenant(campaign_id) = core.current_tenant()'),
    ('campaign_at_risk', 'core.campaign_tenant(campaign_id) = core.current_tenant()'),
    ('campaign_clue',    'core.campaign_tenant(campaign_id) = core.current_tenant()'),
    ('campaign_similar', 'core.campaign_tenant(campaign_id) = core.current_tenant()'),
    ('campaign_override','core.campaign_tenant(campaign_id) = core.current_tenant()'),
    ('queue_item',       'core.depot_tenant(depot_id) = core.current_tenant()'),
    ('queue_version',    'core.depot_tenant(depot_id) = core.current_tenant()'),
    ('queue_snapshot',   'core.depot_tenant(depot_id) = core.current_tenant()'),
    ('queue_booking',    'core.depot_tenant(depot_id) = core.current_tenant()'),
    ('alert_card',       'core.depot_tenant(depot_id) = core.current_tenant()'),
    ('repair',           'core.vin_tenant(vin) = core.current_tenant()'),
    ('repair_outcome',   'core.vin_tenant(vin) = core.current_tenant()'),
    ('proposal',         'tenant_id = core.current_tenant()'),
    ('agent_note',       'tenant_id = core.current_tenant()'),
    ('audit',            'tenant_id = core.current_tenant()')
  ) AS t(tbl, expr) LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON core.%I TO cw_api USING (%s) WITH CHECK (%s)', r.tbl, r.expr, r.expr);
  END LOOP;
END $$;
