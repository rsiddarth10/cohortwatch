# ADR 0005: Detection state in memory per partition, checkpointed to Redis

- **Status:** accepted (S3, 2026-09-30)
- **Context:** the state processor keeps, per van, two EW trends per metric, a k-of-n ring, a runaway counter,
  24-h code rings and its open incidents (about 1 KB of JSON per van). The brief's S3 line said "EW sums in Redis".
  At 100K vans and about 10K events/s, a Redis round trip per event (or a per-batch MGET/SET as in S2) would
  make Redis the bottleneck, and S2 already showed Redis latency driving back-pressure pauses.

**Decision.** Each replica holds the state of the VINs in the partitions it owns, in memory.
- Every `CHECKPOINT_MS` (10 s wall), each changed partition is serialised between batches (a per-partition
  promise chain means a snapshot never contains half a batch) and written as one Redis value
  `sp:ckpt:{topic}:{partition}` together with the offset it is consistent with. Only then is that offset committed.
- On revoke, the partition is checkpointed before it is handed over (the Kafka client awaits our
  `rebalance_cb`). On assign, the checkpoint is loaded before the first batch.
- A restart replays from the committed offset. Each van stores its last applied `seq`, and readings at or below
  it are skipped, so a replay never double-counts. Out-of-order readings (seq below the last applied one) are
  skipped too; they are about 5% of readings and do not change detection.
- A batch whose incident write still fails after retries stops the process (crash-only). The restart recovers
  exactly, because the state and offsets on disk are consistent.

**Consequences.** Redis traffic is one write per partition per 10 s instead of one round trip per batch. The cost
is up to 10 s of replay after a crash, and incident writes that must be idempotent (they are: uuid5 ids and upserts).
