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
