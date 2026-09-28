-- 001: roles and schemas (brief §4.2).
-- Run by infra/db/migrate.sh as the superuser; passwords arrive as psql variables.
--   cw_sim : simulator. Read/write on sim.* and on the core registry tables.
--   cw_app : every later service. NO access to schema sim (ground truth / hidden profiles).

SELECT format('CREATE ROLE cw_sim LOGIN PASSWORD %L', :'cw_sim_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cw_sim') \gexec
SELECT format('CREATE ROLE cw_app LOGIN PASSWORD %L', :'cw_app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cw_app') \gexec

-- Nobody gets implicit rights through PUBLIC.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE cohortwatch FROM PUBLIC;
GRANT CONNECT ON DATABASE cohortwatch TO cw_sim, cw_app;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS sim;
REVOKE ALL ON SCHEMA core FROM PUBLIC;
REVOKE ALL ON SCHEMA sim FROM PUBLIC;

GRANT USAGE ON SCHEMA core TO cw_sim, cw_app;
GRANT USAGE ON SCHEMA sim TO cw_sim;
-- deliberately no GRANT on schema sim to cw_app

-- btree_gist lets EXCLUDE constraints combine "vin =" with "validity range &&".
CREATE EXTENSION IF NOT EXISTS btree_gist;
