# Steps 4 + 6 walkthrough (workshop queue and fix confirmation)

- `packages/domain/src/queue/queue.ts`: one entry per van from its signals (incident, campaign member, at-risk sister, solo at-risk, failed repair). *Q: why merge?* A van appears once, with all its reasons.
- The score is 0.35 severity + 0.25 trend + 0.20 campaign (log size) + 0.10 in service tomorrow + behaviour **capped at 0.10** + 0.15 if a repair did not hold (ADR 0014).
- *Q: why no fault-code term?* Loudest-first is exactly what we must beat: a loud-but-stable van ranks below a quiet van that is getting worse (unit + BDD test).
- Runaway/critical is **pinned** above every score and always gets a bay. *Q: how fast?* 0.04 s from the critical incident written to rank 1 at 5K.
- `fillBays`: today, then tomorrow, in rank order, only for items scoring ≥ 0.40. At-risk-only vans count at half weight ("at a lower weight"), so they are shown but never take a bay; this came out of tuning, when heatwave vans took spare bays.
- `reasons.ts`: phrases only ("runaway: ≈ 6 h to 110 °C", "member of COOLING campaign at D-001 (18 vans)", "repair on … did not hold"). Cost of waiting = P(breakdown before its slot) × breakdown cost, deliberately rough.
- `services/workshop`: each incident, campaign event or repair = one transaction (processed_event, cards, repairs, the depot's queue rebuild, outbox).
- *Q: when does a queue version change?* Only when the order or slots change; `core.queue_snapshot` keeps every version for point-in-time questions. The leader re-ranks every depot once per sim-hour.
- `repair/confirm.ts`: judged on post-repair **driven** hours. FIXED = ≥ 6 of the last 8 inside |z| < 2 with ≥ 12 driven hours; NOT_FIXED after 24 driven hours or at 48 sim-h; PENDING until then (ADR 0017).
- *Q: why reset the trend?* S3's 12-h memory would make a good repair look bad; each state-processor replica reads the repairs topic and resets that van (ADR 0016).
- Outcomes → `workshop.outcomes.v1` → the campaign engine marks members fixed; a campaign CLOSES only when all members are FIXED. S1 stays open: the bad repair and the unrepaired late sisters.
- AUTO_REPAIRS now repairs the 15 main sisters only, so the late sisters stay a real test of at-risk prediction (in the queue 17–43 h before their own incident).
- Tests: domain units, 3 BDD scenarios (brief §1.7 items 5, 6, 8), and a Testcontainers itest (critical → top < 5 s, FIXED/NOT_FIXED, replays and a crash → no duplicates).
