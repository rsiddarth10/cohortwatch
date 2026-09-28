# CohortWatch — Project Brief (the constitution)

This file is the source of truth for scope. `CLAUDE.md` points here.
- **Hard requirements:** `docs/hackathon-problem-statement.pdf` (§6 Challenge, §7 Technical Expectations, §8 Data, §9 Algorithms, §11 NFRs, §12 Testing, §13 Deliverables, §14 Rules).
- **Detail reference only:** `docs/reference-plan.pdf` (schemas, algorithms, edge cases). If it disagrees with this brief, **this brief wins**.
- **Scope rule:** build only the current step. Items tagged **[1a]**, **[1b]**, **[S3]** and so on belong to that step.

---

## 1. Product

### 1.1 Pitch
**CohortWatch — the daily workshop queue that ranks vans by real risk, and catches shared outbreaks early.**

- **Primary user:** fleet manager (reliability lead).
- **Secondary users:** workshop planner (runs the daily queue); depot manager (viewer, sees less).
- **Not users:** banks, insurers, traffic teams, driver scoring.

**Problem.** A 100,000-vehicle fleet sends endless weak signals. Each one alone is noise, so workshops fix whoever is loudest. The expensive failures are usually **shared**: same model, depot, duty or software update, with vans drifting away from their own normal in the same way. That is only visible across the fleet. Snapshots also hide vans that are getting worse. Industry: about 7 weeks from first report to confirmed root cause for shared field issues.

### 1.2 Core engine
- Compare **each vehicle to its own normal**: its usual level and usual trend per signal, learned only from healthy periods.
- Subtract what **peers in the same context** (region, duty, hour) are doing.
- Require the deviation to persist for **k of the last n readings**.
- Then raise an **INCIDENT** with plain-language clues, e.g. "coolant 9 °C above its normal", "rising 3× its usual rate", "P0217 5× in 24 h (usual 0)", "peers at this depot are normal today".

### 1.3 Consumers of incidents

**1. Workshop queue** (daily use) **[S4]**
- Ranked per depot by severity, trend, campaign size, runaway flag, in-service-tomorrow, and a capped behaviour weight.
- Includes solo incidents, campaign members, and at-risk vans (at a lower weight).
- Fills today's and tomorrow's bays in rank order.
- Each item shows its reasons and a rough cost of waiting (rates in config).
- A loud-but-stable van ranks below a quiet van that is getting worse.

**2. Runaway alert** **[S3/S4]**
- Estimates hours until a hard limit from the smoothed trend. Only computed when the trend exceeds a configured minimum rate.
- If under 12 h for several consecutive readings, the van is marked **critical**: it goes to the top of the queue and gets an agent card.
- **Alert discipline:** solo incidents enter the queue quietly. Only runaways and new or growing campaigns raise cards.

**3. Campaigns** (headline feature) **[S5]**
- **Family key:** fault family | model | duty | depot (corridor for linehaul), within an **event-time** window.
- **Opening:** a campaign opens only with **≥ 5 distinct vans AND a Poisson tail vs the expected rate < α** (with a floor on the expected λ). Below that, the group shows only in a "watching" strip.
- **Membership:** each van **joins once**, enforced by database uniqueness.
- **Merging:** touching windows merge via union-find. Campaigns at different depots are never merged.
- **At-risk sisters:** vans with the same profile and trend that have not yet crossed their line.
- **Firmware clue:** e.g. "16/18 got 4.2.1 in the 3 days before onset, vs 48% of healthy peers".
- **Similar past campaigns:** found by vector search.
- **Money:** "cost if not fixed ≈ ₹X".
- **Override:** "not an outbreak" is sticky. The campaign is re-raised only if it gets materially worse.

**4. Fix confirmation** **[S6]**
- When a van is marked repaired, watch its next 24–48 sim-hours.
- Back inside its normal band → **fixed ✓**. Otherwise → **not fixed**, and it goes back up the queue.
- A van not driven since the repair shows as "pending".
- A campaign closes only when its members are confirmed fixed.

