# Test and quality evidence

Every piece of evidence in one place (2026-10-01). CI runs install → lint → typecheck → unit + coverage → contract,
plus integration tests (Testcontainers), a Python batch test, Semgrep and Trivy, on every push:
[green run of the tagged commit `v1.0-submission`](https://github.com/rsiddarth10/cohortwatch/actions/runs/36790833718) ·
[all runs](https://github.com/rsiddarth10/cohortwatch/actions).

## Tests

| Kind | Count | Command | Where it runs | Evidence |
|---|---|---|---|---|
| **Unit** (Vitest) | **278 tests**, 27 files | `npm test` | CI | [coverage-summary.md](coverage-summary.md): `packages/domain` **99.3% lines**, 92.5% branches (CI gate ≥ 80%) |
| **Integration** (Testcontainers: real Redpanda, Redis, TimescaleDB with every migration) | **20 tests** in 7 files: normaliser 2, state processor 1, campaign engine 1, workshop 1, API 11 (security: RLS, masking, audit, roles, erasure, 409, rate limit, SSE), agent 3, Pact provider 1 | `npm run test:integration` | CI | `services/*/src/*.itest.ts` |
| **BDD** (Gherkin, vitest-cucumber) | **12 scenarios** covering brief §1.7 items 1–3 and 5–10 | in `npm test` / `npm run test:integration` | CI | `tests/bdd/{campaigns,workshop,api}.feature` |
| **Contract** (Pact) | 2 interactions (depot queue, campaign page); provider verified against the real API + DB | `npm run test:contract` (consumer), the provider is in the integration run | CI | `pacts/cohortwatch-web-cohortwatch-api.json` |
| **End-to-end** (Playwright, real OIDC login) | 2: lead → S1 campaign → approve the agent proposal → board shows "booked by lead"; viewer is masked | `npm run test:e2e` (needs the stack) | **local only** | passed at 30K (S8) and on the S10 clean clone |
| **Evaluation** (every §6 claim vs a baseline, from ground truth) | 11 claims × 2 scales | `npm run eval:all` | local (needs a run) | [docs/evaluation.md](../evaluation.md): 21 of 22 cells ✅ |
| **Clean-clone test** | fresh `git clone` of `main` into a temp folder; README quick-start steps with the 30K preset (`SIM_SCALE=30000 SIM_SPEED=360 AUTO_REPAIRS=on`, compose project `-p cwclean`); all 18 services healthy | `docker compose up -d` (README) | local | first campaign OPEN **332 s after `up`**; Playwright e2e **2/2 passed**; at T0+86 h: 2 campaigns open, 2 runaway cards, repairs **14 FIXED + 1 NOT_FIXED** (the planted bad repair), the agent proposal approved → booking applied, 326 queue items in 108 depots |

## Performance, load and resilience

| What | Result | Evidence |
|---|---|---|
| Simulator throughput (bench) | ~100K msgs/s sustained into Redpanda | [simulator-bench.md](../perf/simulator-bench.md) |
| Pipeline latency | event → incident p50 71 ms (5K); queue update p50 49–90 ms | [state-processor.md](../perf/state-processor.md), [workshop.md](../perf/workshop.md) |
| Hourly queue tick at 30K (S9 fix) | mean 8.95 → **2.31 s**, p95 27.5 → **5.7 s** | [workshop.md](../perf/workshop.md#s9-tick-scaling) |
| Query tuning (EXPLAIN ANALYZE) | 6,145 → 1,279 ms; 2,743 → 210 ms | [queries.md](../perf/queries.md) |
| **Load** (k6, 30K live) | ramp to 50 users: 173 req/s, **0 errors**, p95 383 ms | [load.md](../perf/load.md) |
| **Soak** (k6 10 min + 50 SSE clients) | 157 req/s, **0 errors**, p95 240 ms; 50/50 SSE streams, 0 dropped | [load.md](../perf/load.md) |
| **Chaos** (30K live) | recovery: Redis 10 s, normaliser kill 15 s, state-processor kill 50 s; reconcile balanced; no duplicate effects | [chaos.md](../perf/chaos.md) |
| Ingestion exactness | count in = out + DLQ + duplicates, balanced at 5K and 30K | [evaluation.md](../evaluation.md) |
| Observability | Prometheus + Grafana dashboard (8 panels) | [screenshot](../screenshots/5-grafana.png) |

## Security

| What | Result | Evidence |
|---|---|---|
| **SAST** (Semgrep, CI rule sets) | 0 findings | [reports/semgrep.txt](../security/reports/semgrep.txt) |
| **Dependencies, secrets, IaC misconfiguration** (Trivy) | 0 HIGH / 0 CRITICAL (5 found and fixed in S10) | [reports/trivy-fs.txt](../security/reports/trivy-fs.txt) |
| **DAST** (OWASP ZAP web baseline + authenticated API scan) | 0 High; the remaining Mediums are explained | [reports/README.md](../security/reports/README.md) |
| SBOM | CycloneDX 1.5, 593 components | [/sbom.cdx.json](../../sbom.cdx.json) |
| Threat model | STRIDE per trust boundary, each mitigation linked to code/tests; privacy | [threat-model.md](../security/threat-model.md) |
| Helm / Terraform checks | `helm lint` + `helm template` pass; `terraform fmt` + `validate` pass | [deploy/](../../deploy) |
| ML model | trained on seed 7, tested on seed 42; PR-AUC 0.37 vs 0.07 rule | [model-card.md](../ml/model-card.md) |
