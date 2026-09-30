# ADR 0013: Similar past campaigns: synthetic cases and feature-vector cosine similarity

- **Status:** accepted (S5, 2026-09-30)
- **Context:** "similar past campaigns" helps the lead decide ("last time this was a thermostat batch"). There is
  no real history, and the brief forbids real data. An external embedding API would add a dependency, a cost, and
  data leaving the system.

**Decision.**
- Campaigns are described by a **31-dimensional numeric feature vector**, with block weights so the fault family
  counts most:
  - one-hot fault family, powertrain, duty and climate;
  - log member count, typical deviation and slope;
  - the share of each known fault code.
- **30 synthetic, fictional past campaigns** are generated deterministically from 13 templates (root cause and
  resolution note, e.g. "thermostat batch replaced under a supplier recall"). The engine seeds them idempotently at
  start; they are declared in `docs/DECLARATIONS.md`.
- `core.past_campaign.embedding vector(31)` has an HNSW cosine index (pgvector, part of the pinned Timescale
  image). Each open campaign stores its top 3 (`<=>`) in `core.campaign_similar`.

**Consequences.** It is deterministic, explainable (the features are named) and has no external calls. Similarity
is only as good as the templates. With real history, the same table takes real campaigns, and a learned embedding
could replace the vector without changing the query.
