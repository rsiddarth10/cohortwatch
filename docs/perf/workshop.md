# Workshop (S4 queue + S6 fix confirmation): performance and scorecard

Measured 2026-09-30 on the same laptop as the other perf docs:
- i7-1255U, 32 GB RAM, Docker Desktop/WSL2 with 15 GiB visible;
- the whole stack on one machine;
- 1 workshop replica.

Both runs used `AUTO_REPAIRS=on`: the 15 main S1 sisters, including the bad-repair one, were repaired at T0+30 h.
Runs are judged by the **produced horizon** (the latest hourly telemetry row).

## Scorecard (`npm run eval:workshop`)

Queue questions use each depot's queue as it stood at **T0+29 h** (S1 open, before the repairs), from
`core.queue_snapshot`. True-risk set = S1 sisters, late sisters, S1b sisters, runaway, decoys, bad repair.
Loudest-first = rank by fault codes in the last 24 h.

| Check | Expected | N = 5,000 (horizon T0+87 h) | N = 30,000 video preset (horizon T0+90 h) |
|---|---|---|---|
| Queue vs loudest-first, precision@k at D-001 (k = today's bays) | ours clearly higher | **100%** vs 57% (k = 7) | **100%** vs 17% (k = 6) |
| Precision@50 fleet-wide | ours clearly higher | **34%** vs 4% | **36%** vs 4% |
| Loud-but-stable | none above any S1 sister | 0 times above an S1 sister at the same depot (whole run); 10 ever queued, 0 ever in today's bays | 0 times; 10 ever queued, 0 in today's bays |
| Runaway | rank 1 in its depot; critical → top | rank 1; **0.04 s** from the critical incident written to rank 1 | rank 1; **0.02 s** (3 runaway cards: 13–38 ms) |
| Late sisters | in the queue (at-risk) before their own incident | **3/3**, lead 31.6, 16.3, 43.4 h | **3/3**, lead 18.4, 15.0, 17.0 h |
| Fix confirmation (vs ground truth `repair_outcome`) | repaired sisters FIXED; bad repair NOT_FIXED | truth fixed: **14 FIXED**, 0 NOT_FIXED, 0 PENDING · truth not_fixed: 0 FIXED, **1 NOT_FIXED** | the same: 14 / 1, no errors |
| Bad repair back in the queue | yes, with the reason | rank 1 (TODAY): "repair on 2026-09-29 did not hold" | rank 2 (TODAY), same reason |
| Campaign close | S1 stays OPEN | OPEN: 14 of 18 fixed (bad repair + 3 unrepaired late sisters) | OPEN: 14 of 18 fixed |
| Heatwave / naturally hot | not in today's bays | heatwave **4** vans, naturally hot **0** (ever, any snapshot) | heatwave **3**, naturally hot **3** |
| Cards | runaways and new/growing campaigns only | CAMPAIGN_OPENED 2, CAMPAIGN_GREW 16, RUNAWAY 1 | OPENED 2, GREW 16, RUNAWAY 3 |

"All members FIXED → campaign CLOSED" is shown by the campaign-engine integration test and a BDD scenario; in the
demo S1 correctly stays open.

**Tuning (≈ 15 of the 30 minutes).** The first 5K run put **106** heatwave vans into today's bays at some point.
- 79 of them were **solo at-risk** vans: no incident, but a steep z_slope maxed their trend term. At-risk-only vans
  now count at half weight for severity and trend ("at a lower weight", brief §1.3.1), so they are queued and
  shown but never take a bay.
- The rest were flat heatwave incidents scoring 0.35–0.38. The bay threshold went from 0.35 to **0.40**. Among
  incident vans, that cut the heatwave from 16 to 4 at a cost of 3 of 29 true-risk vans (their earliest hours only).
- What remains (3–4 heatwave vans, 0–3 naturally-hot) are **HIGH-severity solo incidents raised by S3**. The queue
  has no way to tell them from a real solo fault: they rank on the incident. S3's heatwave residual (3.6% at 5K)
  is where to fix it. I did not tune further.

**Restart.** At produced T0+40 h (30K) the workshop was SIGKILLed and restarted. Afterwards: 15 repairs, 15 outcomes,
15 outcome outbox rows, 21 cards (unique ids), 188 queue items = 188 unique (depot, VIN), 0 unpublished; no duplicate
anywhere.

## Latency

| Metric | N = 5,000 | N = 30,000 (after the restart, T0+40 → T0+90 h) |
|---|---|---|
| Incident written (`x-incident-at`) → its depot's queue version committed | p50 **49 ms**, p95 96 ms, p99 100 ms (119 updates) | p50 **90 ms**, p95 194 ms, p99 665 ms |
| Critical incident → rank 1 | 65 ms (Prometheus), 0.04 s (card) | 13–38 ms (3 cards) |
| Consumed event (transaction incl. rebuild) | p50 42 ms, p95 95 ms | p50 83 ms, p95 196 ms |
| Outbox row → Kafka | mean 141 ms | p50 153 ms, p95 283 ms |
| Hourly tick (fix confirmation + every depot) | p50 **0.59 s**, p95 1.07 s (20 depots) | p50 **4.7 s**, p95 9.4 s (~120 depots) |
| Queue versions written | 1,246 | 1,833 (after the restart) |

**Reading it.**
- The event path is fast: a critical incident reaches the top of its depot in tens of milliseconds after S3 writes it.
- The hourly tick is the thing to watch. At 30K it re-ranks ~120 depots with 6 queries each, taking 4.7–9.4 s,
  and a sim-hour is 10 wall-seconds at 360×. It kept up, but at 100K (~400 depots) it would not.
- The fix is known and not done in this step: re-rank only depots whose inputs changed since the last tick
  (repairs, new at-risk rows), and batch the telemetry reads across depots.
