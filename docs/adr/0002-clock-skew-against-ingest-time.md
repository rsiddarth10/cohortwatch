# ADR 0002: Clock skew is judged against ingest time mapped into event time

- **Status:** accepted (S2, 2026-09-29)
- **Context:** the S2 plan asked for a flag when "event time is more than 2 min after ingest time". Ingest time is
  wall-clock time, and event time is simulated. At the 360× demo speed every event would be hours "in the
  future", and the brief forbids mixing the two clocks (§2.2). A first design compared each reading with the
  median event time of recent readings. The unit test showed it fails on sparse partitions: at night, or at
  N = 5,000, consecutive readings are minutes apart in sim time, so ordinary readings would be flagged.

**Decision.** Each partition keeps an `IngestClock` (`packages/domain`), which converts ingest time into event
time explicitly:

```
expected event time = offset + speed × ingest
offset = median(event_ts − speed × ingest) over the last 512 readings
```

- **ingest** = the Kafka record timestamp (wall clock).
- **speed** = `INGEST_CLOCK_SPEED`: 1 in production, the simulator's demo speed (360) in compose.
- The median offset ignores the few skewed vans and the late or out-of-order readings.
- A reading more than `SKEW_MS` (default 2 min) ahead of its expected time is flagged `CLOCK_SKEW`. It is kept
  and never corrected. Lateness is judged by the anti-replay window, not here.

**Consequences.**
- The normaliser needs the stream's speed as config. That is clock configuration, not simulator ground truth.
- The simulator's injected skew is ±90 s, below the 2-minute threshold, so those vans are not flagged. That is
  realistic tolerance; `SKEW_MS=60000` would flag them.
- Clocks are per replica and in memory. After a restart a clock needs 64 readings per partition before it flags
  anything.
- In `SIM_MODE=live` set `NORMALISER_CLOCK_SPEED=1`.
