# Overnight report: step S3 done-check (2026-09-30)

**Headline:** same real faults caught as a global threshold (35/35), with 4.1 vs 126 false incidents per 1,000
healthy vans; heatwave 3.6% vs 84%; runaway critical 5.8 h before limit.

Details: [docs/perf/state-processor.md](perf/state-processor.md). S4 not started.

## Done-check

| # | Check | Result |
|---|---|---|
| 1 | `docker compose down -v && up` at N = 100,000, no `.env` | ✅ History: 25.0M rows in 84 s. **Batch baselines: 25,006,935 rows scanned, 93,922 vans with their own baseline, 37.2 s compute, 58.7 s total.** State processor healthy (3 replicas), incidents flowing (375) |
| 2 | `eval:incidents` | ✅ at 5K, T0 → T0+72 h (table below): S1 14/14, late 3/3, S1b 8/8; runaway critical 5.8 h before its limit; heatwave 3.6% vs 84% global; naturally-hot 0% vs 76%; glitch 0; background 4.1 vs 126 per 1,000. ⚠️ At 100K the run covers only event time T0 → ~T0+33 h (the simulator fell behind, see below), so the late sisters are outside it; everything inside the window matches (table in the perf doc) |
| 3 | Incidents in Kafka and Postgres; a restart creates no duplicates | ✅ 100K: 375 rows in `core.incident` = 375 distinct ids in `incidents.v1` (638 messages incl. ESCALATE/CLOSE; one OPEN re-sent after a restart under the same id). 3 replica restarts during the run (1 planned SIGKILL, 1 crash on a Docker DNS failure, 1 stuck replica) → still 375/375 unique. Testcontainers itest: crash with nothing committed → replay → exactly one incident, same id |
| 4 | Telemetry hypertable populated; one van's "vs own normal" query | ✅ 100K: 1,811,635 hourly rows for 99,999 vans; `npm run vehicle:normal -- --vin 7KSHM1D80RK100052` (an S1 sister) returns its hours vs its band (92.2 °C, 90.0–94.5) and marks day 2 ABOVE, in 13 ms |
| 5 | Perf numbers incl. event → incident latency | ✅ 5K keeps up: e2e p50/p95/p99 0.07/0.16/0.19 s; event → incident p50 71 ms, p95 138 ms, p99 156 ms. ⚠️ 100K does **not** keep up at 360× on this laptop: 5.7K events/s live vs ~10K/s produced; event → incident p50 1,445 s, p95 2,346 s, p99 2,407 s (backlog). Recorded as-is, not tuned |
| 6 | Unit + integration tests, coverage ≥ 80% on the new domain modules, CI | ✅ 192 unit tests; 3 integration tests (Redpanda + Redis + Timescale); `packages/domain/src/detect` 99% lines / 94% branches; Python batch test in CI. CI green on the S3 commits checked (last check before the final push) |
| 7 | ADRs, solution snippets, README, walkthrough | ✅ ADRs 0005–0008; `docs/solution/sections.md` §6.5 (S3 algorithms + complexity) and §11 AI/ML; README (status, services, commands, settings); `docs/learning/step-3.md` (15 lines) |
| 8 | `docker compose stop`, this report | ✅ Stack stopped. Disk: **C: 33.8 GB free, D: 210.5 GB free** |

## Scorecard at T0+72 h (N = 5,000; two clean runs gave identical tables)

