# API latency at the 30K video preset (S7)

**Setup.** `SIM_SCALE=30000 SIM_SPEED=360`, full compose stack on the dev laptop (Docker Desktop, WSL2), measured
while the demo streams live (sim T0+30 h to T0+33 h: the S1 outbreak and the ingest surge, about 6–9K msgs/s).
Script: [`tests/perf/api-latency.mjs`](../../tests/perf/api-latency.mjs). It signs in through the real OIDC flow
(code + PKCE), then calls each endpoint N times with C requests in flight. Each request is a full production
request: JWT check → one transaction as `cw_api` with `SET LOCAL app.tenant_id` (RLS) → queries → audit row +
outbox row → JSON. 84 depots, 2 open campaigns at the time.

## Results (N = 300 per endpoint, 8 in flight, 0 errors)

| Endpoint | What it reads | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| `GET /depots/1/queue` | depot, queue items (≈ 15), cards, watching groups, bookings + audit | 306 | 669 | 1,061 |
| `GET /campaigns?status=OPEN` | keyset page of 25 + joins + audit | 176 | 345 | 556 |
| `GET /campaigns/:id` | campaign, 15 members, clues, at-risk, similar, history (outbox), notes, proposals + audit | 306 | 593 | 917 |

## Results, one request at a time (N = 100 per endpoint, 0 errors)

Same stack, a fresh 30K run at sim T0+28 h (live ingest running):

| Endpoint | p50 ms | p95 ms | max ms |
|---|---|---|---|
| `GET /depots/1/queue` | 26 | 53 | 125 |
| `GET /campaigns?status=OPEN` | 13 | 23 | 26 |
| `GET /campaigns/:id` | 31 | 58 | 81 |

The gap between the two tables is queueing: 8 concurrent requests against a Postgres that is also taking the
live telemetry and pipeline writes. A single board sees the second table.

## Reading it

- The numbers are taken **under the live ingest peak on one laptop**. Postgres is shared with the state
  processor's telemetry writer and the workshop/campaign transactions. 8 requests in flight is also far more
  than a board needs: one board reloads once per SSE event, debounced.
- Each request runs its queries **one after another in one transaction** (RLS needs the tenant set first; audit
  must commit with the read). `/depots/:id/queue` runs 7 queries plus 2 audit inserts, so its latency is
  mostly round trips under a busy database, not heavy queries. The per-depot and per-campaign queries are all
  index lookups (`queue_item (depot_id, rank)`, `campaign_member (campaign_id)`, keyset index on
  `(opened_ts, id)`).
- Target for the board: p95 < 1 s under load. This is met with margin on all three endpoints.

**Next if needed.** Run the independent read queries in parallel on two connections with the same
`app.tenant_id`, and cache `/depots` per tenant for one queue version. Neither is needed for the demo.
