# Declarations

Required by the problem statement §14: all open-source components and AI tools are declared here. Kept current from step 1a.

## AI tools

| Tool | Used for | Human role |
|---|---|---|
| Claude Code (Anthropic, Claude Opus model) | Reviewing the brief against the problem statement; scaffolding the monorepo; writing simulator, domain, migrations, compose, CI, API, web app, tests and docs from the author's brief. S9: evaluation tooling (`eval:all`), the pausable demo clock, the ML export/training job, k6/chaos/Pact tests, query tuning, the batched queue tick, Prometheus/Grafana config. S10: diagrams, Helm chart, Terraform, threat model, AsyncAPI, running the scans (Semgrep, Trivy, ZAP), SBOM, the clean-clone test, README | Author wrote the product brief and every step prompt, approved each step's plan, set the priorities and time caps, and reviews the commits and reports. Two steps (S9, S10) ran unattended overnight on the author's written instructions; every decision taken there is listed in docs/overnight-report-2.md and -3.md |

The product idea, scope, data design (docs/PROJECT_BRIEF.md) and all decisions are the author's own.

No LLM or AI service runs inside CohortWatch: the S8 "agent" is a template engine over existing evidence (ADR 0020).
The S9 at-risk classifier is a classical gradient-boosting model trained offline on simulated data (model card:
docs/ml/model-card.md); it is not wired into the queue unless it beats the rules.

## Open-source software

### Runtime (Node.js services)

| Package | License | Why |
|---|---|---|
| `@confluentinc/kafka-javascript` (librdkafka) | MIT | Kafka producer: idempotent, acks=all, zstd |
| `pg`, `pg-copy-streams` | MIT | Postgres client; bulk `COPY` for registry seeding and the telemetry writer (S3) |
| `pure-rand` | MIT | Seeded PRNG (xoroshiro128+) for deterministic simulation |
| `pino` | MIT | Structured JSON logging |
| `zod` | MIT | Config validation |
| `yaml` | ISC | Config file parsing |
| `prom-client` | Apache-2.0 | Prometheus `/metrics` |
| `@duckdb/node-api` (DuckDB) | MIT | Writing history and ground truth as Parquet; reading it back in `simulator:verify` |
| `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` | Apache-2.0 | S3-compatible lake uploads (any endpoint) |
| `ioredis` | MIT | Normaliser per-VIN anti-replay state (MGET + Lua compare-and-set per batch) |
| `@kafkajs/confluent-schema-registry` | MIT | Registering the canonical Avro schema (BACKWARD compatibility) |
| `oidc-provider` | MIT | S7: local OpenID Connect issuer (code + PKCE, JWKS, JWT access tokens) — ADR 0018 |
| `jose` | MIT | S7: JWT verification in the API (JWKS, issuer, audience, expiry) |
| `express`, `helmet`, `express-rate-limit` | MIT | S7: API server, security headers, per-user rate limits |
| `@asteasolutions/zod-to-openapi` | MIT | S7: OpenAPI 3 document generated from the zod schemas (`/openapi.json`, `/docs`) |
| `avsc` | MIT | Avro encoding of canonical events (Confluent wire format); decoding in the state processor with the writer schema fetched by id (S3) |

### Web app (S8)

| Package | License | Why |
|---|---|---|
| React, React DOM | MIT | UI |
| `react-router-dom` | MIT | Routing (board, campaign, vehicle, agent & audit) |
| Recharts | MIT | Vehicle-vs-own-normal chart (band, incident and repair markers) |
| `oidc-client-ts` | Apache-2.0 | Browser OIDC login (code + PKCE) |
| Vite, `@vitejs/plugin-react` | MIT | Dev server and build |
| Swagger UI (`swagger-ui-dist`, loaded from unpkg on `/docs`) | Apache-2.0 | API explorer |

### Batch jobs (Python, S3)

| Library | License | Why |
|---|---|---|
| `duckdb` 1.5.5 (+ `httpfs`, `postgres` extensions) | MIT | Baselines job: reads the history Parquet from the lake and the registry from Postgres, aggregates in SQL |
| `psycopg[binary]` 3.2.10 | LGPL-3.0 | Baselines job: one-transaction COPY into Postgres |
| `pytest` 8.4.2 | MIT | Unit test of the baselines job (CI) |
| `scikit-learn` 1.7.2, `numpy` 2.3.3, `pandas` 2.3.3 | BSD-3-Clause | S9: at-risk classifier (gradient boosting), evaluation metrics (`ml/at_risk`) |

### Development

