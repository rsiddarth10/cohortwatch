# Declarations

Required by the problem statement §14: all open-source components and AI tools are declared here. Kept current from step 1a.

## AI tools

| Tool | Used for | Human role |
|---|---|---|
| Claude Code (Anthropic, Claude Opus model) | Reviewing the brief against the problem statement; scaffolding the monorepo; writing simulator, domain, migrations, compose, CI, tests and docs from the author's brief | Author wrote the product brief and step prompts, approved each step's plan, reviews every commit and runs the done-checks |

The product idea, scope, data design (docs/PROJECT_BRIEF.md) and all decisions are the author's own.

## Open-source software

### Runtime (Node.js services)

| Package | License | Why |
|---|---|---|
| `@confluentinc/kafka-javascript` (librdkafka) | MIT | Kafka producer: idempotent, acks=all, zstd |
| `pg`, `pg-copy-streams` | MIT | Postgres client; bulk `COPY` for registry seeding |
| `pure-rand` | MIT | Seeded PRNG (xoroshiro128+) for deterministic simulation |
| `pino` | MIT | Structured JSON logging |
| `zod` | MIT | Config validation |
| `yaml` | ISC | Config file parsing |
| `prom-client` | Apache-2.0 | Prometheus `/metrics` |
| `@duckdb/node-api` (DuckDB) | MIT | Writing history and ground truth as Parquet; reading it back in `simulator:verify` |
| `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` | Apache-2.0 | S3-compatible lake uploads (any endpoint) |

### Development

| Package | License | Why |
|---|---|---|
| TypeScript | Apache-2.0 | Language (strict mode) |
| Vitest, `@vitest/coverage-v8` | MIT | Unit tests and coverage |
| ESLint, `typescript-eslint`, `@eslint/js`, `globals`, `eslint-config-prettier` | MIT | Linting |
| Prettier | MIT | Formatting |

### Infrastructure images

| Image | License | Why |
|---|---|---|
| Redpanda `v24.2.7` | BSL 1.1 (source-available; free for this use) | Kafka-API broker + schema registry |
| Redpanda Console `v2.7.2` | BSL 1.1 | Topic browser |
| TimescaleDB HA `pg16.15-ts2.30.1` (PostgreSQL, TimescaleDB, pgvector) | PostgreSQL / Timescale License / PostgreSQL | Relational core, time-series, vectors |
| Redis Stack Server `7.4.0-v1` | RSALv2 / SSPLv1 | Hot state, dedup, rate limits (from S2) |
| RustFS `1.0.0` | Apache-2.0 | S3-compatible object store for the Parquet lake |
| AWS CLI `2.37.4` | Apache-2.0 | One-shot bucket creation (`lake-init`) |
| Node.js `22.23.3-bookworm-slim` | MIT | Service runtime |

### CI

| Tool | License | Why |
|---|---|---|
| GitHub Actions (`actions/checkout`, `setup-node`, `upload-artifact`) | MIT | CI pipeline |
| Semgrep | LGPL-2.1 | SAST (fails on ERROR findings) |
| Trivy (`aquasecurity/trivy-action`) | Apache-2.0 | Dependency, secret and misconfiguration scan (fails on CRITICAL) |

## Data

Synthetic only. No real people, vehicles, addresses, OEM data or personal data. VIN manufacturer codes (`7AX`, `7KS`) and all names are fictitious.
