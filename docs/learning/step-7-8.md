# Step 7 + 8: login, API, agent, web app — what I learned

1. **OIDC with JWT access tokens** needs *resource indicators*: without a `resource`, oidc-provider issues opaque tokens. The audience must be an absolute URI (`urn:cohortwatch:api`).
2. **PKCE** replaces the client secret for a browser app: the browser proves it started the login by showing the verifier that hashes to the challenge.
3. **RLS + `SET LOCAL`**: the tenant is set per request *inside* a transaction (`set_config(..., true)`), so a pooled connection never carries it to the next user. With no tenant set, the API role sees 0 rows: a forgotten WHERE fails closed.
4. `COPY FROM` is refused on RLS tables, so the pipeline roles get BYPASSRLS. Isolation is a property of the API role.
5. **Masking belongs next to the role check**, not in the UI: the viewer's JSON never contains the coordinates.
6. **Audit in the same transaction as the read**, plus an outbox row: if the audit can't be written, the view fails.
7. **If-Match / 409** turns "two leads click Approve" into exactly one winner; the database adds a CHECK that the agent never approves itself.
8. **An agent without an LLM**: templates + evidence ids + a dry run with the *same* function the workshop uses. The preview can't disagree with the result.
9. A live signal (the at-risk set changes hourly) must **update one proposal in place**, not create a new one each time. Otherwise the inbox fills with stale proposals.
10. **SSE** is enough for one-way live updates. The browser treats events as "re-read", so events never carry data a role shouldn't see.
11. nginx must not buffer SSE (`proxy_buffering off`), and EventSource can't send headers (token in the query, for that route only).
12. Playwright through the real login is the only test that proves the whole chain: issuer → token → API → RLS → UI.