| Package | License | Why |
|---|---|---|
| TypeScript | Apache-2.0 | Language (strict mode) |
| Vitest, `@vitest/coverage-v8` | MIT | Unit tests and coverage |
| ESLint, `typescript-eslint`, `@eslint/js`, `globals`, `eslint-config-prettier` | MIT | Linting |
| Prettier | MIT | Formatting |
| `testcontainers`, `@testcontainers/redpanda` | MIT | Integration tests against real Redpanda + Redis (+ TimescaleDB from S3) containers (from S2) |
| `@amiceli/vitest-cucumber` 8.0.0 | ISC | BDD: Gherkin feature files (`tests/bdd/*.feature`) run inside Vitest (S5) |
| `supertest` | MIT | S7: API integration tests (HTTP against the app, real Postgres with RLS) |
| Playwright (`@playwright/test`, Chromium) | Apache-2.0 | S8: e2e smoke through the real login (local only) and the screenshots |
| Pact JS (`@pact-foundation/pact`, Pact FFI) | MIT | S9: consumer-driven contract web → API; provider verification against the real API |
| k6 (`grafana/k6:0.54.0` image) | AGPL-3.0 (used as a separate tool, not linked) | S9: load and soak tests of the API |

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
| nginx unprivileged `nginxinc/nginx-unprivileged:1.27.3-alpine` | BSD-2-Clause | S8: serves the web app; proxies `/api` (SSE unbuffered). Unprivileged image (uid 101) since S10 |
| Prometheus `v2.55.1` | Apache-2.0 | S9: scrapes every service's `/metrics` (profile `observability`) |
| Grafana `11.3.1` | AGPL-3.0 (used as a separate service, unmodified) | S9: the provisioned pipeline dashboard (profile `observability`) |
| Python `3.12.11-slim-bookworm` | PSF-2.0 | Runtime of the baselines batch job (S3) and the ML job (S9) |

### CI

| Tool | License | Why |
|---|---|---|
| GitHub Actions (`actions/checkout`, `setup-node`, `upload-artifact`) | MIT | CI pipeline |
| Semgrep | LGPL-2.1 | SAST (fails on ERROR findings) |
| Trivy (`aquasecurity/trivy-action`) | Apache-2.0 | Dependency, secret and misconfiguration scan (fails on CRITICAL) |

### Security, deployment and documentation tooling (S9–S10, run as pinned Docker images or `npx`; not shipped)

| Tool | License | Why |
|---|---|---|
| OWASP ZAP `ghcr.io/zaproxy/zaproxy:2.15.0` | Apache-2.0 | DAST: web baseline scan + authenticated API scan from the OpenAPI spec (docs/security/reports) |
| Semgrep `semgrep/semgrep:1.95.0` | LGPL-2.1 | SAST report files (the same rule sets as CI) |
| Trivy `aquasec/trivy:0.57.1` | Apache-2.0 | Dependency, secret and IaC misconfiguration report files |
| CycloneDX npm (`@cyclonedx/cyclonedx-npm` 1.19.3) | Apache-2.0 | **SBOM**: [`/sbom.cdx.json`](../sbom.cdx.json) (CycloneDX 1.5, 593 components) |
| Helm `alpine/helm:3.16.2` | Apache-2.0 | `helm lint` / `helm template` of `deploy/helm/cohortwatch` |
| Terraform `hashicorp/terraform:1.9.8`, AWS provider `~> 5.70`, TLS provider `~> 4.0` | BUSL-1.1 (Terraform CLI; used as a tool, not distributed) / MPL-2.0 (providers) | `fmt` / `validate` of `deploy/terraform/aws` (never applied) |
| Mermaid 11.4.1 (loaded from jsDelivr by `docs/diagrams/render.mjs`) | MIT | Rendering the diagrams to SVG/PNG |

## Data

**Synthetic data statement.** Every record in CohortWatch is generated by its own seeded simulator: vehicles, VINs,
depots, coordinates, drivers (pseudonyms only), telemetry, fault codes, firmware history, repairs and the past
campaigns. There are no real people, vehicles, addresses, OEM data or personal data. The OEMs "Aurex" (OEM-A) and
"Kestrel" (OEM-B), their feed formats, the VIN manufacturer codes (`7AX`, `7KS`), the regions and all names are
fictitious. Coordinates are synthetic. The ML model (S9) was trained and tested only on these simulated runs.

**Past campaigns (S5).** The 30 "similar past campaigns" in `core.past_campaign` are **synthetic and fictional**. They are generated deterministically from 13 templates in `packages/domain/src/campaign/similarity.ts`; their codes (`PC-2024-101` …), root causes and resolution notes describe no real recall or supplier. Similarity uses a numeric feature vector and pgvector (part of the TimescaleDB HA image), with no external embedding API.

**Money (S5).** The "cost if not fixed" rates (tow ₹8,000, 3 downtime days × ₹6,000, unplanned-repair premium ₹25,000, planned fix ₹12,000 per van) are illustrative assumptions in config, not market data.

**Queue (S4).** The score weights, the bay threshold and the daily breakdown hazards used for the "cost of waiting" are illustrative assumptions in config (ADR 0014), not fitted to real fleet data. The queue holds no driver ids; behaviour is per van, relative to its duty.
