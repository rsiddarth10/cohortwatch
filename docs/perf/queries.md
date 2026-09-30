# Query tuning (S9)

**Method.** `pg_stat_statements` is on in compose (`shared_preload_libraries`, migration 014). At the end of a
30K video-preset run (run A, `AUTO_REPAIRS=on`, sim T0+87 h, before any tuning), I ranked the statements by total
execution time, then ran `EXPLAIN (ANALYZE, BUFFERS)` on the top ones. Inputs: one depot's VINs (depot 1, 294 vans)
and the whole fleet (30,000 VINs), with `at` = 2026-10-01T20:00Z. Timings come from the same live stack while it
was still ingesting, so absolute numbers are noisy. Buffer counts are the stable measure.

## Top statements by total time (run A, before)

| # | Statement | Calls | Total | Mean | Max |
|---|---|---|---|---|---|
| 1 | workshop: 24 h codes + harsh aggregate per depot (`sum(dtc_count) … GROUP BY vin`) | 9,023 | 162 s | 18.0 ms | 302 ms |
| 2 | workshop: last 6 h of hourly scores per depot (`… ORDER BY vin, ts DESC`) | 9,023 | 86 s | 9.5 ms | 214 ms |
| 3 | TimescaleDB continuous-aggregate refresh (`INSERT INTO _materialized_hypertable_2 …`) | 8 | 43 s | 5.3 s | 11.7 s |
| 4 | state processor: telemetry `COPY` into a staging table | 479 | 40 s | 84 ms | 5.6 s |
| 5 | state processor: load all `vehicle_baseline` rows (start / reload) | 45 | 22 s | 481 ms | 4.5 s |

Numbers 1 and 2 run once per depot per queue rebuild. That is every incident or campaign event, plus the hourly
tick over ~120 depots: 9,023 calls each.

## 1. 24 h aggregate: VIN probe → time-range scan (fleet-wide)

| Variant | Plan | Buffers | Time |
|---|---|---|---|
| one depot (294 VINs), before | Index Scan on the chunk's `(vin, ts)` key, `vin = ANY(…)` | 6,149 | 95–226 ms |
| **whole fleet via VIN list** (what batching the tick would do naively) | same, 30,000 probes | **632,426** | **6,145 ms** |
| **whole fleet, rewritten: time range only** | Seq Scan on the current chunk + `ts` index on the previous one, partial hash aggregates | **7,578** | **1,279 ms** |

The key probe costs about 1.4 buffers per row. For a whole-fleet read, the planner still probes the key once per
VIN, 30,000 times. Dropping the VIN list turns it into one pass over the last 24 h of chunks.

## 2. 6 h scores: same rewrite, and no sort on the VIN

| Variant | Buffers | Time |
|---|---|---|
| one depot, before (`ORDER BY vin, ts DESC` sorts on `vin::text`) | 2,053 | 14–74 ms |
| whole fleet via VIN list | 211,800 (+ 1,000 temp pages: the sort spilled) | 2,743 ms |
| whole fleet, time range, same sort | 3,224 (+ 1,000 temp) | 1,146 ms |
| **whole fleet, time range, `ORDER BY ts DESC`** (backward `ts` index scan, no sort node) | **3,218** | **210 ms** |

The code groups rows per VIN in memory and only needs "newest first", so the `ORDER BY vin` was an unnecessary
sort on the text cast.

**Applied** (commit `bba8c7b`, `services/workshop/src/workshop.ts`). The hourly tick now reads every depot's inputs in
one batch. Rows 1 and 2 use the time-range form: fleet-wide ~1.5 s together instead of ~9 s, and 2 calls per
tick instead of ~240. The per-depot event path keeps the key probe, which is right for 300 VINs, and also lost the sort.

## 3. Continuous-aggregate refresh (TimescaleDB background job): analysed, not changed

The policy is `start_offset => NULL, end_offset => 1 h, every 5 min` (migration 005). With `NULL`, any late reading
(the simulator's offline bursts and out-of-order mess) invalidates old buckets. The next refresh then
re-materializes them. The 5–12 s runs were the first refreshes during the ingest surge. After that the job settled
(6 runs, last one 0.15 s). It runs in the background and no request waits for it.

**Recommendation, not applied overnight:** `start_offset => INTERVAL '2 days'` would bound every refresh. The
trade-off is data freshness: a reading more than 2 days late would then not reach the hourly view. The plants never
produce that, but this is a policy decision for the owner, not a tuning tweak.

## 4–5. Left as they are

- **Telemetry `COPY` (84 ms mean):** bulk load of ~3,400 rows per call. The 5.6 s max coincides with the
  continuous-aggregate refresh and the surge. This is the designed write path (S3 perf doc).
- **Baseline load (481 ms mean):** a full read of 59,200 rows (`Seq Scan`, 832 buffers, 162 ms when measured
  alone). It happens once per state-processor start or reload, never per event.

The effect on the hourly tick (before/after at 30K) is in [workshop.md](workshop.md#s9-tick-scaling).
