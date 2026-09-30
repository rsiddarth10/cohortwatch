-- S9: query statistics for tuning (docs/perf/queries.md). Needs pg_stat_statements in shared_preload_libraries
-- (compose sets it); creating the extension works either way.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