### 1.4 Agent, roles and privacy **[S7/S8]**
- **The agent lives on the board**, not in a chat tab:
  - It gathers evidence, dry-runs the queue change, then applies polite actions itself or raises cards for disruptive ones.
  - It never approves its own proposals, never invents clues, and every action is audited.
  - The board keeps working with the agent off.
- **Roles:**
  - **Lead:** everything, including approvals.
  - **Planner:** the queue.
  - **Viewer:** summaries only; no driver IDs and no precise locations.
- Every view is audited.

### 1.5 What the extra inputs may and may not change
| Input | May change | Must not become |
|---|---|---|
| Behaviour (speed, harsh events, idle) | Whether a pattern is real; a small capped queue weight | A driver-punishment score |
| Trend of health | Urgency, clues, runaway, at-risk | A research model with no queue |
| Place context (depot, region, weather) | Who counts as a sister; peer adjustment | A traffic map |
| Model, duty, software version | Family key; firmware clue | An OTA rollout product |

If a feature does not change **incident, membership or queue rank**, it is out of scope.

### 1.6 Edge cases (system-wide)
- **Family key:**
  - Too wide → one city-wide campaign. Too narrow → sisters never meet.
  - Never put behaviour in the key.
  - Two depots in the same week must not merge.
  - The same fault code in a different context stays out.
- **Baseline:**
  - Freeze learning while a van is sick.
  - k-of-n confirmation absorbs single-tick noise.
  - Ignore impossible jumps (e.g. charge rising while driving, sensor spikes).
  - New vans use their model × duty cohort baseline.
  - A repair resets the van's normal.
- **Runaway:** ignore tiny trends (no "limit in 400 h" flicker). The flag must persist across readings.
- **Time:** always use event time, never the wall clock. Bucket splits are merged by union-find.
- **Counting:**
  - A duplicate note counts once.
  - Two incidents from one van in one window make one member.
  - A crash leads to redelivery, not a clone.
  - A depot transfer mid-story keeps the van in its campaign and does not rewrite history.
- **People:**
  - Not every event is a card.
  - Clues are phrases, not scores.
  - Overrides are sticky.
  - When two users click at once, one wins and the other re-reads.
  - Viewers never see raw location trails.
- **Honesty:**
  - Report measured throughput, not the number of IDs.
  - Detection code never reads the ground truth.

### 1.7 Project "done" (these become BDD scenarios)
1. With the plant on, a campaign opens on the sisters.
2. The decoys stay out, and the heatwave opens nothing.
3. One more sister → the count goes up, with no second campaign.
4. The clues mention trend and shared place.
5. The queue ranks outbreak vans and the runaway above loud-but-stable vans.
6. The runaway jumps to the top with a critical card within seconds.
7. Duplicate or late notes never clone a member.
8. The repaired van is confirmed fixed, the bad-repair van returns to the queue, and the campaign closes only when its members are fixed.
9. An override survives the next tick.
10. A viewer cannot see precise locations, and every view is audited.
11. A stranger can run `docker compose up` and retell the story in 5 minutes.

---

## 2. Stack and rules

### 2.1 Stack
- **Node 22 LTS + TypeScript (strict)** for all services: simulator, normaliser, state processor, campaign engine, and the API (Express + zod + zod-to-openapi + helmet + express-rate-limit).
- **Libraries:**
  - Kafka: `@confluentinc/kafka-javascript` (see the fallback in 2.3).
  - Schema registry: `@kafkajs/confluent-schema-registry` **[S2+]**.
  - Postgres: `pg` + `pg-copy-streams`. Redis: `ioredis`.
  - Parquet writing: `@duckdb/node-api` **[1b]**.
  - Seeded random numbers: `pure-rand`.
