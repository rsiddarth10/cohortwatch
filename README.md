# CohortWatch

The daily workshop queue that ranks vans by real risk, and catches shared outbreaks early.

Each van is compared to **its own normal**, minus what its peers in the same conditions are doing. Deviations that
persist become incidents with plain-language clues, and incidents that share a cause become one **campaign**
(fault family × model × duty × depot). Full scope: [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md).

> Status: **step 1a**. Monorepo, pinned infrastructure, registry seeding, healthy signal model, and both OEM
> formats streaming live. Detection, campaigns, the API and the UI come in later steps.

## Quick start

Requirements: Docker Desktop (about 8 GB RAM for Docker) and nothing else.

```bash
docker compose up -d        # first run builds the simulator image
docker compose ps           # everything healthy; topic-init and db-migrate "exited (0)"
```

| What | Where |
|---|---|
| Redpanda Console (topics, live messages) | http://localhost:8080 → Topics → `raw.oem-a.v1` / `raw.oem-b.v1` |
| Simulator metrics (Prometheus) | http://localhost:9464/metrics |
| Simulator throughput log (every 5 s) | `docker compose logs -f simulator` |
| Postgres | `localhost:15432`, db `cohortwatch` (roles `cw_sim`, `cw_app`) |
| Kafka API from the host | `localhost:19092` |

With no `.env`, compose runs the **submission scale: `SIM_SCALE=100000`** vehicles.

### Dev scale

```bash
cp .env.example .env        # sets SIM_SCALE=5000
docker compose up -d
```

Changing `SIM_SCALE` or `SIM_SEED` makes the simulator replace the registry on its next start. With the same seed
and N, seeding is skipped (idempotent).

### Clean reset

```bash
docker compose down -v      # removes containers AND the Postgres/Redpanda volumes
docker compose up -d
```

## What runs

| Service | Image | Role |
|---|---|---|
| `redpanda` | `redpandadata/redpanda:v24.2.7` | Kafka API + schema registry |
| `redpanda-console` | `redpandadata/console:v2.7.2` | Topic browser |
| `postgres` | `timescale/timescaledb-ha:pg16.15-ts2.30.1` | Relational core (3NF) + TimescaleDB + pgvector |
| `redis` | `redis/redis-stack-server:7.4.0-v1` | Hot state (used from S2) |
| `topic-init` | redpanda image | One-shot: creates all 9 topics |
| `db-migrate` | postgres image | One-shot: applies `infra/db/migrations/*.sql` once each |
| `simulator` | built from `services/simulator/Dockerfile` | Seeds the registry, streams both OEM formats |

The simulator streams at **1× live time** in step 1a (sim time = wall time). Measured at N = 100,000 on the dev
laptop (i7-1255U, 32 GB, Docker Desktop/WSL2): about **60–70 msgs/s** around midday, when most vans are on shift.
That is the correct real-time rate: vans report every 30 sim-minutes while driving and every 4 hours when parked.
First start seeds 100K vehicles by COPY in about 52 s; later starts skip seeding. The 360× demo clock and the bench
mode (~100K msgs/s target) arrive in step 1b.

## Useful checks

```bash
# vehicle count equals the configured N
docker compose exec postgres psql -U postgres -d cohortwatch -c "select count(*) from core.vehicle"
# cw_app cannot read simulator-private data (expect: permission denied for schema sim)
docker compose exec -e PGPASSWORD=cw_app_dev postgres psql -h localhost -U cw_app -d cohortwatch -c "select * from sim.vehicle_profile limit 1"
# one message from each OEM feed
docker compose exec redpanda rpk topic consume raw.oem-b.v1 -n 1
```

## Develop

```bash
npm install
npm run lint        # ESLint + Prettier
npm run typecheck   # tsc -b (strict)
npm test            # Vitest + coverage (packages/domain must stay >= 80%)
npm run simulator   # run the simulator on the host against the compose infra (reads services/simulator/config/simulator.yaml)
```

Repository layout and rules: [CLAUDE.md](CLAUDE.md). Open-source and AI declarations: [docs/DECLARATIONS.md](docs/DECLARATIONS.md).

## Data

All data is synthetic. The OEMs ("Aurex", "Kestrel"), their VIN manufacturer codes, tenants, depots, regions and
coordinates are fictitious. Drivers exist only as pseudonyms.
