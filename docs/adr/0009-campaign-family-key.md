# ADR 0009: The campaign family key is fault family | model | duty | depot

- **Status:** accepted (S5, 2026-09-30)
- **Context:** a campaign groups vans that share a cause. If the key is too wide, a whole city becomes one campaign;
  if it is too narrow, sisters never meet. The brief (§1.6) forbids behaviour in the key, merging two depots, and
  pulling the same code in from a different context.

**Decision.**
- Key = `fault_family | model_id | duty_type_id | depot_id`, built from the incident's **snapshot** fields (the depot
  at event time). A depot transfer mid-story therefore never rewrites history: a van stays in the campaign it joined
  first (at most one live campaign per van and family, enforced by a partial unique index).
- The reference plan uses a road corridor instead of the depot for linehaul. The registry has no corridors, so the
  depot is used for every duty; a corridor can replace it later without a schema change (the key is a string).
- Behaviour (harsh events, idle) and weather are **not** in the key. Weather enters through the regional expected
  rate (ADR 0010) and the clues.
- `incidents.v1` is keyed by the family key, so each key is owned by one partition, i.e. one writer. Touching
  24-h event-time windows of one key merge via union-find; different depots never do.

**Consequences.** Scattered decoys (6 depots) and the same-depot other-model decoy land in different keys and cannot
reach 5 vans. A cohort that spans depots (linehaul) is split per depot until corridors exist.
