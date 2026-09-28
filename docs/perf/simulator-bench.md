# Simulator bench (step 1b)

Measured 2026-09-29 with `npm run sim:bench` and `npm run sim:bench:burst`. Bench mode sends every vehicle once per
wall second (× multiplier), realism ignored, to `bench.raw.v1` only; the topic is cleared after each run.

**Hardware:** laptop, 12th Gen Intel Core i7-1255U (10 cores / 12 threads, U-series, 15 W), 32 GB RAM, Docker Desktop
on WSL2 with 15 GiB visible to containers. Single Redpanda broker in the same VM, `--smp=2 --memory=2G`, RF 1.
Producer: `@confluentinc/kafka-javascript`, idempotent, acks=all, zstd, 5,000-message batches, up to 8 in flight per
worker. **N = 100,000, 8 workers.** Laptop retention caps on (`bench.raw.v1`: 48 partitions, 64 MiB each).

| Run | Phase | Target msgs/s | Achieved msgs/s | Batch ack p50 / p99 |
|---|---|---|---|---|
| Steady (120 s) | 1× | 100,000 | **94,292** (most 5-s windows at 100,000) | 599 ms / 6,134 ms |
| Burst | 60 s at 1× | 100,000 | **99,792** | 3,087 ms / 4,663 ms (whole run) |
| Burst | 300 s at 3× | 300,000 | **97,867** — 3× not reached | |
| Burst | 60 s at 1× | 100,000 | **87,000** (still draining the backlog) | |

Peak single second: 235,000 (steady run) / 320,000 (burst), i.e. short bursts clear, sustained rate does not.

**Latency** is the wall time from handing a 5,000-message batch to the producer until the broker acknowledges all of
it (not per-message end-to-end). It grows during the burst because the producer queue is full.

**Reading it.** This machine sustains about **100K msgs/s**: the 1× target at N = 100K, the demo's ~22K msgs/s with
4.5× headroom, but **not the 3× burst** (brief NFR). The likely limit is the broker's 2 cores sharing a 10-core
laptop CPU with 8 producer processes; no send errors or dropped acks occurred (acks are awaited, never dropped;
workers stop at the end of the window, so "achieved" counts only what was acknowledged inside it). To retry:
`--smp=4` for Redpanda, or run the bench against a separate broker host; S9's throughput test repeats this.
