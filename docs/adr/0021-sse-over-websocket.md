# ADR 0021: Server-Sent Events (not WebSocket) for the live board

- **Status:** accepted (S7, 2026-09-30)
- **Context:** the board must update within seconds when the queue, a campaign, a card or a proposal changes.
  Traffic is one-way (server → browser); user actions go through normal REST calls with If-Match.

**Decision.**
- `GET /events` is an **SSE** stream. Each API instance consumes the change topics (queue, campaign, proposals)
  with its own consumer group. A per-tenant card poller (2 s) also feeds an in-process bus. Events are
  **filtered by the caller's tenant** before they are written.
- EventSource cannot send headers, so the token goes in the `access_token` query parameter for this one route
  only. nginx turns buffering off for it, and a 15 s comment ping keeps proxies from closing it.
- The browser treats events as "something changed": it re-reads the page's data (debounced) through the audited,
  RLS-protected REST endpoints. Events carry no data a viewer could not see.

**Consequences.** Plain HTTP, automatic reconnect, and easy to proxy and test. The trade-offs: tokens in URLs
(short-lived, and logged only by our own proxy), and one connection per tab. WebSocket would add a protocol and
state for no two-way need.
