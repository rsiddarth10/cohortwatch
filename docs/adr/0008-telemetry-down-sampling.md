# ADR 0008: Telemetry is down-sampled to one row per van per sim-hour

- **Status:** accepted (S3, 2026-09-30)
- **Context:** the S8 vehicle chart shows a van against its own normal. Storing every reading (about 10K/s at
  100K and 360×) would make Postgres a second bottleneck next to the broker on the laptop.

**Decision.** The state processor writes one row per van per `TELEMETRY_BUCKET_MIN` (default 60) sim-minutes to
the `core.telemetry` hypertable:
- the row holds the means of the readings detection uses (plus maxima, SoC, ambient, speed and code count);
- the hypertable has 1-day chunks, compression segmented by VIN, and the continuous aggregate
  `core.telemetry_hourly` (real-time, so buckets ahead of the wall clock are visible);
- rows are written with COPY into a staging table, then `INSERT … ON CONFLICT DO NOTHING`, so replays never
  duplicate a row.

The documented fallback, if even this cannot keep up at 100K, is to keep only the hourly rows for vans with open
incidents.

**Consequences.** Raw readings stay in Kafka (and history in the lake); the database holds what the chart needs.
A bucket in progress during a restart can end up partial (its earlier readings were before the committed
offset); the chart shows it as a low reading count. The aggregate is hourly regardless of the bucket size, so a
smaller bucket (e.g. 15 min) needs no query change.
