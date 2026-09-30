# Algorithms and SQL, on one page

Every algorithm in the pipeline, with pseudocode, time and space complexity, and the scale it was tested at. The code
is in `packages/domain` (pure, ≥ 80% test coverage) unless noted. *N* = vans, *m* = members, *d* = depots.

| # | Algorithm | Where | Complexity | Tested at |
|---|---|---|---|---|
| 1 | VIN check digit (ISO 3779) | `vin.ts` | O(17) per reading | 100K registry, every reading |
| 2 | DTC format + fault family | `canonical/validate.ts` | O(codes) | every reading |
| 3 | Anti-replay window | `canonical/antireplay.ts` | O(1), 128 B per VIN | 100K (Redis), mess plan |
| 4 | Exponentially weighted trend | `detect/ewtrend.ts` | O(1), 6 numbers | every reading, 100K |
| 5 | Robust z (median, MAD) | `detect/robust.ts` | O(1) per reading (baseline precomputed) | 100K |
| 6 | Peer adjustment | `detect/peer.ts` | O(1) per reading, O(cohorts) memory | 100K, heatwave plant |
| 7 | k-of-n confirmation | `detect/kofn.ts` | O(1), n-bit ring | 100K |
| 8 | Time to limit (runaway) | `detect/ttl.ts` | O(1) | runaway plant |
| 9 | Poisson guard | `campaign/poisson.ts` | O(k) for the tail | 100K, heatwave + background |
| 10 | Union-find (merge) | `campaign/unionfind.ts` | ≈ O(α(m)) per op | 30K |
| 11 | Feature-vector similarity | `campaign/similarity.ts` | O(P·F) | 30 synthetic past campaigns |
| 12 | Queue scoring + bay filling | `queue/queue.ts`, `queue/bookings.ts` | O(q log q) per depot | 30K, ~120 depots |
| 13 | Fix confirmation | `repair/confirm.ts` | O(h) per repair | 15 repairs incl. a bad one |

## 1. VIN check digit
```
value(c)  = transliteration table (A=1 … Z=9; I, O, Q invalid)
weights   = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2]
sum       = Σ value(vin[i]) · weights[i]
check     = sum mod 11 (10 → 'X');  valid ⇔ vin[8] = check
```
An invalid VIN goes to the DLQ with the reason. Never silently fixed.

## 2. DTC format and fault family
`^[PCBU][0-3][0-9A-F]{3}$` (SAE J2012 shape). A matching code is mapped to a fault family through the code catalogue
(COOLING, HV_BATTERY_THERMAL, LV_ELECTRICAL, …). A non-matching code is kept but flagged `INVALID_DTC`.

## 3. Anti-replay window (per VIN, IPsec/DTLS style)
```
state: maxSeq, bitmap[1024 bits]       # bit k set ⇔ seq maxSeq − k was seen
on seq s:
  if s > maxSeq: shift bitmap by s − maxSeq; maxSeq = s; set bit 0 → NEW
  elif maxSeq − s ≥ 1024: → LATE (forwarded, flagged; never silently dropped)
  elif bit (maxSeq − s) set: → DUPLICATE (dropped, counted in /ledger)
  else: set bit → NEW (out of order)
```
Batched per poll: one Redis `MGET` plus a Lua compare-and-set per batch, so concurrent replicas cannot both accept a
reading (ADR 0001).

## 4. Exponentially weighted least-squares trend (level + slope)
```
keep S=Σw, St=Σw·t, Stt=Σw·t², Sy=Σw·y, Sty=Σw·t·y, origin at the newest point
new point y after Δ hours: w = exp(−Δ/τ)
  S'=w·S+1  St'=w·(St−Δ·S)  Stt'=w·(Stt−2Δ·St+Δ²·S)  Sy'=w·Sy+y  Sty'=w·(Sty−Δ·Sy)
slope = (S·Sty − St·Sy) / (S·Stt − St²);  level = (Sy − slope·St) / S
```
This is a weighted least-squares fit where a point of age *a* has weight e^(−a/τ). O(1) per reading. Out-of-order
points are added at their own negative *t*.

## 5. Robust z against the van's own normal
```
baseline (batch, 7 days of history): median m, MAD for level; slope median and MAD
z_level = (level − m) / (1.4826 · max(MAD, floor))       # the floor stops a very steady van inflating z
z_slope = (slope − slope_median) / (1.4826 · max(slope_MAD, slope_floor))
```
The baselines come from the Python + DuckDB batch job over the lake: 25M history rows at 100K in 58.7 s
(docs/perf/state-processor.md).

