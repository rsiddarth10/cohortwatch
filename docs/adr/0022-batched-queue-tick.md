# ADR 0022: The hourly queue tick reads the whole fleet in one batch and writes only changed depots

- **Status:** accepted (S9, 2026-10-01)
- **Context:** the S4 tick rebuilt every depot's queue once per sim-hour, each in its own transaction with 7 reads.
  At 30K (~120 depots) it took 5–30 s per tick, while a sim-hour lasts 10 wall-seconds at 360×. At 100K
  (~400 depots) it would fall behind. Hourly telemetry changes every depot, so "rebuild only depots whose inputs
  changed" cannot be decided without reading the inputs.

**Decision.**
- The tick loads the inputs of **all depots in one batch** (7 queries). It re-ranks each depot **in memory** with
  the same pure functions, and opens a write transaction **only for depots whose ranked queue differs** from the
  stored one (or whose top is a runaway).
- Fleet-wide telemetry reads use the **time range only** (no VIN list), newest first. Passing 30,000 VINs to
  `vin = ANY(…)` probes the primary key per VIN: 632K buffers, 6.1 s. The range scan takes 7.6K buffers and 1.3 s
  (docs/perf/queries.md).
- **Races:** if an event rebuilt a depot between the batch read and its write (its `queue_version` moved), that
  depot falls back to the per-depot path with fresh inputs, under the same row lock.
- The **event path is unchanged**: one depot, the key probe (right for ~300 VINs), one transaction.

**Consequences.** The number of reads per tick no longer grows with the number of depots, and writes happen only
where the queue changed. Memory per tick grows with the fleet (the last 6 h of scores and 24 h aggregates, about
120K + 30K rows at 30K), which is fine at 100K. The tick is still one process (the advisory-lock leader). Sharding
it by depot range is the next step if a fleet ever outgrows one leader.
