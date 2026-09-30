# Overnight report 2: Step 9 (evaluation, ML, load, tuning, observability)

Run: 2026-09-30 20:14 → 2026-10-01 (hard stop 07:30 IST). Plan: [docs/plans/s9.md](plans/s9.md).

## Done-check

| # | Part | Status | Numbers / evidence |
|---|---|---|---|
| 1 | `npm run eval:all` → [docs/evaluation.md](evaluation.md) | **done** | Every §6 row, 5K and 30K columns from bounded runs (clock paused at T0+88–89 h). 21 of 22 cells ✅; the 5K runaway cell is ⚠️ (global threshold 0.2 h earlier), explained in the cell. S1 18/18 with 0 intruders, S1b 8/8 separate, decoys 0, heatwave campaigns 0; late sisters 3/3 at-risk before their incident (lead 4.6–19.4 h at 5K, 16.6–19.4 h at 30K); queue precision@k 100% vs loudest-first 57% (5K) / 17% (30K); fix confirmation 15/15 correct at both N; reconcile balanced at both N (30K: 78,811 = 77,052 + 119 + 1,640) |
| 1b | Video helper | **done** | `demo:pause` / `demo:resume` (pausable sim clock across all workers; tested: T0+89.0213 held for 20 s), `demo:status` (6 story moments with URLs), [docs/video-runbook.md](video-runbook.md) with measured 30K wall times (S1 at 4:50, 3 at-risk sisters + proposal at 6:16, FIXED from 9:47, NOT_FIXED at 13:50) |
| 2 | ML at-risk classifier | ML_STATUS | ML_NUMBERS |
| 3 | Queue re-rank scaling | **done** | Hourly tick at 30K, same point of two runs (sim T0+87 h): mean **8.95 → 2.31 s**, p95 **27.5 → 5.7 s**. 100% of ticks now within one sim-hour (10 s at 360×), before 70%. [workshop.md](perf/workshop.md#s9-tick-scaling), ADR 0022 |
| 4 | k6 load + soak | **done** | 30K run, pipeline live. Load (ramp to 50 users): 31,201 requests, 173 req/s, **0 errors**, p95 383 ms, p99 511 ms. Soak (20 users, 10 min) + 50 SSE clients: 94,363 requests, 157 req/s, **0 errors**, p95 240 ms, p99 341 ms. SSE: 50/50 connected, 0 dropped, 75,100 events. [load.md](perf/load.md) |
| 5 | Query tuning | **done** | [docs/perf/queries.md](perf/queries.md): top 5 from `pg_stat_statements` at 30K. Workshop 24 h aggregate fleet-wide 6,145 → 1,279 ms (632K → 7.6K buffers). 6 h scores 2,743 → 210 ms (sort removed). Both applied. The continuous-aggregate refresh is analysed, and bounding its window is a recommendation, not a change |
| 6 | Chaos | CHAOS_STATUS | CHAOS_NUMBERS |
| 7 | Observability | **done** | Prometheus (every replica via DNS discovery, 11 targets up) + Grafana under profile `observability`, 8-panel provisioned dashboard, [screenshot](screenshots/5-grafana.png) |
| 8 | Pact | **done** | Consumer contract web → API (queue + campaign) in the CI unit job. The provider is verified against the real API + TimescaleDB in the integration job. The pact file is committed |

## Decisions I made (and why)

1. **Ran in the existing session**, not a new one: the S7/S8 context carried over and saved re-reading.
2. **Interruption.** The session was interrupted about 21:00–22:53. The 5K dev stack kept streaming to T0+997 h,
   and its evaluation (background incidents inflated by 40 days of sim time) was discarded. From then on every
   scored run is **bounded by pausing the sim clock** (the new `demo:pause`) at T0+88–89 h.
3. **Infrastructure trouble, handled.** Docker Desktop stopped twice (I restarted it). Docker Hub / npm had TLS and
   `ECONNRESET` timeouts, so builds retry with `COMPOSE_PARALLEL_LIMIT=2`. Other projects' containers on this machine
   were left alone.
4. **`eval:all` design.** The three scorecards were refactored into functions that return facts. `eval:all` saves
   `docs/eval/results-<N>.json` and renders `docs/evaluation.md` from every saved N. That way 5K and 30K come from
   separate runs and are re-renderable. N is read from the database (first version read the config file and mislabelled
   the 30K results; caught and fixed, the 5K file restored from git).
5. **Honest verdicts.** ✅/⚠️ per claim per N, computed, not hand-set. At 5K the global threshold's first alarm on the
   runaway came 0.2 h before our first incident, so that cell is ⚠️ with the reason in the cell. The "detection
   before failure" baseline states the cost of the global rule's earlier hits: 134–175 false alarms per 1,000
   healthy vans.
6. **Reconcile window after resuming.** With the clock paused no records flow, so the S2 count-in = count-out window
   is measured just after `demo:resume` (`eval:all --reconcile-only`).
7. **`pg_stat_statements`** is switched on through the compose `command` + an additive migration (014).
8. **Queue tick.** Telemetry changes in every depot every hour, so "which depots changed" cannot be known without
   reading them. The tick therefore reads **every depot's inputs in one batch**, re-ranks in memory and **writes only
   depots whose ranked queue changed**. EXPLAIN showed that a naive batch (30,000 VINs through the key) costs 6.1 s,
   so the fleet-wide reads use a time-range scan instead (1.3 s and 0.21 s).
9. **Continuous-aggregate policy not changed.** Bounding its refresh window changes data freshness for very late
   readings. It is written up as a recommendation in docs/perf/queries.md.
10. **ML stack.** Python 3.12 in the pinned Docker image (the host has 3.11). scikit-learn
    `HistGradientBoostingClassifier` rather than LightGBM (no extra native dependency). Labels come from the ground
    truth (which vans truly fail) with the timing of their first confirmed incident. No VIN, model id or driver
    features. Compared at a like-for-like operating point (as many van-hours flagged as the rule).
11. **Pact.** The Pact FFI panics on a regex matcher placed on the `content-type` header, so that matcher was dropped.
    The consumer contract runs in the CI unit job. The provider is verified against the real API + TimescaleDB in the
    integration job, and the pact file is committed.
12. **Load test.** Tokens come from the real OIDC flow (a Node helper), since k6 cannot do the browser flow. SSE
    clients run in Node (k6 has no built-in SSE). k6 runs in the pinned `grafana/k6` image on the compose network.
13. **Chaos.** A replica is killed with `docker kill --signal=SIGKILL` and started again with `docker start`, as an
    orchestrator would: Docker's restart policy does not restart a manually killed container.
14. **Grafana** runs with anonymous viewer access on :3001 (dev only), under the `observability` profile.

## Not deleted (for you to decide)

- `data/ml/*.csv.gz` (ML datasets, gitignored). Docker build cache (~12 GB reclaimable, `docker builder prune`).
