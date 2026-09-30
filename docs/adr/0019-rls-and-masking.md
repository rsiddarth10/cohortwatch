# ADR 0019: Tenant isolation by Postgres RLS; viewer masking in the API

- **Status:** accepted (S7, 2026-09-30)
- **Context:** several fleets (tenants) share one database. A forgotten `WHERE tenant_id = …` must not leak
  another tenant's vans. Viewers (e.g. a contractor) may see the queue, but not drivers or precise locations.

**Decision.**
- The API connects as **`cw_api`**, a role with SELECT on `core` and a few narrow writes. Every request runs in
  **one transaction** that first sets `app.tenant_id` from the token (`set_config(..., true)`, local to the
  transaction, so pooled connections never carry it over).
- A `tenant_isolation` **RLS policy** exists on 23 tables (`USING` and `WITH CHECK`). Tenant is found through
  SECURITY DEFINER helpers (`core.depot_tenant`, `vin_tenant`, `campaign_tenant`, …). With no tenant set,
  `cw_api` sees 0 rows.
- The pipeline roles (`cw_sim`, `cw_app`) have BYPASSRLS: they are single-tenant-agnostic writers, and COPY is
  not allowed on RLS tables.
- **Masking** is done in the API for the `viewer` role: depot = id, code, region and a 5-character geohash only
  (no lat/lon); driver = null. It is tested per endpoint.
- **Audit:** every view and action writes `core.audit` plus an outbox row (→ `audit.v1`) in the same
  transaction. If the audit fails, the view fails.
- **Concurrency:** writes need `If-Match` (428 without it, 409 when stale). The database also refuses
  self-approval (`decided_by <> created_by`).

**Consequences.** Isolation holds even if a query forgets the tenant (tested: another tenant's rows are 404).
The per-request transaction costs one extra round trip; this is measured in `docs/perf/api.md`.