- **Python 3.12** only for batch, ML and evaluation (DuckDB first; PySpark local mode later) **[S3/S9]**.
- **Infrastructure (pin exact tags, never `latest`):**
  - Redpanda: `docker.redpanda.com/redpandadata/redpanda:v24.2.7` (Kafka API + built-in schema registry).
  - Redpanda Console: `docker.redpanda.com/redpandadata/console:v2.7.2`.
  - Postgres: `postgres:16.4` **[1a–S2]**. Switch to `timescale/timescaledb-ha:pg16` (TimescaleDB + pgvector) in **[S3]** and reseed.
  - Redis: `redis/redis-stack-server:7.4.0-v1`.
  - If a tag fails to pull, pin the nearest existing patch version and record it in the README.
- Named volumes for Postgres and Redpanda. `docker compose down -v` is the clean reset.
- npm-workspaces monorepo. React + Vite for the web app **[S8]**.

### 2.2 Rules
- **Hexagonal design:** pure domain logic lives in `packages/domain` (no framework or infrastructure imports) and is unit-tested with Vitest at ≥ 80% coverage.
- **Determinism:** config-driven and seeded. Per-VIN RNG seed = hash(global_seed, VIN), so output is identical for any number of worker processes.
- **Delivery:** at-least-once delivery with idempotent effects everywhere.
- **Clocks:** simulated event time is **never** mixed with wall-clock time. Latency is always measured in wall-clock time.
- **No leaks:** detection code **never** reads ground truth or simulator-private data. This is enforced by a separate DB schema and role, not by convention.
- **Synthetic data only:**
  - Fictitious OEMs: "Aurex" (OEM-A) and "Kestrel" (OEM-B).
  - Synthetic coordinates, no real addresses.
- **Declarations:** `docs/DECLARATIONS.md` is maintained from day one (open-source libraries, AI tools used and what for).
- Small, clear commits after each working piece.
- **CI** (GitHub Actions) runs on every push from step 1a: install → lint → typecheck → unit tests + coverage.
- **Scale:** the `SIM_SCALE` env var sets the number of vehicles.
  - Dev loop: 5,000.
  - **Compose default: 100,000** (demo and submission).
  - All checks compare against the configured N, never a hard-coded 100,000.

### 2.3 Risk fallbacks
- **Kafka client:** if `@confluentinc/kafka-javascript` does not install and produce within ~30 minutes, switch to `kafkajs` for that service and record the switch as an ADR in `docs/adr/`.
- **Scope:** if a step runs long, finish its done-check with fewer features rather than starting the next step.

---

## 3. Build order (one session per step; each must pass its done-check before the next)

| Step | Scope |
|---|---|
| **1a** | Monorepo + compose (pinned) + migrations + registry seeding + **healthy** signal model + both OEM formats streaming live + tests + CI |
| **1b** | Plants, mess injection, clock modes (demo 360×, bench, burst, reset), history Parquet, ground truth, `simulator:verify` |
| **S2** | Normaliser: adapters, validation, VIN check digit, DTC → fault family, unit conversion, per-VIN anti-replay dedup (Redis), DLQ → `telemetry.canonical.v1` (Avro via registry) |
| **S3** | State processor: EW trend (O(1) sums in Redis), baselines from history (DuckDB script), peer adjustment, k-of-n, incidents + clues, time-to-limit / runaway; switch to the Timescale image |
| **S4** | Queue: scoring, at-risk, runaway, bay assignment, cost of waiting |
| **S5** | Campaign engine: family key, Poisson guard, join once, union-find, at-risk sisters, firmware clue, money, outbox |
| **S6** | Fix confirmation (`workshop.repairs.v1`) |
| **S7** | API: JWT roles, Postgres RLS, keyset pagination, rate limits, audit, SSE, viewer masking |
| **S8** | Web UI (board + queue panel, campaign page, vehicle-vs-own-normal chart) + template agent |
| **S9** | Batch + evaluation (Section 6), throughput + chaos tests, BDD, full CI |

