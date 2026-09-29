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

## 11 AI / ML

**Model per van, not one rule for the fleet (S3).** CohortWatch fits a small statistical model to every van and
every signal: its own normal level and trend (median and MAD, learned from last week's healthy history by the
batch job), updated online by an exponentially weighted regression (O(1) per reading). A reading is judged by a
robust z-score against that van's own spread, after subtracting what its peers in the same region and duty are
doing at the same time, and must persist (4 of the last 6 readings).

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