## 6. Peer adjustment (cancel shared conditions)
```
peer(cohort, hour) = robust centre of the deviations of vans in the same model × duty × region, same hour
adjusted deviation = own deviation − peer
```
Each replica keeps a sampled estimate per cohort, with a region-wide fallback (ADR 0006). This turns a heatwave that
heats every van in a region into nothing: heatwave campaigns 0 at 5K and 30K (docs/evaluation.md).

## 7. k-of-n confirmation
Alarm when at least **k = 4 of the last n = 6** hourly checks are over the line (z_level ≥ 3, or z_slope ≥ 3 with
z_level ≥ 1.5), after a 25-minute warm-up. It is an n-bit ring per van and metric. A single spike never opens an
incident, and a run of rejected spikes that agree with each other is recognised as a real level change.

## 8. Time to limit (runaway)
`hours_to_limit = (hard_limit − level) / slope` when slope > 0. After a run of consecutive readings under the
critical number of hours the incident is marked **runaway** (one reading above resets the run; once critical, it
stays critical for the life of the incident). The workshop pins it to the top of today's bays and shows "≈ N h to 110 °C". Warning at 30K: 5.7 h
before the limit (critical), 11.7 h (first incident).

## 9. Poisson guard (is this group more than chance?)
```
λ = expected incidents for the key's cohort in the window
    = max(regional rate of the same cohort elsewhere, floor 2 per 1,000 van-days) × vans × days
p = P(X ≥ k | Poisson(λ)) = 1 − Σ_{i<k} e^(−λ) λ^i / i!
open a campaign ⇔ k ≥ 5 vans and p < α = 1e-4
```
Family key = fault family | model | duty | depot (ADR 0009). S1 opened with "15 vans where 0.3 expected".

## 10. Union-find (campaign merges)
Disjoint sets with path compression and union by rank. When two live groups share members or overlap, they are
unioned into the older campaign (MERGED keeps its history). Amortised ≈ O(α(m)) per operation.

## 11. Feature-vector similarity (similar past campaigns)
```
v = [family one-hot, model powertrain, duty, climate, member count (log), trend slope, firmware share, …]
similarity(a, b) = (a · b) / (|a| · |b|)     # cosine; top 3 of the past campaigns shown
```
Synthetic past campaigns (ADR 0013). S1 matches "coolant pump seal wear", 97% similar.

## 12. Queue scoring and bay filling
```
score = 0.35·severity + 0.25·trend(z_slope / 4, capped) + 0.2·campaign(members / 20)
        + 0.1·in_service_tomorrow + min(0.1, behaviour) + 0.15·not_fixed      (at-risk sisters: 0.5 × campaign)
runaways are pinned (ordered by hours to limit); the rest by score
fill today's bays, then tomorrow's (bays × slots per day); only score ≥ 0.4 or pinned take a bay
approved bookings (S8) take their slot after the runaways (queue/bookings.ts, also the agent's dry run)
```
O(q log q) per depot. The hourly tick batches every depot's reads (ADR 0022). Result: precision@k 100% vs 57% / 17%
for loudest-first (5K / 30K).

## 13. Fix confirmation
Judged on the post-repair **driven** hours of the fault's metric: FIXED if ≥ 6 of the last 8 driven hours are inside
|z| < 2, with ≥ 12 driven hours, within 48 sim-h. NOT_FIXED after 24 driven hours without FIXED. PENDING otherwise
(ADR 0017). Result: 15/15 correct at 5K and 30K, and the bad repair goes back to the queue.

## SQL: before and after (from docs/perf/queries.md)

Measured at 30K with `EXPLAIN (ANALYZE, BUFFERS)`:

| Query | Before | After | Change |
|---|---|---|---|
| Workshop 24 h codes + harsh aggregate, whole fleet | 30,000 key probes: **632,426 buffers, 6,145 ms** | time-range scan: **7,578 buffers, 1,279 ms** | no VIN list for fleet-wide reads |
| Workshop last 6 h of scores, whole fleet | 211,800 buffers + disk sort, 2,743 ms | 3,218 buffers, **210 ms** | time range + `ORDER BY ts DESC` (backward index scan, no sort) |
| Same, one depot (event path) | 2,053 buffers, 14–74 ms | unchanged probe, sort removed | a key probe is right for ~300 VINs |
| Hourly tick at 30K (effect) | mean 8.95 s, p95 27.5 s | mean **2.31 s**, p95 **5.7 s** | batch reads + write only changed depots |

Other SQL design points: RLS per request (`SET LOCAL app.tenant_id` in one transaction; ADR 0019). Keyset pagination
on `(opened_ts, id)` with a matching index. Outbox rows committed with the effect. TimescaleDB hypertable
compression after 7 days, and a continuous aggregate for the vehicle chart.
