# Step 2 walkthrough (normaliser)

- `packages/domain/src/canonical/adapters.ts`: three OEM formats → one canonical event. *Q: how is the format chosen?* By a marker-key fingerprint of the payload, never the header, so the Aurex v1→v2 switch needs no config.
- Tested by round trip: the simulator's own encoders → the adapter → the same values (°F→°C, SoC 0–1→%, epoch→ISO).
- `validate.ts`: a bad VIN rejects the event (DLQ). Any other bad field is nulled and flagged, and the event is kept. *Q: why keep it?* Detection decides what a flagged reading means; the normaliser never guesses.
- `antireplay.ts`: per-VIN 1024-bit window, IPsec-style. NEW / DUPLICATE / LATE_NEW / TOO_OLD / SEQ_RESET. Pure: state in → state out, 169 B per VIN in Redis. *Q: complexity?* O(1) per event.
- `IngestClock`: skew = event time vs ingest time *converted* into event time with the stream's speed. *Q: why not a median of recent readings?* The unit test showed sparse partitions would be flagged as skewed.
- `services/normaliser/src/main.ts`: per batch, MGET → classify → produce and await acks → Lua compare-and-set → commit. *Q: why write state after producing?* A crash then means a redelivery with the same `event_id`, never a loss (ADR 0001).
- *Q: what did measuring change?* SHA-1 for uuid5 cost 15 µs/event (now 3). 8 partitions in flight capped a replica (now 48). A back-pressure `pause()` marked in-flight batches stale, causing re-processing (now only a real revoke skips a commit).
- `cli/reconcile.ts`: in = out + DLQ + duplicates, counted in Kafka via `x-src-*` headers. It balanced at 5K. At 100K the read-back didn't finish on laptop CPU (recorded as INCOMPLETE).
- `normaliser.itest.ts`: Testcontainers (real Redpanda + Redis): exact output for a messy batch, and a crash before commit adds no events. It runs in CI.
- Scaling: stateless, so up to 48 replicas (the partition count). 3 by default; at 100K the 3× surge still builds a backlog that drains afterwards.
