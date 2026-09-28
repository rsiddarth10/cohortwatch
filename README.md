# CohortWatch

The daily workshop queue that ranks vans by real risk, and catches shared outbreaks early.

Each van is compared to **its own normal**, minus what its peers in the same conditions are doing. Deviations that
persist become incidents with plain-language clues, and incidents that share a cause become one **campaign**
(fault family × model × duty × depot). Full scope: [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md).

> Status: **step 1b** — a 100,000-vehicle simulator with planted outbreaks, decoys and realistic mess, streaming two
> OEM formats live, plus 7 days of history in an S3 lake and a private ground truth. Detection, campaigns, the API
> and the UI come in later steps.

## Quick start

Requirements: Docker Desktop (about 8 GB RAM for Docker) and nothing else.

```bash
docker compose up -d        # first run builds the simulator image
docker compose ps           # all healthy; topic-init, db-migrate and lake-init "exited (0)"
docker compose logs -f simulator
```

With no `.env`, compose runs the **submission scale, `SIM_SCALE=100000`**, in **demo mode**. On first boot the
simulator:

1. seeds the registry (100K vans) into Postgres with `COPY`,
2. applies the plants (brief §5.4) and writes the ground truth,
3. writes 7 sim-days of plant-free history as Parquet to `s3://cohortwatch-lake/history/dt=…/`,
4. streams the demo: **360×** (1 wall-second = 6 sim-minutes), from T0 to **T0+72 h in about 12 wall-minutes**,
   then keeps running.

Restarts are idempotent: the registry, plants and history are skipped when unchanged, and the demo clock resumes
where it stopped.

| What | Where |
|---|---|
| Redpanda Console (topics, live messages) | http://localhost:8080 → Topics → `raw.oem-a.v1` / `raw.oem-b.v1` |
| Lake console (RustFS) | http://localhost:19001 (user `cohortwatch`, password `cohortwatch-dev-secret`) → bucket `cohortwatch-lake` |
| Simulator metrics | http://localhost:9464/metrics (sent by topic and format, msgs/s, mess by kind, clock lag, repairs) |
| Simulator clock | http://localhost:9464/clock |
| Postgres | `localhost:15432`, db `cohortwatch` (roles `cw_sim`, `cw_app`) |
| Kafka API from the host | `localhost:19092` |
| S3 API from the host | `http://localhost:19000` |

### What to look at in the Console

- **Format switch:** from T0+12 h, `raw.oem-a.v1` carries `aurex.v2` (°C, renamed fields) instead of `aurex.v1` (°F).
  Look at the `x-source-format` header.
- **Mess (on purpose):** duplicates (same VIN + seq twice), out-of-order and late messages, truncated or incomplete
  JSON, invalid VINs, unparseable fault codes, impossible values, ±90 s clock skew on 0.5% of vans.

## Scenario (brief §5.4)

| Plant | What happens |
|---|---|
| S1 outbreak | 15 vans at depot `D-001` (Kestrel Haulmark diesel, urban) drift +8…+12 °C from T0+6 h; 3 late sisters from T0+24 h; one is a bad repair |
| S1b | 8 vans of the same model/duty at `D-005` (another region), onset T0+18 h |
| Runaway | 1 Aurex linehaul van, driving continuously T0+10 h → T0+34 h, accelerating to 110 °C |
| Decoys | 6 scattered COOLING drifts at 6 depots; 2 other-model vans at `D-001` |
| Heatwave | region R3 +10 °C over T0+12 h … T0+60 h |
| Also | 20 loud-but-stable vans, 3 sensor glitches, naturally-hot vans (~2% of diesel), firmware 4.2.1 rollout (16/18 sisters vs 20/42 peers) |
| Surge | T0+24 h … T0+42 h: 10-minute driving cadence (≈3× send rate) |

Every choice and timing is in `sim.scenario_manifest`. Ground truth is in `sim.ground_truth` and
`data/sim-private/ground_truth.parquet`.

> **No leaks:** detection services must never read ground truth. The database enforces it (`cw_app` has no access to
> schema `sim`), and `data/sim-private` is mounted only into the simulator (and, later, the evaluation job).

## Commands

| Command | What it does |
|---|---|
| `npm run sim:repair -- --vin <VIN>` | Publishes `{vin, repaired_at}` to `workshop.repairs.v1` at the current sim time. The van's drift stops within ~2 sim-hours, except the designated bad-repair sister. |
| `npm run sim:watch -- --vin <VIN> [--vin <VIN>]` | Follows vans on the raw topics and prints their mean driving coolant per 2 sim-hours (shows a repair working) |
| `npm run simulator:verify` | Runs the 14 checks of brief §5.8 and writes `docs/perf/verify-1b.txt` (needs the demo running for the 2-minute live sample). It runs on the host, whose config says N=5000: against the compose stack use `SIM_SCALE=100000 npm run simulator:verify`. It refuses to run if N/seed/T0 differ from what the stack was seeded with |
| `npm run sim:bench` | Stops the demo and runs bench mode: every vehicle every wall-second for 120 s, 8 workers |
| `npm run sim:bench:burst` | Bench with `--burst`: 60 s at 1×, **5 minutes at 3×**, 60 s at 1× |
| `npm run sim:reset` | Clears the demo clock, repairs and history; the next start replays from T0 |
| `npm run history:big` | Writes 30 days at 2-minute intervals (≈ 1 billion rows at 100K) to its own prefix. Not run by default; needs a lot of disk and time. |

