# State processor performance and scorecard (step S3)

Measured 2026-09-30. Numbers are as measured, not tuned for show.

**Headline:** same real faults caught as a global threshold (35/35), with 4.1 vs 126 false incidents per 1,000
healthy vans; heatwave 3.6% vs 84%; runaway critical 5.8 h before limit.

**Hardware.** The same laptop as `normaliser.md`:
- 12th Gen Intel Core i7-1255U (2 performance + 8 efficiency cores, 12 threads, 15 W) and 32 GB RAM.
- Docker Desktop on WSL2 with 15 GiB visible; data disk on D:.
- The whole stack shares it: the broker (single Redpanda node), Redis, Postgres/Timescale, RustFS, the simulator
  (4 workers), 3 normaliser replicas and 3 state-processor replicas.

## Scorecard (`npm run eval:incidents`), N = 5,000, T0 → T0+72 h

"Ours" = state processor (own normal − peers, 4 of 6). "Global" = coolant > 97 °C or battery > 47 °C for the same
4 of 6 readings, run in shadow on the same readings. Real faults = S1 sisters, late sisters, S1b sisters, runaway,
scattered and same-depot decoys, and the bad-repair sister: 35 vans.

| role | vans | ours | ours % | global | global % | ours: onset→incident h (p50/max) | global: onset→hit h (p50/max) | critical | warning h |
|---|---|---|---|---|---|---|---|---|---|
| s1_sister | 14 | 14 | 100% | 14 | 100% | 21.9 / 22.6 | 21.9 / 26.2 | 2 | 20.8–24.6 |
| s1_late_sister | 3 | 3 | 100% | 3 | 100% | 26.8 / 27.9 | 11.1 / 34.7 | | |
| s1b_sister | 8 | 8 | 100% | 8 | 100% | 13.3 / 14.4 | 34.7 / 40.0 | | |
| runaway | 1 | 1 | 100% | 1 | 100% | 15.0 | 14.8 | **1** | **5.8** |
| decoy_scattered | 6 | 6 | 100% | 5 | 83% | 16.1 / 22.2 | 28.4 / 36.1 | | |
| decoy_same_depot_other_model | 2 | 2 | 100% | 2 | 100% | 24.3 / 29.5 | 24.7 / 30.0 | | |
| bad_repair | 1 | 1 | 100% | 1 | 100% | 22.3 | 27.4 | | |
| heatwave_region | 704 | 25 | **3.6%** | 593 | **84.2%** | – | 17.0 / 46.8 | 0 | |
| naturally_hot | 38 | 0 | 0% | 29 | 76.3% | – | – | | |
| sensor_glitch | 3 | 0 | 0% | 0 | 0% | – | – | | |
| loud_stable | 20 | 2 (DTC rate) | 10% | 4 | 20% | – | – | | |
| s1_healthy_cohort | 42 | 0 | 0% | 5 | 11.9% | – | – | | |
| background | 4,158 | 17 | 0.4% | 524 | 12.6% | – | – | 0 | |

Real faults caught: **35/35** by both. Background false incidents per 1,000 vans: **ours 4.1, global rule 126.0**.
Two runs from a clean start gave identical tables (detection is deterministic).

**Reading it.**
- **S1b** and the **decoys** are caught earlier than by the global rule. The **main S1 sisters tie** (22 h vs 22 h):
  onset is at 10:00 UTC, the vans park overnight with no coolant readings, and both rules fire on the first readings
  of day 2.
- The **late sisters** are caught later than by the global rule. Two of them run close to 97 °C, so the global
  threshold is crossed on day 1. S5's at-risk-sister rule is what will catch them early.
- The **runaway** is critical 5.8 h before its limit. The fast (3-h) trend still lags a quadratic rise.

## Batch job (`batch/baselines`, Python 3.12 + DuckDB 1.5.5)

| N | History rows scanned | Vans with their own baseline | Compute | Total (incl. S3 read + Postgres COPY) |
|---|---|---|---|---|
| 5,000 | 1,247,206 | 4,700 | 1.3 s | 1.6 s |
| 100,000 | 25,006,935 | 93,922 | 37.2 s | 58.7 s |

Vans without history (rental vans parked all week) use the model × duty × region cohort. Writing the 100K history
took 84 s.

## Throughput, lag and latency

### N = 5,000, demo 360×, 3 replicas: keeps up

| Metric | Value |
|---|---|
| Events processed T0 → T0+72 h | 705,380 in ~12 wall-min; ~980 events/s on average, 1,370/s at the 3× shift surge |
| Consumer lag | ≈ 0 in-process; the committed-offset lag in Redpanda is ≤ 13K (offsets are committed only after each 10-s checkpoint) |
| Event → applied latency (x-sent-at → state), T0 → T0+72 h | **p50 0.07 s, p95 0.16 s, p99 0.19 s** |
| Event → incident latency (x-sent-at of the confirming reading → Postgres + Kafka written) | Prometheus: p50 0.07 s, p95 0.18 s, p99 0.20 s; stored per incident: **p50 71 ms, p95 138 ms, p99 156 ms** (80 incidents) |
| Back-pressure pauses | 0 |
| Telemetry rows | 233,946 for 5,000 vans |

