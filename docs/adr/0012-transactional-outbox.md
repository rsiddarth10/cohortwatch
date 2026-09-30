# ADR 0012: Campaign events leave through a transactional outbox

- **Status:** accepted (S5, 2026-09-30)
- **Context:** a campaign change (open, grow, dismiss, at-risk change) must reach Kafka (`campaign.events.v1`)
  exactly when it is committed in Postgres. Producing inside the transaction risks sending events for rolled-back
  changes; producing after it risks losing them on a crash.

**Decision.**
- Every change writes its outbox row(s) **in the same transaction** as the campaign, its members and its clues.
  The row id is the event id, uuid5(campaign, type, version). An incident replay is dropped by
  `processed_incident_action(incident_id, action, seq)` in that same transaction, so a change is written exactly
  once.
- A relay publishes unpublished rows in order (key = campaign_id, header `x-event-id`), awaits the acks, then marks
  them published.
- Only the replica holding a session-level Postgres advisory lock runs the relay and the hourly at-risk refresh.
  If that connection dies, the lock goes with it and another replica takes over.

**Consequences.** Delivery is at-least-once: a crash between the ack and the mark re-sends the same event id, and
consumers (S7 SSE, the agent) drop repeats by id. The integration test shows one outbox row per change and the
same set of ids on Kafka, including across a crash. The relay adds one poll interval (200 ms) of latency.
