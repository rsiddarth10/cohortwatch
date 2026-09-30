# ADR 0020: A template agent (no LLM), with proposals that only a lead approves

- **Status:** accepted (S8, 2026-09-30)
- **Context:** the brief asks for an agent that helps the planner without taking risky actions on its own, and
  whose output can always be traced to evidence. An LLM would add cost, nondeterminism and the risk of
  invented text.

**Decision.**
- `services/agent` reacts to `campaign.events.v1` (OPENED / GREW / AT_RISK_CHANGED / REOPENED) and to
  `queue.events.v1` (a runaway outside today's bays).
- The logic is pure and in `packages/domain/src/agent`. Text comes from **templates filled with existing
  numbers**. Each claim cites its **evidence by id** (`<campaign>#<clue ord>`, `<campaign>#<vin>`). Nothing
  is invented; a unit test checks that every cited text was given to it.
- **Polite actions** are applied directly: a campaign note, and "inspect at next visit" per at-risk sister.
- **Disruptive actions** (booking vans into bays) become **PENDING proposals** with a **dry-run diff**. The diff
  is computed by the same `withBookings` function the workshop uses, so the preview equals the result. Only a
  lead can approve; the agent cannot approve its own proposals (API role check + DB CHECK).
- On approval: `core.queue_booking` + an outbox event → `agent.proposals.v1`; the workshop rebuilds that depot's
  queue (the reason "booked by lead (approved agent proposal)"), and the board updates over SSE.
- Everything is idempotent: processed_event per trigger, proposal id = uuid5(action, campaign, vins).
- `AGENT_ENABLED=false` keeps the service idle; the board works without it.

**Consequences.** It is deterministic, auditable and cheap. It is not creative: it only proposes the two action
types it knows. A later LLM could draft the text, but the evidence and the approval gate would stay as they are.