---

## 4. Infrastructure and schema

### 4.1 Kafka topics (all created once by `topic-init`; key = VIN unless noted)
| Topic | Partitions | Retention | Used from |
|---|---|---|---|
| `raw.oem-a.v1` | 24 | 3 d | 1a |
| `raw.oem-b.v1` | 24 | 3 d | 1a |
| `telemetry.canonical.v1` | 48 | 3 d | S2 |
| `telemetry.dlq.v1` | 6 | 14 d | S2 |
| `incidents.v1` (key = family key) | 24 | 14 d | S3 |
| `campaign.events.v1` (key = campaign_id) | 12 | 30 d | S5 |
| `agent.proposals.v1` | 6 | 30 d | S8 |
| `audit.v1` | 6 | 90 d | S7 |
| `workshop.repairs.v1` | 3 | 7 d | 1b (simulator listens), S6 |

### 4.2 Database (migrations)

**Schema `core` (3NF)**, covering the brief's example tables (Fleet, Vehicle, Driver, Trip, Alert, Subscription):

- **[1a]**
  - `tenant`, `subscription` (tenant plan, validity range), `fleet`
  - `depot` (region_id, climate_zone, synthetic lat/lon centre, geohash5, size_class), `workshop_bay`
  - `oem`, `vehicle_model` (oem, powertrain EV/DIESEL/HYBRID), `duty_type`, `firmware_release`
  - `vehicle` (VIN primary key with a regex check; tenant, fleet, model, duty, in_service, status)
  - `vehicle_depot_assignment` (tstzrange + EXCLUDE overlap constraint), `vehicle_firmware_history`
  - `driver` (pseudonym only), `driver_assignment` (tstzrange)
  - `trip` (table only; filled in S3), `app_user` (table only; used in S7)
- **[S3+]** Incident, campaign, member, queue, repair, proposal, audit and outbox tables are added in their own steps.

**Schema `sim` (simulator-private)**
- **[1a]** `vehicle_profile`
- **[1b]** `scenario_manifest`, `ground_truth`

**Roles [1a]**
- `cw_sim`: read/write on `sim` and on the `core` registry tables.
- `cw_app`: **no access to `sim`**. Every later service uses `cw_app`.

---

## 5. Data design (simulator)

### 5.1 Registry **[1a]** (N = SIM_SCALE; proportions hold at any N)
- **VINs:** valid 17-character VINs with no I/O/Q, ISO 3779 check digit at position 9, and fictitious WMIs per OEM.
- **Tenants and fleets:** 2 tenants (70% / 30%) and several fleets.
- **Depots:** ≈ N/250 depots in **8 regions**. Each region has a climate profile (hot-dry, hot-humid, temperate, cold) and a daily ambient curve. Most depots hold 150–300 vans.
- **Models and powertrains:** 8 models, 4 per OEM. Powertrain mix: 55% EV, 35% diesel, 10% hybrid.
- **Duty types:**

  | Duty | Share | Active hours/day |
  |---|---|---|
  | Urban | 45% | ~10 |
  | Linehaul | 20% | ~18 |
  | Rental | 15% | variable |
  | Field | 10% | ~9 |
  | Yard | 10% | ~12 |

  Each duty also has a speed/stop profile and a load factor.
- **Two deliberately large depots, reserved for 1b plants.** Seeded in 1a so plants never need a reseed:
  - **Depot S1:** ≥ 60 vans of one OEM-B diesel model on urban duty.
  - **Depot S1b:** ≥ 30 vans of the same model/duty, in a different region.
  - At small N (e.g. 5,000) these minimums still hold, because the reserved depots are sized explicitly.
- **Other registry data:**
  - Firmware versions per model, with rollout history written to `vehicle_firmware_history`.
  - Pseudonymous drivers with assignment history.
  - 2–8 workshop bays per depot.
