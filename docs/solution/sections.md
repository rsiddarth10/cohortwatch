# Solution document: section drafts

Snippets for the solution document (template `docs/Motorq_Hackathon_Solution_Document_Template.docx`), added
per step and assembled in S10.

## 6.4 Interfaces, contracts & runtime flows

**S2 normaliser (raw OEM feeds → canonical events).**
- **Inputs:** `raw.oem-a.v1` (Aurex v1/v2 JSON) and `raw.oem-b.v1` (Kestrel compact JSON), key = VIN, read by
  consumer group `cg.normaliser` (cooperative-sticky assignment, manual commits).
- **Canonical output:** `telemetry.canonical.v1`, key = VIN, Avro in Confluent wire format. Subject
  `telemetry.canonical.v1-value` with BACKWARD compatibility; new fields must have defaults. Fields are °C/SI,
  `event_ts` in ISO UTC, `event_id` = uuid5(vin:seq), `quality_flags[]` (`TYPE[:field]`) and `fault_families[]`.
- **Rejects:** `telemetry.dlq.v1`, a JSON envelope `{source_topic, partition, offset, error_code, error_detail,
  raw_payload_b64, first_seen}`. Codes: `MALFORMED_JSON`, `UNKNOWN_SHAPE`, `SCHEMA_INVALID`, `INVALID_VIN`.
- **Lineage:** every output carries `x-src-topic/partition/offset`, `x-sent-at` (from the simulator) and
  `x-normalised-at`. `npm run normaliser:reconcile` proves `in = out + DLQ + duplicates` from them.
- **Flow per partition batch:** decode (shape fingerprint, not the header) → validate → read VIN state (1 Redis
  MGET) → anti-replay + jump + skew checks → produce and await acks → write state (1 Lua compare-and-set) → commit
  offsets. At-least-once, never loss. Redelivered records are dropped by the window; a re-produce keeps its
  `event_id` (ADR 0001).

## 6.5 Algorithms

**Anti-replay window (per VIN).** Like IPsec replay protection:
- **State:** the highest seq seen, a 1024-bit bitmap of which of the 1024 seqs below it arrived, and the newest
  event time. That is 128 B of bitmap (144 B with the header, 169 B with the jump-check reading) per VIN, about
  17 MB at 100K vans.
- **Cost:** O(1) per event. A new maximum shifts the bitmap (≤ 128 byte operations); an older seq is one bit test
  and set.
- **Outcomes:** `NEW`; `DUPLICATE` (drop); `LATE_NEW` (forward, `OUT_OF_ORDER`); `TOO_OLD` (beyond the window,
  forward flagged `LATE`, never silently dropped); `SEQ_RESET` (far lower seq with newer event time: the window
  restarts).
- **Implementation:** a pure function in `packages/domain`, state in → state out, so Redis only stores bytes.

**Clock skew without mixing clocks.** Expected event time = median(event_ts − speed × ingest) + speed × ingest,
per partition (ADR 0002). A reading more than 2 min ahead of its expected time is flagged, never corrected.

### S3: van vs its own normal (state processor)

All of it is pure functions in `packages/domain/src/detect/` (state in → state out). Time is event time.

