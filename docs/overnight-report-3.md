# Overnight report 3: Step 10 (submission deliverables)

Run: 2026-10-01 03:58 → 04:58 IST (hard stop 10:00; finished early). Plan: [docs/plans/s10.md](plans/s10.md). No feature work; no
refactors. S9 closed first ([overnight-report-2.md](overnight-report-2.md)).

## Done-check

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | **Clean-clone test** | **done: PASSED** | Fresh `git clone` of `main` into a temp folder, README steps with the 30K preset, compose project `-p cwclean` (main stack stopped). Build from the clone's own sources: 10 s (every layer cached, identical inputs). **`up` → first campaign OPEN: 332 s.** 18/18 services healthy. Playwright e2e **2/2 passed** (lead approves the agent proposal → board shows "booked by lead"; viewer masked). At T0+86 h: 2 campaigns OPEN, **2 runaway cards**, repairs **14 FIXED + 1 NOT_FIXED** (the planted bad repair), proposal APPROVED → 1 booking, 326 queue items in 108 depots. README fix: the quick start now includes `AUTO_REPAIRS=on`, so repair → FIXED is part of the story |
| 2 | Diagrams | **done** | [docs/diagrams/](diagrams/README.md): C4 context, C4 container (protocol on every arrow; the README architecture image), data flow of one reading, sequence: happy path, sequence: failure path (duplicate + late + state-processor crash/replay), ER of `core`, Kubernetes deployment. Mermaid sources + SVG + PNG |
| 3 | Helm chart | **done** | [deploy/helm/cohortwatch](../deploy/helm/cohortwatch): external Kafka/Postgres/Redis; readiness/liveness probes; resources; HPA for normaliser, state processor and API; ExternalSecret (AWS Secrets Manager); TLS ingress (cert-manager); NetworkPolicies (default deny + explicit allows); non-root, read-only root filesystem. `helm lint` + `helm template` pass (7 Deployments, 7 Services, 3 HPAs, Ingress, 5 NetworkPolicies, ExternalSecret) |
| 4 | Terraform (AWS) | **done** | [deploy/terraform/aws](../deploy/terraform/aws/README.md): VPC, private EKS + IRSA, TimescaleDB node group (**self-managed on EKS; RDS lacks the TimescaleDB extension**, decision documented), MSK (TLS, mTLS for OEM feeds, KMS), ElastiCache (TLS, KMS), S3 lake (SSE-KMS, TLS-only, no public access), Secrets Manager, KMS key, IAM. `fmt` + `validate` pass; **not applied**. Rough cost **≈ USD 2,850/month for 100K vans** |
| 5 | STRIDE threat model | **done** | [docs/security/threat-model.md](security/threat-model.md): one table per boundary (OEM feeds → ingest, browser ↔ API, services ↔ stores, agent), each mitigation linked to code/tests; mTLS for OEM clouds; privacy (pseudonymous drivers, masking, erasure, retention) |
| 6 | ADRs | **done** | 0023 device-free ingestion (no MQTT), 0024 Node over Python; [ADR index](adr/README.md) with all 24 |
| 7 | README final pass | **done** | What it is (3 lines + architecture image), 5-minute quick start (30K + `AUTO_REPAIRS`), honest 100K laptop note, logins, story walkthrough, documentation index, test commands, known issues; settings table completed |
| 8 | DECLARATIONS final pass | **done** | Libraries with licences incl. S9–S10 tooling; AI tool use and the author's role; SBOM reference; synthetic data statement |
| 9 | Missing evidence | **done** | See below |
| 10 | Tag `v1.0-submission` | **done** | Annotated tag on `1ca96d4`, pushed after the clean clone passed and **CI was green on that commit** (lint, typecheck, unit + coverage, Pact consumer, integration incl. the Pact provider, Python batch, Semgrep, Trivy): [run 36790833718](https://github.com/rsiddarth10/cohortwatch/actions/runs/36790833718). The clean clone ran at `5642156`. Later commits changed docs, deploy and the web image; the new web image (unprivileged nginx + security headers) was rebuilt from the pulled commits in the clone stack and verified (200 OK as uid 101, the viewer e2e passed, ZAP re-scanned) |

### Item 9 in detail

| Evidence | Result | File |
|---|---|---|
| DAST: OWASP ZAP web baseline | first run 0 High, 3 Medium, 3 Low → headers fixed → **0 High, 0 Low**, 1 accepted Medium (`style-src 'unsafe-inline'`) + "ZAP out of date" | [reports/](security/reports/README.md) |
| DAST: OWASP ZAP API scan (authenticated, from the OpenAPI spec) | **0 High**; all SQL injection / XSS rules pass | same |
| Semgrep report | 0 findings (65 rules, 370 files) | `docs/security/reports/semgrep.{txt,json}` |
| Trivy report | first run 5 HIGH/CRITICAL (IaC + web image) → fixed → **0** | `docs/security/reports/trivy-fs.txt` |
| Coverage | `packages/domain` 99.3% lines, 92.5% branches; per-package table | [test-evidence/coverage-summary.md](test-evidence/coverage-summary.md) |
| SBOM | CycloneDX 1.5, 593 components | [/sbom.cdx.json](../sbom.cdx.json) |
| Algorithms and SQL | 13 algorithms (pseudocode, complexity, scale) + EXPLAIN before/after | [algorithms-and-sql.md](algorithms-and-sql.md) |
| C4 L1 + L2 (protocols), 2 sequence diagrams | done | [diagrams/](diagrams/README.md) |
| AsyncAPI | every topic: key, format, producer, consumers, partitions, retention | [asyncapi.yaml](asyncapi.yaml) |
| Security in the DevOps pack | TLS ingress, NetworkPolicies, External Secrets; KMS at rest + TLS in transit in Terraform; mTLS note for OEM feeds | Helm, Terraform, threat model |
| Test evidence index | one table for everything | [test-evidence/README.md](test-evidence/README.md) |

## Decisions I made (and why)

1. **Clean clone as `-p cwclean`, built with `--build` from the clone's sources.** Compose pins `name: cohortwatch`,
   so a distinct project name was required. The layer cache was used (10 s build). The clone's committed sources were
   identical, so cache hits are legitimate; a truly cold build takes ~10–15 min and needs the network.
2. **ZAP ran against the clean-clone stack (30K), not a 5K main stack.** Restarting the main stack at 5K would have
   needed `down -v`, which this step forbids. The web app and API code are identical; only the data scale differs.
3. **Fixed, not ignored, what the scans found.** Web security headers (CSP, anti-clickjacking, nosniff,
   Permissions-Policy, no version banner). EKS private endpoint only. Unprivileged nginx image. Read-only root
   filesystem in Helm. One documented `trivy:ignore` remains: node HTTPS egress via NAT, which is needed for images
   and the IdP's JWKS.
4. **Accepted `style-src 'unsafe-inline'`** (inline chart styles), explained in the reports README.
5. **The first ZAP API scan was invalid** (wrong base path → 404s → a false-positive "SQL Injection"). It was re-run
   through the web proxy, and both runs are explained.
6. **TimescaleDB self-managed on EKS in Terraform**, not RDS (no TimescaleDB extension on RDS). Timescale Cloud is
   the documented alternative.
7. **Cost estimate** from on-demand list prices (ap-south-1), marked rough (±30%).
8. **CI turned red twice** and was fixed both times: Trivy IaC CRITICALs after the Terraform push (fixed in `204132c`), then Prettier failing on the Helm Go templates, which are not YAML (fixed in `1ca96d4`). The tag is on the first fully green commit.
9. **The e2e lead test timed out once** on the clean clone, when run long after the story moment (it waits for a
   pending proposal). Its earlier run on the same stack passed, and the viewer test passed with the new CSP.

## Deleted (pre-approved only)

The temp clean-clone folder; the clean clone's own compose stack and volumes (`-p cwclean down -v`); my Terraform
provider cache (`.terraform/`, 693 MB); two scan run logs I created. **Main project: stopped, never `down -v`.**

## Not deleted (for you to decide)

- The main stack's volumes (last run: 30K run C). `docker compose down -v` is the clean reset before recording.
- `data/ml/*.csv.gz` (ML datasets, gitignored). The Docker build cache (~12 GB reclaimable, `docker builder prune`).
- Scanner images pulled tonight (ZAP, Semgrep, Trivy, Helm, Terraform, k6): `docker image rm …` if disk is needed.

Disk at the end: C: 35 GB free, D: 184 GB free.