- **Hidden per-vehicle profile** (in `sim.vehicle_profile` only):
  - A personal offset per signal, an efficiency factor and a driving-style factor.
  - **~2% of diesel vans are "naturally hot":** +6 to +8 °C coolant, healthy and stable. This is part of the healthy model.
- Seeding uses `COPY` and is idempotent: it is skipped if the same seed and N are already seeded.

### 5.2 Healthy signal model **[1a]** (pure functions in `packages/domain`)

**Clock.** All generation reads a `Clock` interface (`now()`, `speed`).
- **[1a]** Live clock only, speed 1×.
- **[1b]** Adds the speed factor, T0 and the modes.

**Trips and ignition**
- Vans follow their duty's shift pattern: trips (ignition on → driving/stops → ignition off), then overnight parking at the depot.
- Events emitted: `TRIP_START`, `TRIP_END`, `IGNITION_ON`, `IGNITION_OFF`.
- The odometer is monotonic, and each increment equals speed × time.
- Position moves plausibly around the home depot, using synthetic coordinates.

**Signals**

| Signal | Applies to | Healthy model |
|---|---|---|
| `coolant_c` | Diesel / hybrid, **only while the ignition is on** (null when parked) | Warm-up curve to ~88 °C + personal offset + duty load + 0.15 × (ambient − 25), + 0.4 × (ambient − 35) when ambient > 35, + noise N(0, 0.8) |
| `batt_temp_c` | EV / hybrid | ambient + 6 + load term + personal offset + noise; +4 while charging |
| `soc_pct` | EV / hybrid | Drains per km (model rate × efficiency × ambient penalty × style); charges at the depot while parked (`charging` = true) |
| `fuel_pct` | Diesel | Drains with use |
| `lv_batt_v` | All | 12.6 ± 0.15 resting; 14.1 ± 0.2 running |
| `speed_kmh`, `ambient_c` | All | From trip and region models |

- **Driving events:** `HARSH_BRAKE` / `HARSH_ACCEL` from duty and style; `idle_s` from duty.
- **Background fault codes:** Poisson, ~0.02 per vehicle-day, drawn from these families:

  | Family | Codes |
  |---|---|
  | COOLING | P0217, P0118, P0480 |
  | HV_BATTERY_THERMAL | P0A7E, P0A80 |
  | LV_ELECTRICAL | P0562, P0620 |
  | EXHAUST | P2463, P0401 |
  | BRAKE_SENSOR | C0035 |

- **Reporting cadence (simulated time):**
  - Every **30 sim-minutes** while the ignition is on.
  - A heartbeat every **4 sim-hours** while parked.
  - Immediate events for trip start/end, harsh events and fault codes.
- **Every message carries:** a per-vehicle monotonic `seq`, `event_ts` (simulated time), an `evt` type, and the current `firmware`.

### 5.3 Output formats and transport **[1a]**

**OEM-A "Aurex": nested JSON (format v1).**
```
{vehicle:{vin}, t, n (seq), evt, pos:{la,lo}, spd, odo,
 eng:{coolantTempF, rpm}, batt:{tempF, soc}, elec:{v12}, amb, codes:[...],
 sw (firmware), ign, chg}
```
Format v2 is added in **[1b]**: °C and renamed fields, e.g. `engine:{coolant:{tempC}}`.

**OEM-B "Kestrel": flat compact JSON.**
```
{id, ts (epoch ms), sq, e, g:[lat,lon], s, o, ct, bt, soc (0–1), v, a,
 dtc:"P0217|C0035", fw, ig, ch, hb, ha, idl}
```

**Transport**
- **Kafka:** message key = VIN.
- **Headers:** `x-sent-at` (wall-clock ms) and `x-source-format` (e.g. `aurex.v1`).
- **Producer:** idempotent, `acks=all`, zstd compression, batching with linger 5–20 ms.
- **Workers:** N worker processes, each owning a VIN range. Throughput (msgs/s) is logged every 5 s.

