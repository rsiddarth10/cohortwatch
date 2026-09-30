# Threat model (STRIDE)

Scope: the CohortWatch stack as built (docker compose) and its production shape (Helm on EKS, Terraform on AWS).
Data is synthetic, but the model assumes a real fleet. One table per trust boundary; every mitigation points to
the code, config or test that implements it. "Gap" marks what is not built.

Diagrams: [C4 container](../diagrams/c4-container.png) · [deployment](../diagrams/deploy-k8s.png).

## Boundary 1: OEM clouds (feeds) → ingestion (Kafka → normaliser)

Device-free ingestion (ADR 0023): **the OEM cloud is "the device"**. No vehicle talks to CohortWatch.

| STRIDE | Threat | Mitigation | Where |
|---|---|---|---|
| **S**poofing | A third party writes fake readings into a raw topic | Production: **mTLS per OEM** (client certificate issued at onboarding) + Kafka ACLs, so each OEM principal can write only its own `raw.oem-*` topic. Dev: broker on the compose network only | `deploy/terraform/aws/data.tf` (MSK `client_authentication { tls {} }`, TLS in transit); gap: ACL list per OEM is an onboarding step |
| **T**ampering | Malformed values, wrong units, forged VINs | Per-OEM adapters, schema validation, unit conversion, **VIN check digit**; anything invalid goes to the DLQ with the reason, never silently fixed | `packages/domain/src/canonical/{adapters,validate}.ts` + tests; `packages/domain/src/vin.ts` + `vin.test.ts` |
| **T**ampering / **R**eplay | Duplicates, redeliveries, replayed old data | Anti-replay window per VIN (sequence + event time) in Redis with a Lua compare-and-set; too-old → DLQ; counted | `canonical/antireplay.ts` + test; ADR 0001, 0002; `npm run normaliser:reconcile` (count in = out + DLQ + duplicates) |
| **R**epudiation | "We never sent that" | Every canonical/DLQ record carries `x-src-topic/partition/offset`; raw topics keep 3 days | `services/normaliser`; `infra/kafka/topic-init.sh` (retention) |
| **I**nformation disclosure | Feeds read other OEMs' data | Topic ACLs (read own topics only); TLS in transit | Terraform MSK TLS; gap: ACLs per OEM |
| **D**enial of service | Burst or flood from one OEM | Back-pressure (pause consumption above in-flight / Redis latency limits), partitioned topics, HPA for normaliser/state processor; the burst mode is tested | ADR 0004; `docs/perf/normaliser.md`; Helm HPA 3–12; chaos: normaliser kill recovers in 15 s (`docs/perf/chaos.md`) |
| **E**levation of privilege | Feed data reaching SQL or code | Avro-typed canonical events; parameterized SQL everywhere; no `eval` | Semgrep in CI (`p/typescript`, `p/nodejs`) |

## Boundary 2: browser ↔ API (and the identity provider)

| STRIDE | Threat | Mitigation | Where |
|---|---|---|---|
| **S** | Forged or stolen tokens | OIDC code + **PKCE**; RS256 JWT access tokens checked for signature, issuer, audience, expiry against JWKS; 1 h lifetime | ADR 0018; `services/api/src/auth.ts`; test "rejects missing, forged and wrong-audience tokens" (`api.itest.ts`) |
| **T** | Lost updates / double approval | `If-Match` required (428), stale version → 409; of two concurrent approvals one wins | test "concurrency: If-Match is required …" |
| **R** | "I didn't approve that" / who looked at driver data | **Every view and action audited** (actor, role, action, resource) in the same transaction, plus `audit.v1` (90-day retention) | test "every view is audited"; BDD `tests/bdd/api.feature` |
| **I** | Cross-tenant reads; viewer sees drivers or locations | **Postgres RLS** by tenant (`SET LOCAL app.tenant_id` per request; no tenant → 0 rows); **viewer masking** in the API (no driver, 5-char geohash only); SSE filtered by tenant; errors return no stack traces | ADR 0019; `infra/db/migrations/013_api_security.sql`; tests "row-level security", "viewer masking", "SSE delivers a change to its own tenant only"; e2e viewer test |
| **D** | Request floods | Per-user rate limit (600/min → 429); helmet headers; body size limits; nginx in front | test "rate limit: 429"; `services/api/src/app.ts`; load test: 173 req/s, 0 errors (`docs/perf/load.md`) |
| **E** | Viewer/planner doing lead actions; agent approving itself | Role checks per route (403); **DB CHECK `decided_by <> created_by`**, so the agent cannot approve its own proposal even with DB access | tests "role matrix", "the agent never approves its own proposals" |
| Web | XSS, clickjacking, CSP | React escapes by default (no `dangerouslySetInnerHTML`); helmet on the API; ZAP baseline scan findings | `docs/security/reports/` (ZAP) |

