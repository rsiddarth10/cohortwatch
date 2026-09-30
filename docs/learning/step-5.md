# Step 5 walkthrough (campaign engine)

- `packages/domain/src/campaign/book.ts`: one family key's groups, pure state in → state out. *Q: what is a key?* fault family | model | duty | depot at event time (ADR 0009); `incidents.v1` is keyed by it, so one writer per key.
- An incident joins the group whose 24-h buckets touch its own; a bridging bucket merges groups (union-find, the older one stays root). *Q: two depots?* Different keys, never merged.
- Join once: a second incident, a replay (`processed_incident_action`) or an S3 CLOSE adds no member. A partial unique index keeps one live campaign per van and family, so a transfer keeps its first campaign.
- `poisson.ts`: open at ≥ 5 vans AND P(X ≥ n | λ) < 1e-4. *Q: why a regional rate?* A heatwave made one depot's linehaul EVs "surprising" against a fleet baseline. Comparing with the same model × duty elsewhere in the region (5 of 11 affected) made it unsurprising (ADR 0010).
- Tuning order used: α 1e-3 → 1e-4 first (not enough at p = 1e-8), then fixed the regional denominator: it counted all region vans, most of which cannot show the fault.
- At-risk sisters (`atrisk.ts`): non-members with peer-adjusted z ≥ 1.5 in 3 of 4 hourly rows, or a steep rise. *Q: where do scores come from?* The S3 telemetry writer now stores them per van-hour (ADR 0011). This is how the **late sisters** are caught before their own incident.
- `firmware.ts`: members' installs in the 3 days before their first incident vs healthy sisters' in the 3 days before the campaign's first incident (same window length).
- *Q: why doesn't the firmware clue match the plant's 16/18 vs 48%?* The plant counts a different window (T0−72 h … T0+6 h).
- `clues.ts`: place, trend, top codes, "peers elsewhere in the region are normal", "n vans where λ would be expected", and cost if not fixed (₹, rates in config).
- `similarity.ts`: a 31-dim feature vector and 30 synthetic past campaigns, top 3 by pgvector cosine (ADR 0013). No embedding API.
- `services/campaign-engine`: one transaction per incident (book, members, clues, at-risk, similar, outbox). The advisory-lock leader runs the outbox relay and the hourly at-risk refresh (ADR 0012).
- *Q: exactly once?* One outbox row per change; Kafka is at-least-once with a stable `x-event-id`.
- Tests: domain units, 7 BDD scenarios (brief §1.7 items 1, 2, 3, 7, 9), and a Testcontainers itest (crash mid-stream → no duplicate members, one outbox row per change).