### 5.4 Plants **[1b]** (all timings in sim-hours from **T0** = start of the live stream = end of history; everything recorded in `sim.scenario_manifest`; switchable via `PLANTS=on|off`)

| ID | What | Must produce later |
|---|---|---|
| **S1 outbreak** | 18 vans at Depot S1 (OEM-B diesel, urban). From T0+6 h, coolant drifts up to +8…+12 °C over their own normal by ~T0+42 h, with COOLING codes (P0217/P0118/P0480) becoming more frequent. 15 vans start at T0+6 h; **3 "late sisters" start at T0+24 h**. The drift continues if untreated; record `limit_ts` = when coolant would reach 110 °C. The drift does not depend on load, and 2 sisters have one gentle-driving day. | One campaign; +3 joins; at-risk before joining |
| **S1 healthy cohort** | The other ≥ 42 same-model/duty vans at Depot S1 stay healthy | At-risk flags go mostly to sisters |
| **Firmware clue** | That model's firmware 4.2.1 rolls out over T0−48 h…T0. At Depot S1, **16 of 18 sisters** get it in the 3 days before onset, vs **~20 of 42 healthy peers** | "16/18 vs 48%" clue |
| **S1b outbreak** | 8 vans, same model/family/duty, at Depot S1b (different region); onset T0+18 h | A second, separate campaign, never merged |
| **Runaway** | 1 **linehaul** van on **OEM-A**, a different model and depot; from T0+10 h its temperature **accelerates** (quadratic) to the hard limit at ~T0+34 h | Critical at < 12 h to limit, with ≥ 15 readings to spare |
| **Scattered decoy** | 6 diesel vans at 6 different depots/duties (none matching S1/S1b), each with a real COOLING drift and codes, independent onsets | Incidents yes, campaign no |
| **Same-depot, other-model decoy** | 2 vans at Depot S1, a different diesel model, COOLING drift | Not in the S1 campaign |
| **Heatwave** | A region **not** containing S1/S1b: ambient +10 °C over T0+12 h…T0+60 h | Many high readings, zero campaigns |
| **Loud-but-stable** | 20 vans with 10–40 mixed-family codes/day but flat signals | Rank below real risk; fools loudest-first |
| **Naturally hot** | ~2% of diesel vans (from the 1a profile) | Global threshold fires; own-normal does not |
| **Sensor glitch** | 3 vans with impossible jumps (25 → 140 → 25 °C) | Rejected, no incident |
| **Repairs** | Consume `workshop.repairs.v1` `{vin, repaired_at}`. The van's drift stops and it returns to normal within ~2 sim-hours. **One designated S1 sister is a "bad repair"** whose drift continues. Record outcomes in the ground truth. | Fix confirmation |
| **Depot transfer** (config, default off) | 2 S1 sisters move depot at T0+30 h | Stay in the S1 campaign |

### 5.5 Mess injection **[1b]** (applies to all vans, including plant vans)
- **2%** exact duplicates (same VIN + seq, re-sent later).
- **5%** out-of-order (delayed 1–600 wall-seconds).
- **Offline bursts:** ~1% of vans per sim-day go offline for 30–180 sim-minutes, then flush the backlog with their original `event_ts` / `seq`.
- **0.1%** malformed JSON or missing required fields.
- **0.05%** invalid VINs.
- **0.05%** unknown DTC formats.
- **0.5%** of vans have ±90 s clock skew.
- **0.02%** impossible values (SoC 140%, negative speed, odometer going backwards, SoC rising while driving).
- **OEM-A format switch** at T0+12 h (v1 °F → v2 °C, renamed fields). S1 is on OEM-B, so the demo is unaffected; the runaway van is on OEM-A, which tests the switch.

