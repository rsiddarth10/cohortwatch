# ADR 0001: Normaliser anti-replay window and delivery order

- **Status:** accepted (S2, 2026-09-29)
- **Context:** the raw feeds carry exact duplicates, out-of-order and very late readings (brief §5.5), Kafka
  redelivers after a crash, and several normaliser replicas may run. A duplicate must count once, a crash must
  cause a redelivery rather than a clone, and nothing may be lost.

**Decision.** Each VIN has an anti-replay window like IPsec's: the highest seq seen, a 1024-bit bitmap of which
of the 1024 seqs below it were seen, and the newest event time. That is 144 bytes, plus 24 bytes of "last
reading" for the jump checks, stored as one 168-byte Redis value `ar:{vin}` with a 7-day TTL. The transitions
are pure functions in `packages/domain` (`checkReplay`):
- `NEW`: forward.
- `DUPLICATE`: drop and count.
- `LATE_NEW`: forward, flagged `OUT_OF_ORDER`.
- `TOO_OLD`: forward, flagged `LATE`. It is never silently dropped.
- `SEQ_RESET`: a far-lower seq with a newer event time; the window restarts.

Per partition batch the order is:
1. Read the states with one `MGET`.
2. Classify in TypeScript.
3. Produce and await the acknowledgements.
4. Write the states back with one Lua compare-and-set over all the batch's keys.
5. Commit the offsets.

We rejected a Lua script that classifies *and* marks before producing: a crash between marking and producing
would make the redelivered records look like duplicates and lose them. With our order:
- A crash before the commit means redelivery, and the window drops what was already produced.
- A crash in the short gap between the acknowledgement and the state write re-produces events with the **same
  `event_id`** (uuid5 of `vin:seq`), so consumers (S3) dedupe on it.
- The compare-and-set stops a replica that lost its partition in a rebalance from overwriting the new owner's
  newer state; conflicts are metered.

Kafka transactions would close the remaining gap, but they would not cover the Redis write and they add real
complexity; revisit in S9 if the chaos tests show duplicates matter.

**Consequences.**
- Cost per event is O(1): at most 128 byte operations to shift the bitmap.
- Memory is 168 B per active VIN, about 17 MB of values at 100K vans.
- Out-of-order data is caught if it arrives within 1024 readings of the newest, which is about 21 sim-days at the
  30-minute cadence.