### N = 100,000, demo 360×, 3 replicas (one clean `down -v && up` with no `.env`, not tuned)

| Metric | Value |
|---|---|
| State processor, live (sim clock T0+8 → T0+20 h) | **5,660 events/s** over 3 replicas, against ~10K/s produced: the backlog grows (lag 90K → 196K) |
| Event → applied latency (x-sent-at → state) | p50 42 s at T0+8 h, 80 s at T0+20 h, then > 120 s (top bucket) |
| Event → incident latency (stored per incident, `core.incident.latency_ms`) | **p50 1,445 s, p95 2,346 s, p99 2,407 s** (375 incidents), dominated by the backlog |
| Back-pressure pauses (telemetry writer > 5,000 rows pending) | 37 by T0+20 h, ~110 by the end: the Postgres COPY of the hourly rows is the first limit inside the service |
| Drain after the simulator stopped | 6.6K events/s at first. It fell to 1.3–2K events/s while one replica was stuck (see below). After its restart that replica alone cleared 775K events in 154 s (≈ 5K events/s) |
| Canonical events processed | 6.47M (the whole topic), lag 0 at the end |
| Incidents | 375 in Postgres = 375 distinct ids in `incidents.v1` (638 messages incl. ESCALATE/CLOSE; 1 OPEN re-sent after a restart under the same id) |
| Restarts during the run | 1 planned SIGKILL (replica 2 at sim T0+36 h); 1 exit after a Docker DNS failure (`EAI_AGAIN postgres`, crash-only); 1 stuck replica restarted by hand. No duplicate incident rows (UNIQUE(vin, family, window) = 375/375) |
| Telemetry | 1,811,635 hourly rows for 99,999 vans; `npm run vehicle:normal` query in 13 ms |

**What limited the 100K run.**
1. **The simulator came first.** At the 3× shift surge (T0+24 h) it stalled for ~5 wall-min, then ran up to 377
   wall-s (~38 sim-h) behind its own clock. It was stopped when its clock showed T0+72 h, so it had only produced
   events up to about **T0+33 h**. So the 100K scorecard below covers T0 → T0+33 h; the late sisters (onset T0+24 h)
   fall outside it. The full T0+72 h evaluation is the 5K scorecard above.
2. **Inside the state processor, the telemetry writer came first.** One COPY + insert-on-conflict per flush into
   the hypertable, plus the continuous-aggregate refresh, could not keep up with ~5K new hourly rows per sim-hour,
   so back-pressure paused consumption repeatedly. Documented fallback (ADR 0008): keep hourly rows only for vans
   with open incidents; or run Postgres on its own cores.
3. **A bug, found and fixed.** After a Docker Desktop network glitch, one replica's partitions stalled for ~10 min on
   a call over a dead connection: no timeout, healthy status, 1% CPU. Fixed in `8cfbf79`: a per-batch watchdog
   (a batch not done in 120 s exits the process, and the restart recovers from the checkpoint), Postgres
   connection/query timeouts and keepalive, and a Redis command timeout.

### Scorecard at N = 100,000 (event time T0 → ~T0+33 h only)

| role | vans | ours | global | ours: onset→incident h (p50/max) | global: onset→hit h | critical | warning h |
|---|---|---|---|---|---|---|---|
| s1_sister | 14 | 14 | 11 | 22.3 / 23.0 | 22.8 / 25.5 | | |
| s1b_sister | 8 | 7 | 0 | 12.1 / 13.6 | – | | |
| s1_late_sister | 3 | 0 | 0 | – (outside the window) | – | | |
| runaway | 1 | 1 | 1 | 15.2 | 15.5 | 1 | 4.5 |
| decoy_scattered | 6 | 2 | 0 | 17.1 / 18.4 | – | | |
| decoy_same_depot_other_model | 2 | 2 | 0 | 14.9 / 15.2 | – | | |
| bad_repair | 1 | 1 | 1 | 22.1 | 22.3 | | |
| heatwave_region | 12,428 | 262 (2.1%) | 7,788 (62.7%) | – | 17.0 / 20.5 | 0 | |
| naturally_hot | 725 | 8 (1.1%) | 487 (67.2%) | – | – | | |
| sensor_glitch | 3 | 0 | 0 | – | – | | |
| loud_stable | 20 | 0 | 1 | – | – | | |
| s1_healthy_cohort | 42 | 0 | 0 | – | – | | |
| background | 86,747 | 77 | 1,800 | – | – | 0 | |

Background false incidents per 1,000 vans: **ours 0.9, global rule 20.7** (over ~33 sim-hours).

## Checkpoints

About 1.9 MB of JSON per partition (≈ 900 B per van), every 10 s per changed partition. The average write takes
~2 s, including waiting for the batch in progress on that partition.
