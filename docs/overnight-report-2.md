# Overnight report 2: Step 9 (evaluation, ML, load, tuning, observability)

Run: 2026-09-30 20:14 → 2026-10-01 (hard stop 07:30 IST). Plan: [docs/plans/s9.md](plans/s9.md).

## Done-check

_(filled in at the end)_

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
