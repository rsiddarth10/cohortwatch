-- S3: the telemetry writer COPYs into a session temp table and inserts with ON CONFLICT DO NOTHING (idempotent).
DO $$ BEGIN
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO cw_app', current_database());
END $$;
