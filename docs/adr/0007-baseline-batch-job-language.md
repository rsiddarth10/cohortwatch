# ADR 0007: The baseline batch job is Python 3.12 + DuckDB

- **Status:** accepted (S3, 2026-09-30)
- **Context:** "each van's normal" is learned from last week's history in the lake (Parquet on the S3-compatible
  object store). The brief names a DuckDB script; the S3 plan allowed Node with the existing DuckDB client if
  Python cost more than 30 minutes.

**Decision.** `batch/baselines` is Python 3.12 with DuckDB 1.5.5 (the same engine version as the Node client in
the simulator) and psycopg 3, in its own small container. It worked on the first container run, so the Node
fallback was not needed.
- DuckDB reads the Parquet straight from the object store (httpfs, installed at image build time) and reads the
  registry through its Postgres extension (`postgres_query`, because DuckDB cannot evaluate Postgres range functions).
- It writes everything in one Postgres transaction with COPY, as `cw_app`.
- It is idempotent: keyed by a hash of the history manifest and the job version, so a rerun on the same history is
  skipped.

**Consequences.** One more runtime (Python) in the repo, with its own CI job. Aggregations are SQL, which is short
and easy to check. At N = 5,000 it scans 1.25M rows in about 5 s.
