# Step 1b walkthrough

- `packages/domain/src/scenario.ts`: plants (S1/S1b sisters, runaway, heatwave, decoys, firmware split) are a pure function of (registry, seed), applied inside the vehicle-day generator through hooks. *Q: why hooks?* History and the live stream share one model; history simply stops before the first onset.
- `packages/domain/src/mess.ts`: which message is duplicated, malformed, late or skewed is a function of (seed, VIN, seq), so reruns are identical by content. *Q: why only live?* History is the clean baseline; mess is what S2 must survive.
- `packages/domain/src/time.ts` `SimClock`: sim time = simStart + (wall − wallStart) × speed. Workers share the three numbers, so they agree on "now" without talking. Sim time never mixes with wall time; latency is wall time.
- `services/simulator/src/worker.ts` `ReleaseQueue`: out-of-order and offline messages wait in a heap until their release time. *Q: where does "late" come from?* Offline backlogs flush with their original `event_ts`/`seq`.
- `services/simulator/src/history.ts` + `lake.ts`: 7 days, 25M rows, 28 Parquet files, written to any S3 endpoint (RustFS here) with a manifest. Verify #5 checks the sisters' last day equals the plant-free model.
- `packages/domain/src/groundtruth.ts` → `sim.ground_truth` + `data/sim-private/`. *Q: how can't S2–S8 cheat?* The DB role `cw_app` has no USAGE on `sim` (check #14), and the directory is mounted only into the simulator.
- `services/simulator/src/repairs.ts`: `sim:repair` publishes to `workshop.repairs.v1`; the simulator applies it once (insert-if-absent), so redelivery is harmless. A designated bad repair keeps drifting.
- `services/simulator/src/cli/verify.ts`: 14 checks. Pure-model checks regenerate the deterministic stream; #12/#13 sample the live topics from "now", never from offset 0. It refuses to run if its N/seed/T0 differ from the seeded stack.
- Bench mode: every van once per wall second into `bench.raw.v1` only, cleared afterwards. *Q: result?* ~100K msgs/s on this laptop; the 3× burst is not reached (broker on 2 cores). See `docs/perf/simulator-bench.md`.
- `infra/kafka/topic-init.sh`: laptop caps (6 h, 64 MiB/partition, 16 MiB segments, 1 MiB preallocation) passed at create time. *Q: why small segments?* Redpanda deletes only closed segments.
- *Q: what surprised us?* A full disk: uncapped retention at ~5 GB/hour, plus 32 MiB preallocated per empty partition.
