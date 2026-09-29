# ADR 0004: Normaliser back-pressure thresholds

- **Status:** accepted (S2, 2026-09-29)
- **Context:** the normaliser must not buffer without bound when Kafka acknowledgements or Redis slow down.

**Decision.**
- Each batch awaits its produce acknowledgements before its state write and commit. So in-flight work is bounded
  by design: at most `CONCURRENCY` (8) batches of `BATCH_SIZE` (2,000) records, about 16K events per replica.
- On top of that, a 200 ms loop pauses every input partition when either:
  - more than `MAX_INFLIGHT_EVENTS` (50K) events are produced but not yet acknowledged, or
  - the Redis round trip (EWMA) exceeds `MAX_REDIS_MS` (250 ms).
- It resumes when both are below half their threshold.
- Each pause is logged and counted (`cw_norm_pauses_total{reason}`, `cw_norm_paused`).
- The thresholds are config, sized from what we measured: Redis round trips are about 1 ms, and the lag stays in
  single digits per partition at demo load.

**Consequences.**
- Under normal load pauses never trigger. They exist for a degraded broker or Redis, where the consumer stops
  fetching instead of growing memory. Kafka keeps the backlog, and lag shows it (`cw_norm_consumer_lag`).
- S9's chaos tests should exercise these paths (e.g. pause Redis) and confirm pause/resume and no loss.