After a bench run, bring the demo back with `docker compose up -d simulator`.

For a completely clean demo, prefer `docker compose down -v && docker compose up -d`: from step S2 on, downstream
services remember sequence numbers, so replaying from T0 into an existing stack would look like duplicates.

### Settings (env or `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SIM_SCALE` | 100000 | vehicles (use 5000 for development: `cp .env.example .env`) |
| `SIM_WORKERS` | 4 | worker processes; output is identical for any value |
| `SIM_MODE` / `SIM_SPEED` | demo / 360 | `live` = 1× wall time |
| `PLANTS` | on | planted scenarios |
| `MESS` | on | mess injection on the raw topics |
| `AUTO_REPAIRS` | off | `on` repairs the S1 sisters at ~T0+30 h for unattended demos |
| `DEPOT_TRANSFER` | off | `on` moves 2 S1 sisters to another depot at T0+30 h |
| `GLOBAL_COOLANT_THRESHOLD_C` / `GLOBAL_BATT_TEMP_THRESHOLD_C` | 97 / 47 | simple global thresholds, used only by checks #10/#11 and the S9 baseline |
| `LAPTOP_RETENTION` / `KAFKA_PARTITION_BYTES` | on / 67108864 | laptop disk caps on the high-volume topics (see [Disk](#disk)) |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `LAKE_BUCKET` | RustFS in compose | any S3-compatible store works |

### Clean reset

```bash
docker compose down -v      # removes containers AND the Postgres, Redpanda and lake volumes
rm -rf data/sim-private     # private ground truth file
docker compose up -d
```

## Disk

A 100K-van demo writes about 18K msgs/s on average to the raw topics (measured: ~80 B per message on disk after zstd,
≈ 5 GB/hour uncapped), so on a laptop Kafka is capped:

- `LAPTOP_RETENTION=on` (default): raw and canonical topics keep 6 h **and** at most `KAFKA_PARTITION_BYTES`
  (default 64 MiB) per partition, in 16 MiB segments (closed after 10 min if idle), and Redpanda preallocates 1 MiB
  per partition instead of 32 MiB (≈ 6.4 GB of empty files across 201 partitions otherwise). At demo rate one raw partition holds about **36 wall-minutes**
  (measured: ~384 msgs/s × ~80 B per partition). A consumer that is stopped for longer than that loses the oldest data; fine for
  local dev, not for production (`LAPTOP_RETENTION=off` = the brief's 3 days).
- Worst case on disk: (cap + one open segment) × partitions = 80 MiB × 48 raw ≈ **3.8 GB** today, ≈ **7.5 GB** once
  `telemetry.canonical.v1` fills from S2. `bench.raw.v1` can add up to 3.8 GB during a bench run; the simulator clears
  it when the run ends (logically at once; Redpanda frees the files within ~20 min, measured 4.6 GB → 1 MB).
- Planned: raise `KAFKA_PARTITION_BYTES` to 256–512 MiB once Docker's disk image moves to the larger D: drive.
- Don't run `npm run history:big` on a laptop (≈1B rows, 20–30 GB in the lake).
- Change the caps: set the env vars (or `.env`), then `docker compose run --rm topic-init` (applies to existing topics).

## What runs

| Service | Image | Role |
|---|---|---|
| `redpanda` | `redpandadata/redpanda:v24.2.7` | Kafka API + schema registry |
| `redpanda-console` | `redpandadata/console:v2.7.2` | Topic browser |
| `postgres` | `timescale/timescaledb-ha:pg16.15-ts2.30.1` | Relational core (3NF) + TimescaleDB + pgvector |
| `redis` | `redis/redis-stack-server:7.4.0-v1` | Hot state (used from S2) |
| `rustfs` | `rustfs/rustfs:1.0.0` | S3-compatible lake (MinIO's public images were withdrawn) |
| `topic-init` / `db-migrate` / `lake-init` | redpanda / postgres / `amazon/aws-cli:2.37.4` | One-shot: topics, migrations, lake bucket |
| `simulator` | built from `services/simulator/Dockerfile` | Seeds, plants, history, demo stream |

## Measured (step 1b)

See [docs/perf/verify-1b.txt](docs/perf/verify-1b.txt) and [docs/perf/simulator-bench.md](docs/perf/simulator-bench.md).

## Develop

```bash
npm install
npm run lint        # ESLint + Prettier
npm run typecheck   # tsc -b (strict)
npm test            # Vitest + coverage (packages/domain must stay >= 80%)
```

Repository layout and rules: [CLAUDE.md](CLAUDE.md). Open-source and AI declarations: [docs/DECLARATIONS.md](docs/DECLARATIONS.md).

## Data

All data is synthetic. The OEMs ("Aurex", "Kestrel"), their VIN manufacturer codes, tenants, depots, regions and
coordinates are fictitious. Drivers exist only as pseudonyms.
