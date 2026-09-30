# API load and soak (S9)

**Setup.** 30K video preset (`SIM_SCALE=30000 SIM_SPEED=360 AUTO_REPAIRS=on`), the full pipeline streaming live
throughout (run B, after the S9 tick fix), on the dev laptop (Docker Desktop/WSL2, 12 CPUs, 16 GB for Docker).
`API_RATE_LIMIT_PER_MIN=1000000` for this run: k6 signs in as one user, and the default per-user limit
(600/min) would otherwise turn most requests into 429s. With the default limit, a 15 s smoke run at 5 users
got 80% 429s, which is the limiter working.

**Tools.**
- **k6** (`grafana/k6:0.54.0`) on the compose network: [tests/load/api.js](../../tests/load/api.js), started
  by [tests/load/run.sh](../../tests/load/run.sh). The token comes from the real OIDC flow (code + PKCE).
- **Mix:** 50% `GET /depots/:id/queue` (30 depots), 25% `GET /campaigns?status=OPEN`, 25% `GET /campaigns/:id`.
- **Every request is a full production request:** JWT check → one transaction as `cw_api` with the tenant set
  (RLS) → queries → an audit row and an outbox row (→ `audit.v1`) → JSON.
- **Profiles:** `load` ramps 1 → 10 → 25 → 50 virtual users over 3 min. `soak` holds 20 users for 10 min.
  During the soak, 50 SSE clients stay connected to `/events` ([sse-clients.mjs](../../tests/load/sse-clients.mjs)).

## Results (run B, 2026-10-01 02:06–02:20 IST, sim T0+87 → T0+166 h)

| Profile | Requests | Throughput | Errors | p50 | p95 | p99 | Max |
|---|---|---|---|---|---|---|---|
| **load**: ramp to 50 users, 3 min | 31,201 | **173 req/s** | **0** | 92 ms | **383 ms** | 511 ms | 747 ms |
| · queue | | | | 89 ms | 379 ms | 506 ms | 730 ms |
| · campaign list | | | | 72 ms | 354 ms | 470 ms | 615 ms |
| · campaign detail | | | | 115 ms | 424 ms | 554 ms | 747 ms |
| **soak**: 20 users, 10 min, + 50 SSE clients | 94,363 | **157 req/s** | **0** | 113 ms | **240 ms** | 341 ms | 774 ms |
| · queue | | | | 108 ms | 206 ms | 281 ms | 542 ms |
| · campaign list | | | | 89 ms | 172 ms | 239 ms | 582 ms |
| · campaign detail | | | | 155 ms | 313 ms | 430 ms | 774 ms |

All k6 thresholds held (errors < 1%, p95 < 1.5 s per endpoint).

**SSE during the soak:** 50 clients connected for 600 s: 50 connected, **0 failed, 0 dropped**. **75,100 events
delivered** (1,502 per client) plus 1,950 keep-alive pings. The median time to the first event was 5.3 s (the
first queue or card change after connecting).

**Reading it.**
- ~160–170 req/s with 0 errors while the whole 30K pipeline ingests live, and p95 stays under 0.4 s at 50 users.
  Every one of those requests also wrote an audit row and an outbox row, so this is also ~160 audit writes per
  second.
- **Latency bends with concurrency, not with time.** p95 rose from ~0.2 s (20 users) to ~0.4 s (50 users), with
  about the same throughput. The API is waiting on Postgres, which it shares with the live pipeline. Over the
  10-minute soak: 0 errors, 0 dropped SSE streams, and a max of 774 ms. These are totals only; per-minute
  percentiles were not recorded, so drift within the soak is not measured.
- **Throughput is capped by one API replica** (a single Node process) on a laptop that also runs the whole pipeline.
  The first lever would be more API replicas behind the proxy. The SSE bus is per instance and each instance has
  its own consumer group, so that already scales out.
- A realistic load is a few dozen planners, each board reloading once per SSE event (debounced), so a few requests
  per second. This test is about 50× that.
