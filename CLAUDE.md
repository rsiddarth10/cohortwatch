# CohortWatch

Full spec: `docs/PROJECT_BRIEF.md`. Build only the current step.
Hard requirements: `docs/hackathon-problem-statement.pdf`. Detail reference only: `docs/reference-plan.pdf` (the brief wins).

## Pitch
The daily workshop queue that ranks vans by real risk and catches shared outbreaks early. Each van is compared to
its own normal (level + trend), minus what same-context peers are doing, confirmed k-of-n → incident with
plain-language clues → workshop queue, runaway alerts, and campaigns (fault family | model | duty | depot).

## Stack
- Node 22 LTS + TypeScript strict, npm workspaces. Vitest (coverage), ESLint + Prettier.
- Kafka `@confluentinc/kafka-javascript` · Postgres `pg` + `pg-copy-streams` · Redis `ioredis` · RNG `pure-rand`
- Later steps: schema registry `@kafkajs/confluent-schema-registry` [S2], `@duckdb/node-api` [1b],
  Express + zod + zod-to-openapi + helmet + express-rate-limit [S7], React + Vite [S8], Python 3.12 batch/ML [S3/S9].
- Pinned images (never `latest`):
  - `docker.redpanda.com/redpandadata/redpanda:v24.2.7`, `docker.redpanda.com/redpandadata/console:v2.7.2`
  - `postgres:16.4` [1a–S2] → `timescale/timescaledb-ha:pg16.15-ts2.30.1` [S3+]
  - `redis/redis-stack-server:7.4.0-v1`
- Named volumes; `docker compose down -v` is the clean reset.

## Rules (brief §2.2)
- Hexagonal: pure logic in `packages/domain` (no framework/infra imports), ≥ 80% Vitest coverage.
- Deterministic + config-driven. Per-VIN RNG seed = hash(global_seed, VIN): same output for any worker count.
- At-least-once delivery, idempotent effects everywhere.
- Sim event time is never mixed with wall-clock time. Latency is measured in wall time.
- No leaks: detection never reads ground truth or `sim.*`. Enforced by DB schema + role (`cw_app` has no access to `sim`).
- Synthetic data only: fictitious OEMs "Aurex" (OEM-A) and "Kestrel" (OEM-B), synthetic coordinates.
- Keep `docs/DECLARATIONS.md` current (OSS libraries, AI tools and what for).
- Small, clear commits after each working piece. CI on every push: install → lint → typecheck → test + coverage.
- `SIM_SCALE` = N vehicles. Dev 5,000; compose default 100,000. Checks use the configured N, never a literal 100,000.
- Commits go to THIS repo (`CohortWatch/.git`, origin github.com/rsiddarth10/cohortwatch), never the Desktop-level repo.

## Fallbacks (brief §2.3)
- If `@confluentinc/kafka-javascript` won't install and produce within ~30 min → `kafkajs` for that service + ADR in `docs/adr/`.
- If a step runs long, finish its done-check with fewer features; don't start the next step.

## Build order
| Step | Scope |
|---|---|
| 1a | Monorepo, pinned compose, migrations, registry seeding, healthy signal model, both OEM formats live, tests, CI |
| 1b | Plants, mess injection, clock modes (demo 360×, bench, burst, reset), history Parquet, ground truth, `simulator:verify` |
| S2 | Normaliser: adapters, validation, VIN check, DTC → family, units, anti-replay dedup (Redis), DLQ → canonical (Avro) |
| S3 | State processor: EW trend, baselines, peer adjustment, k-of-n, incidents + clues, runaway; Timescale image |
| S4 | Queue: scoring, at-risk, runaway, bay assignment, cost of waiting |
| S5 | Campaign engine: family key, Poisson guard, join once, union-find, sisters, firmware clue, money, outbox |
| S6 | Fix confirmation (`workshop.repairs.v1`) |
| S7 | API: JWT roles, RLS, keyset pagination, rate limits, audit, SSE, viewer masking |
| S8 | Web UI (board, queue, campaign page, vehicle-vs-own-normal chart) + template agent |
| S9 | Batch + evaluation, throughput + chaos tests, BDD, full CI |

## Repo layout
```
packages/domain/      pure logic: VIN, RNG, registry generation, trip + signal model, OEM formats
packages/common/      config (zod), logging (pino), Kafka producer helper, pg helpers
services/simulator/   registry seeding + live producer (worker processes own VIN ranges)
services/{normaliser,state-processor,campaign-engine,api,web,agent}/   later steps (placeholders)
infra/db/migrations/  ordered SQL migrations (schemas core + sim, roles)
infra/kafka/          topic-init script
tests/                integration / BDD (later)
docs/                 brief, ADRs (docs/adr/), DECLARATIONS.md, learning notes (docs/learning/)
```