### 5.6 Clock modes **[1b]**
- **history:** writes **7 sim-days before T0** as Parquet (DuckDB) to `data/history/` (~17M rows at N = 100K).
  - Plant-free, but includes background codes and naturally-hot vans.
  - Uses the same per-vehicle profile as the live stream.
- **demo** (compose default):
  - **360×** speed (1 wall-second = 6 sim-minutes), so active vans report about every 5 wall-seconds. Target **~10K msgs/s at N = 100K**.
  - Plays T0 → T0+60 h in ~10 wall-minutes.
  - A "shift start" surge (3× send rate for a few minutes) at T0+24 h.
  - `--reset` restarts from T0.
- **bench:** every vehicle every wall-second (~100K msgs/s target at N = 100K); realism is ignored.
  - `--burst` = 3× for 5 wall-minutes (the brief's burst NFR).
  - Report the achieved rate honestly.

### 5.7 Ground truth **[1b]** (simulator-private)
`sim.ground_truth` and `data/ground_truth.parquet` with columns:
```
vin, scenario_id, role, fault_family, onset_ts, late, limit_ts, expected_campaign, repair_outcome
```
Role is one of: `s1_sister`, `s1_late_sister`, `s1_healthy_cohort`, `s1b_sister`, `runaway`, `decoy_scattered`, `decoy_same_depot_other_model`, `heatwave_region`, `loud_stable`, `naturally_hot`, `sensor_glitch`, `bad_repair`, `background`.

### 5.8 `npm run simulator:verify` **[1b]** (all checks use the configured N)
1. Vehicle count = N; all VINs valid.
2. Depot S1 has ≥ 60 S1-model urban vans; Depot S1b has ≥ 30.
3. Plant vans have the right powertrains (S1/S1b diesel; the runaway van matches its signal).
4. Decoys, the heatwave region and the runaway van do not overlap S1/S1b depots or keys.
5. History ends before the first onset and contains zero plant drift.
6. Urban vans average ≥ 20 readings per sim-day (active + heartbeat), and ≥ 18 while the ignition is on.
7. Runaway: ≥ 15 readings between the "< 12 h to limit" point and the limit.
8. S1: ≥ 20 readings per main (non-late) sister between onset and the +8 °C point.
9. The firmware split at Depot S1 matches the manifest.
10. **The heatwave is hard:** without peer adjustment, ≥ 30% of the affected region would exceed a simple global threshold.
11. **Naturally-hot vans exceed the global coolant threshold** during normal operation.
12. Observed mess rates in a 2-minute sample are within ±30% of config.
13. The same seed produces identical first 1,000 messages.
14. `cw_app` cannot `SELECT` from schema `sim`.

---

## 6. How the data proves effectiveness **[S9]**
| Claim | Data that proves it | Metric |
|---|---|---|
| Own normal beats one global threshold | Naturally-hot vans + heatwave | False incidents: global threshold vs ours |
| Peer adjustment cancels shared conditions | Heatwave region | Campaigns / incidents in the region = 0 |
| Grouping finds real outbreaks, rejects look-alikes | S1, S1b, scattered and same-depot decoys | Membership precision/recall; S1 and S1b stay separate; decoys admitted = 0 |
| Joins are exact | Duplicates, redeliveries, offline bursts | Members = unique sisters |
| Prediction (at-risk) | 3 late sisters | % flagged at-risk before crossing; lead time (h) |
| Queue beats "loudest-first" | Loud-but-stable vans vs sisters + runaway | Precision@k vs the true at-risk set |
| Runaway early warning | Runaway van | Hours of warning before `limit_ts` |
| Detection before failure | S1 `limit_ts` | Hours from campaign open to the first `limit_ts` |
| Fix confirmation | Repairs + bad repair | Correct fixed / not-fixed labels |
| Robust ingestion | Mess, format switch, burst | Count in = count out (valid + DLQ + dropped duplicates) |
| Throughput | bench mode | Measured msgs/s, with hardware stated |
