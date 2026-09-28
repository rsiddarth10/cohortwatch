# Step 1a walkthrough

- `packages/domain/src/vin.ts`: ISO 3779 check digit (transliterate, weights, mod 11, 10 → X). *Q: why reject I/O/Q?* They look like 1/0.
- `packages/domain/src/rng.ts`: seed = hash(global_seed, VIN, stream). *Q: why per-VIN seeds?* Output is identical for any worker split.
- `packages/domain/src/registry.ts`: the whole fleet is a pure function of (seed, N, T0). S1/S1b depots are sized explicitly so they hold at any N.
- `packages/domain/src/simulate.ts`: event-driven. It plans ignition windows per vehicle-day, then computes readings only at report times, so the cost is O(messages), not O(ticks).
- *Q: how is seq contiguous across restarts?* Days before "now" are replayed and not emitted, so seq = total events since the world epoch.
- *Q: how is the odometer consistent?* Each message's speed is the mean over its interval, and odo += speed × Δt. A test checks this exactly.
- `FleetStream`: a min-heap keyed by (eventTs, vehicle index). *Q: complexity?* O(log V) per event, with deterministic ordering.
- `infra/db/migrations/`: 3NF core, EXCLUDE constraints on validity ranges (btree_gist), and a composite FK that keeps vehicle.tenant_id honest.
- *Q: how do you stop leaks?* `cw_app` has no USAGE on schema `sim`, so the database enforces it rather than convention.
- `services/simulator/src/seed.ts`: COPY in one transaction behind an advisory lock. It skips when (seed, N, T0) already match, so it's idempotent.
- `packages/common/src/kafka.ts`: idempotent producer, acks=all, zstd, linger, key = VIN (per-vehicle ordering within a partition).
- `services/simulator/src/main.ts`: a supervisor forks W workers over VIN ranges, aggregates their counts over IPC into /metrics and a 5 s log, and fails fast when a worker dies.
- `docker-compose.yml`: pinned images, healthchecks, and one-shot jobs gated by `service_completed_successfully`. `down -v` is the reset.
- *Q: why does it only send ~65 msgs/s?* 1× real time is honest: 30-minute cadence and 4-hour heartbeats. The throughput story is bench mode in 1b.
- CI: lint → typecheck → tests with 80% domain coverage, plus Semgrep (ERROR) and Trivy (CRITICAL), on every push.