| role | vans | ours | global | ours: onset→incident h (p50/max) | global: onset→hit h | critical | warning h |
|---|---|---|---|---|---|---|---|
| s1_sister | 14 | 14 | 14 | 21.9 / 22.6 | 21.9 / 26.2 | 2 | 20.8–24.6 |
| s1_late_sister | 3 | 3 | 3 | 26.8 / 27.9 | 11.1 / 34.7 | | |
| s1b_sister | 8 | 8 | 8 | 13.3 / 14.4 | 34.7 / 40.0 | | |
| runaway | 1 | 1 | 1 | 15.0 | 14.8 | 1 | 5.8 |
| decoy_scattered | 6 | 6 | 5 | 16.1 / 22.2 | 28.4 / 36.1 | | |
| decoy_same_depot_other_model | 2 | 2 | 2 | 24.3 / 29.5 | 24.7 / 30.0 | | |
| bad_repair | 1 | 1 | 1 | 22.3 | 27.4 | | |
| heatwave_region | 704 | 25 (3.6%) | 593 (84.2%) | – | 17.0 / 46.8 | 0 | |
| naturally_hot | 38 | 0 | 29 (76.3%) | – | – | | |
| sensor_glitch | 3 | 0 | 0 | – | – | | |
| loud_stable | 20 | 2 (DTC rate) | 4 | – | – | | |
| s1_healthy_cohort | 42 | 0 | 5 | – | – | | |
| background | 4,158 | 17 | 524 | – | – | 0 | |

Background false-incident rate per 1,000 vans: **ours 4.1, global rule 126.0**.

## 100K numbers (one run, not tuned)

| Metric | Value |
|---|---|
| Batch baselines | 25,006,935 rows, 93,922 vans, 37.2 s compute / 58.7 s total |
| State processor, live | 5,660 events/s over 3 replicas vs ~10K/s produced; lag 90K → 196K between sim T0+8 and T0+20 h |
| Event → applied latency | p50 42 s (T0+8 h) → 80 s (T0+20 h) → > 120 s |
| Event → incident latency (stored) | p50 1,445 s, p95 2,346 s, p99 2,407 s |
| Drain after the simulator stopped | 6.47M canonical events processed in total, lag 0 at the end; one replica alone ~5K events/s |
| Back-pressure pauses (telemetry writer) | ~110 |
| Scorecard (event time T0 → ~T0+33 h) | S1 14/14 (global 11), S1b 7/8 (global 0), runaway critical 4.5 h before limit, heatwave 2.1% vs 62.7%, naturally-hot 1.1% vs 67.2%, glitch 0, background 0.9 vs 20.7 per 1,000 |

## What went wrong or is still weak (for the morning)

1. **The 100K run is limited by the laptop.**
   - The simulator stalled at the 3× shift surge and ended up ~38 sim-h behind its own clock. I stopped it when its
     clock said T0+72 h, but it had only produced events up to ~T0+33 h. Next time, stop by the produced horizon
     (the simulator's `lagS`), not by its clock.
   - Inside the state processor, the telemetry writer (Postgres COPY + continuous aggregate) is the first
     bottleneck. The fallback is in ADR 0008.
2. **A bug found and fixed (`8cfbf79`).** After a Docker Desktop network glitch, one replica stalled ~10 min on a
   dead connection (healthy status, 1% CPU). It now has a per-batch watchdog (exit and restart after 120 s),
   Postgres and Redis timeouts, and retries a failed checkpoint load. The unit and integration tests pass, but the
   fix has **not been re-run at 100K**.
3. **Late sisters** are caught later than by the global rule (27 h vs 11 h p50). Per the brief they are for S5's
   at-risk-sister rule (noted in `docs/learning/step-3.md`).
4. **Runaway warning** is 5.8 h (4.5 h at 100K); the fast trend lags a quadratic rise. Two S1 sisters are marked
   critical 21–25 h before their limit. Not tuned (time box).
5. **Heatwave residual:** 3.6% of the region is flagged, but none become critical.

## Commits this session (on `main`, pushed)

- **Domain detection core:** `6467b78`
- **Migrations:** `2c000db` (005), `aedaf44` (006), `797aaef` (007)
- **Service scaffold, lint fix:** `077fb97`
- **Batch job:** `73c9644`
- **Service core + scorecard:** `01a61a5`
- **Fixes from your review:** `aedaf44` (runaway gating, region cohort, loud_stable in history, global lag),
  `7e20cb1` (peer-adjusted baseline spread)
- **Telemetry writer:** `97704dd`
- **Integration test + ADRs + snippets:** `4a35098`
- **Watchdog:** `8cfbf79`
- **Docs:** the final commit
