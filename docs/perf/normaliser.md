# Normaliser performance (step S2)

Measured 2026-09-29. Numbers are as measured, not tuned for show.

**Hardware.** Laptop, 12th Gen Intel Core i7-1255U (2 performance + 8 efficiency cores, 12 threads, 15 W), 32 GB
RAM. Docker Desktop on WSL2 with 15 GiB visible, data disk on D:. **The same laptop runs everything:** the broker
(single Redpanda node, `--smp=2`), Redis, Postgres, the simulator (4 workers) and the normaliser replicas. So the
normaliser competes with the broker and the load generator for CPU, and these numbers are a floor for the
service, not a property of it.

## Demo at N = 100,000 (360×, 3 replicas, the compose default)

Clean `docker compose down -v && docker compose up` with no `.env`.

| Metric | Value |
|---|---|
| Consumer lag, T0 → T0+24 h (normal load) | max 147K records total over 48 partitions |
| Consumer lag during the shift surge (T0+24 h → T0+42 h, 3× send rate) | grows to a **peak of 3.76M at T0+42 h** |
| Consumer lag at T0+72 h | 519K and draining (146K at T0+76 h). It never diverged, so it stays bounded |
| End-to-end latency (`x-sent-at` → canonical ack), steady post-scenario load, 15.7M events | **p50 1.43 s, p95 28.9 s, p99 ≥ 60 s** (top histogram bucket) |
| Back-pressure pauses (Redis round trip incl. event-loop delay > 1 s) | 19–34 per replica per hour at steady load |

**Reading it.** At normal demo load, 3 replicas keep up with single-digit-second latency. The 3× surge exceeds
what 3 replicas get on this shared CPU, so a backlog builds and then drains. The latency tail (p95/p99) comes from
back-pressure pauses when the event loop is starved.

**Improvement options, not done in S2:**
- Use the client's native (non-KafkaJS) API.
- Reduce the headers from 7 to 3.
- Run more replicas on hardware with more cores.

**Horizontal scaling.** The normaliser is stateless (per-VIN state lives in Redis, compare-and-set per batch).
The two raw topics have 48 partitions, so a consumer group can use **up to 48 replicas**
(`NORMALISER_REPLICAS`). Beyond that, add partitions.

## Reconciliation (in = out + DLQ + duplicates)

| Where | Result |
|---|---|
| N = 5,000, 60-s window | **BALANCED**: 15,655 = 15,335 + 14 + 306 |
| N = 5,000, crafted batch (unit + Testcontainers integration test, incl. a crash before commit and a restart) | exact output, no extra canonical events: green in CI |
| N = 100,000, 5-min windows | **not verified.** Attempt 1 was invalid: a rebalance plus the stale-batch bug (below) double-counted, difference −224K. Attempt 2, after the fix, was **INCOMPLETE**: the read-back of ~6M canonical records timed out at 46/48 partitions while the demo and 3 replicas shared the CPU. Attempt 3 was aborted by my own sequencing (the replicas were stopped before the end-of-window snapshot). Stopped here at the time box. |

The 100K read-back is limited by laptop CPU. The reconcile reader goes through the same Kafka client and competes
with the broker, the simulator and the replicas. On hardware with more cores, or with the reader using the native
client API, it should complete; that is an S9 follow-up.

## Throughput bench (drain of `bench.raw.v1`)

Method (`scratchpad` script, recorded here):
1. `sim:bench --duration 30 --keep` fills `bench.raw.v1` (about 3M records: every van every second).
2. N fresh replicas, in a new consumer group with their own Redis prefix, drain it.
3. The rate is measured from Kafka itself: Σ(committed − log-start) per partition, sampled every 5 s.

It ran once per setting, as-is:

| Replicas | Best 30-s rate | Average drain rate (includes start-up and group join) |
|---|---|---|
| 1 | 34,682 records/s | 9,362 records/s |
| 2 | 42,533 records/s | 12,787 records/s |

The average includes several seconds of start-up and group rebalancing on a ~3M-record topic, so it understates
the steady rate; the best 30-s window is closer to steady state.

**CPU profile** (`npm run normaliser:bench-cpu`, pure path without Kafka or Redis):
- Decode + validate: 13.7 µs/event.
- Anti-replay + jumps + skew: 3.7 µs/event.
- Avro encode: 2.6 µs/event.
- Total about **21 µs/event**, i.e. ~47K events/s on one core.

In the live service the per-event cost is higher, dominated by the Kafka client's per-message handling.

**Fixed along the way** (each found by measuring, each committed):
- `eventId` took 15 µs; an allocation-free SHA-1 brought it to 3 µs.
- Field paths are now split once and cached.
- 48 partitions are in flight per replica (was 8).
- A back-pressure `pause()` made in-flight batches "stale", and the normaliser skipped their commits. That caused
  re-processing and double counting. Now it only skips when the partition was really revoked; 0 revoked batches
  since.
