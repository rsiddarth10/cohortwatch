# ADR 0018: A local OIDC issuer (oidc-provider) with JWT access tokens

- **Status:** accepted (S7, 2026-09-30)
- **Context:** the brief asks for real login (roles lead / planner / viewer, tenants) that a stranger can run
  with `docker compose up`, without a cloud identity provider or secrets.

**Decision.**
- `services/auth` runs **oidc-provider** (certified OpenID Connect library) on :3200: authorization code +
  **PKCE** (required), public client `cohortwatch-web`, demo users in code (lead, planner, viewer on tenant 1;
  lead2 on tenant 2).
- **Resource indicators** make the access token a **JWT** for the audience `urn:cohortwatch:api` (it must be an
  absolute URI), with the claims `role` and `tenant_id`. Lifetime: 1 h.
- The API verifies the tokens itself with **jose** against the issuer's JWKS (issuer, audience, signature,
  expiry). The API never calls the issuer per request.
- The signing key is generated at start: a restart signs everyone out. That is acceptable for a demo.
- **Swapping to a real IdP** (Keycloak, Entra, Auth0) is configuration only: `OIDC_ISSUER`, `OIDC_JWKS_URL`,
  `API_AUDIENCE`, plus a role/tenant claim mapping.

**Consequences.** Real OIDC flows end to end (the browser uses oidc-client-ts), with no external dependency. The
demo passwords are public by design; the issuer is dev-only (it has no persistence and no user admin).