| Step | What | Time per reading | State per van |
|---|---|---|---|
| EW regression trend | Five decayed sums (S, St, Stt, Sy, Sty) with the origin at the newest reading. A new reading after Δ hours decays them by exp(−Δ/τ) and adds itself. Gives level (Sy/S) and slope. τ = 12 sim-h for level and slope; a second trend with τ = 3 h is used only for time to limit. Tested equal to a plain weighted least-squares fit. | O(1) | 6 numbers × 2 trends × metric |
| Which readings count | Coolant and battery temperature: `PERIODIC`, driving, not charging, ≥ 25 min after ignition on, no quality flag on the field. 12 V: ignition-on readings. Heartbeats and parked readings never count. | O(1) | — |
| Impossible-jump guard | Reject a reading moving faster than the metric's physical maximum rate, or more than a spike limit from the van's fast mean (catches 25 → 140 → 25 °C). A run of rejected readings that agree and span ≥ 1 h is a real step: the trend restarts. | O(1) | 3 numbers |
| Own normal | Batch job: per van × metric, median of 12-h window means and slopes. The MADs are taken after subtracting the peers' median deviation in the same window, so the spread is on the peer-adjusted scale the stream uses. A van without history uses its model × duty × region cohort. | — (nightly) | 4 numbers |
| Peer adjustment | dev = level − own median (°C). Subtract the median dev of peers reporting in the last 2 sim-h, in region × duty, or the whole region when fewer than 10 (ADR 0006). In °C, not z, so a shared +10 °C cancels exactly. Same for slope and fast rate. | amortised O(1); O(c log c) per context per sim-hour | 1 entry per van per context |
| Robust z | z = adjusted dev / (1.4826 × max(MAD, floor)). Abnormal: z_level ≥ 3, or z_slope ≥ 3 with z_level ≥ 1.5. | O(1) | — |
| k of n | Bit ring of the last n = 6 outcomes; confirmed at k = 4. One noisy tick never raises an incident. | O(1) (popcount) | 1 integer |
| Time to limit, runaway | hours = (limit − fast fitted level) / (van's fast rate − peers' fast rate), only when that rate is ≥ a minimum (no "400 h" flicker). Critical after 3 consecutive readings under 12 h, and only for a van that is abnormal after peer adjustment and confirmed k of n. The flag is sticky for the incident. | O(1) | 1 counter |
| Fault-code rate | 24 hourly buckets per family. Abnormal when codes in 24 h ≥ max(3, 4 × the van's own usual rate from history). | O(1) amortised | 25 numbers per family seen |
| Incident | Opened once per (van, family, 24-h event-time window): `incident_id` = uuid5(vin, family, window). Closed after 12 normal readings. Clues are phrases with units ("coolant 4.2 °C above its own normal (90.8 °C)", "rising 0.30 °C/h, 3.1× its usual rate", "peers in the same region are +9.3 °C vs their own normal right now…", "about 6.0 h to the 110 °C limit"). | O(1) | open incidents |

**Replay safety.** Each van stores its last applied `seq`; a replay after a crash skips what the Redis checkpoint
already holds (ADR 0005). Incident writes are upserts on the deterministic id, so a replay re-derives the same
incident, never a clone.

### S5: campaigns (campaign engine)

Pure functions in `packages/domain/src/campaign/`; one Postgres transaction per incident in the service.

| Step | What | Cost |
|---|---|---|
| Family key | `fault_family \| model \| duty \| depot` from the incident's snapshot (event-time depot). `incidents.v1` is keyed by it, so one key = one partition = one writer (ADR 0009) | O(1) |
| Windows + union-find | 24-h event-time buckets per key. An incident joins the live group whose buckets touch its own (gap ≤ 1 bucket); a bucket bridging two groups unions them (older root, path compression, persisted as `merged_into`). Different depots are different keys, so they never merge | amortised O(α(n)) per union |
| Join once | A van is a member at most once: `PRIMARY KEY (campaign, vin)` plus a partial unique index "one live campaign per van and family". A replay is dropped by `processed_incident_action(incident_id, action, seq)`; an S3 CLOSE never removes a member | O(1) per incident |
| Poisson guard | Open only if n ≥ 5 distinct vans **and** P(X ≥ n \| λ) < α = 1e-4, with λ = vans in key × days × max(floor, baseline code rate, **current rate of the same model × duty elsewhere in the region**). The tail is summed in log space (accurate below 1e-12). Below the bar: WATCHING (ADR 0010) | O(n) |
| At-risk sisters | Non-members of the key with peer-adjusted z_level ≥ 1.5 in 3 of the last 4 hourly rows, or z_slope ≥ 2 with a positive deviation. Re-evaluated on every change and once per sim-hour (ADR 0011) | O(vans in key × 4) |
| Firmware clue | Share of members that got version X in the 3 days before **their** first incident, vs the share of non-member sisters that got X in the 3 days before the **campaign's** first incident (same window length). Shown if ≥ 60% of members and a gap ≥ 30 points | O(installs in key) |
| Override | "Not an outbreak" is sticky; re-raised only when members reach min(+50%, +3) or a member turns runaway | O(1) |
| Outbox | Campaign change + outbox row in one transaction; the leader's relay publishes to `campaign.events.v1` (id = uuid5(campaign, type, version)) (ADR 0012) | O(events) |

### S4 + S6: workshop queue and fix confirmation (workshop service)

Pure functions in `packages/domain/src/queue/` and `.../repair/`. For a depot with v vans, c candidates and b bays:

| Step | What | Cost |
|---|---|---|
| Candidates | One entry per van: open incidents, campaign members, campaign at-risk sisters, solo at-risk (≥ 3 of the last 4 hourly peer-adjusted z ≥ 1.5, or a steep rise), failed repairs. Signals merge; reasons merge | O(v) |
| Score | 0.35 severity + 0.25 trend (z_slope, time to limit) + 0.20 campaign (log of size; ½ for at-risk) + 0.10 in service tomorrow + behaviour **capped at 0.10** (harsh events per driven hour vs its duty's depot median) + 0.15 if a repair did not hold. The fault-code count is **not** a term (loud-but-stable ranks below quiet-and-worsening). Runaway/critical is **pinned** above every score (ADR 0014) | O(c) |
| Rank | Pinned by soonest limit, then score, ties by VIN | O(c log c) |
| Bays | Today's capacity = bays × slots per bay; fill today then tomorrow in rank order with items scoring ≥ 0.35 (runaways always); the rest wait | O(c) |
| Cost of waiting | P(breakdown before its slot) × breakdown cost: wait / time to limit, else 1 − (1 − daily hazard)^days by severity and role | O(1) per item |
| Queue versions | A depot's queue is rebuilt on any event for that depot and every sim-hour. A new version (row per item + a snapshot + an outbox row to `queue.events.v1`) only when the order or slots change | O(c) per rebuild |
| Fix confirmation | After a repair (S3 resets the van's trend, ADR 0016): **FIXED** when ≥ 6 of the last 8 driven hours are inside \|z\| < 2 with ≥ 12 driven hours; **NOT_FIXED** after 24 driven hours or at 48 sim-h; **PENDING** until driven. Judged each sim-hour; outcomes go to `workshop.outcomes.v1`, a NOT_FIXED van returns to the queue with a boost, and a campaign closes when all members are FIXED (ADR 0017) | O(h) per open repair (h ≤ 48 hourly rows) |

## 11 AI / ML

**Model per van, not one rule for the fleet (S3).** CohortWatch fits a small statistical model to every van and
every signal: its own normal level and trend (median and MAD, learned from last week's healthy history by the
batch job), updated online by an exponentially weighted regression (O(1) per reading). A reading is judged by a
robust z-score against that van's own spread, after subtracting what its peers in the same region and duty are
doing at the same time, and must persist (4 of the last 6 readings).

**Result (S3 scorecard, N = 5,000, T0 → T0+72 h).** Same real faults caught as a global threshold (35/35), with
4.1 vs 126 false incidents per 1,000 healthy vans; heatwave 3.6% vs 84%; runaway critical 5.8 h before limit.

**Why rules alone were not enough.** One fleet-wide threshold (coolant > 97 °C) cannot tell three things apart:
- a van that always runs hot (about 2% of diesels run 6–8 °C above the rest and are healthy);
- a heatwave that lifts every van in a region;
- a van quietly drifting away from its own normal.

The global rule flags 76% of naturally-hot vans and 84% of a heatwave region; the per-van model flags almost none
of them, and still catches every outbreak sister (scorecard in `docs/perf/state-processor.md`). The model is also
what makes clues possible: "4.2 °C above *its own* normal" and "peers are +9 °C today" are statements about a
van's model, not about a threshold.

**Planned (S9):** an ML at-risk classifier trained on history + labels, evaluated against this per-van rule model
and the global threshold.

**Similar past campaigns (S5).** Each campaign is described by a 31-dimensional feature vector: fault family,
powertrain, duty, climate, log members, typical deviation and trend, and the mix of fault codes, with block
weights so the family counts most. Top 3 by cosine similarity (pgvector HNSW `<=>`) against 30 synthetic past
campaigns, each with a root cause and a resolution note (ADR 0013). No external embedding API: it is deterministic,
explainable (named features) and needs no data to leave the system. A learned embedding could replace the vector
later without changing the query.