## Boundary 3: services ↔ stores (Kafka, Postgres, Redis, S3)

| STRIDE | Threat | Mitigation | Where |
|---|---|---|---|
| **S** | A compromised service impersonates another | Separate DB roles: `cw_sim` (simulator/evaluation), `cw_app` (pipeline), `cw_api` (API, RLS). Production: IRSA per service account; NetworkPolicies default-deny | `infra/db/migrations/*`; `deploy/helm/cohortwatch/templates/networkpolicies.yaml`; Terraform IRSA |
| **T** | Partial writes; duplicate effects after crashes | One transaction per event (idempotency row + effects + **outbox**); join-once PK (campaign, VIN); `ON CONFLICT DO NOTHING` on deterministic ids | ADR 0012; chaos: 169 = 169 incidents, 168 = 168 members after kills (`docs/perf/chaos.md`) |
| **R** | Untraceable changes | Outbox rows with deterministic ids; campaign history from the outbox; queue snapshots per version | `core.outbox`, `core.queue_snapshot` |
| **I** | **Ground truth leaks into detection** | The `sim` schema is not readable by `cw_app`/`cw_api`; `data/sim-private` is mounted **only** into the simulator and the evaluation job | CLAUDE.md rule; `docker-compose.yml` (sim-private mounts); migrations (grants) |
| **I** | Data at rest / in transit | Production: KMS at rest (EKS secrets, EBS, MSK, ElastiCache, S3, Secrets Manager); TLS in transit (MSK, Redis, Postgres, S3 TLS-only policy); credentials only via External Secrets | `deploy/terraform/aws/{security,data,eks}.tf`; `deploy/helm/cohortwatch/templates/externalsecret.yaml`. Dev compose: plaintext on a local network (accepted for a laptop) |
| **D** | Store outage | Consumers pause instead of crashing; outbox backlog limits; Redis restart recovers in 10 s | ADR 0004; `docs/perf/chaos.md` |
| **E** | SQL injection | Parameterized queries only; zod-validated inputs | Semgrep (CI), `services/api/src/app.ts` (zod) |

## Boundary 4: the agent

| STRIDE | Threat | Mitigation | Where |
|---|---|---|---|
| **S** | Someone posts "agent" proposals | Proposals are written by the agent service's DB role; only the API (lead) can decide | `services/agent`, `013_api_security.sql` grants |
| **T** | Invented evidence (hallucination) | **No LLM**: template text filled with existing numbers; every evidence line cites a source id; a unit test checks every cited text was given to it | ADR 0020; `packages/domain/src/agent/agent.test.ts` |
| **R** | Who changed the bays | Approvals audited; the booking reason names the approver ("booked by lead") | test "every view is audited"; workshop booking reason |
| **I** | Agent sees more than a viewer | The agent runs server-side as `cw_app` and publishes only proposals; the API masks them like everything else | `services/agent`, API masking |
| **D** | Proposal floods | One live proposal per campaign (updated or withdrawn); `AGENT_ENABLED=false` switch | `services/agent/src/agent.itest.ts` |
| **E** | Agent takes disruptive actions by itself | Only "polite" actions (notes) are applied; bay changes are **proposals a lead must approve**; the DB forbids self-approval | ADR 0020; tests above |

## Privacy (GDPR / DPDP)

- **Pseudonymous drivers:** only a pseudonym (`drv-…`) and assignment periods are stored. No names, phone numbers
  or licence numbers exist anywhere.
- **Viewer masking:** viewers never receive driver data or depot coordinates (API-side, tested), and the UI shows
  "driver hidden".
- **Right to erasure:** `DELETE /drivers/:id/personal-data` (lead only) replaces the pseudonym with `erased-<id>`,
  deletes the assignment history and audits the erasure. Tenant-scoped (another tenant gets 404). Tested
  ("right to erasure", `api.itest.ts`).
- **Retention:**
  - raw topics 3 days; canonical 3 days; DLQ 14 days; incidents 14 days; campaign events 30 days; audit 90 days
    (`infra/kafka/topic-init.sh`);
  - telemetry compressed after 7 days, production retention 90 days (brief; Helm/Terraform sizing);
  - S3 history moves to Infrequent Access after 30 days.
- **Data minimisation:** detection needs VIN-level telemetry, never the driver. Driver data is joined only on the
  vehicle page, for leads.
- **Synthetic data only** in this repository (fictitious OEMs, synthetic coordinates).

## Evidence

SAST (Semgrep), dependency, secret and config scans (Trivy) and DAST (OWASP ZAP) reports:
[docs/security/reports/](reports/). The full index is in [docs/test-evidence/README.md](../test-evidence/README.md).
