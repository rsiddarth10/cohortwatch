# ADR 0011: At-risk scores are stored in the hourly telemetry rows

- **Status:** accepted (S5, 2026-09-30)
- **Context:** at-risk sisters are vans **without** an incident whose own trend is heading the same way as the
  campaign's members. The campaign engine needs a per-van score for every van in the key, over time. S4 needs the
  same thing for solo at-risk vans.

**Decision.**
- The S3 state processor already computes, at every scored reading, the van's deviation from its own normal minus
  its peers', and the robust z of level and slope. `stepVan` now returns them.
- The telemetry writer stores the last score per metric in each hourly row: 9 nullable columns on `core.telemetry`
  (`coolant_dev|z|zs`, `batt_*`, `lv_*`; migration 008).
- The campaign engine reads the last hours of the key's non-members and applies a generic rule: at least 3 of the
  last 4 hourly rows with z_level ≥ 1.5, or the newest row with z_slope ≥ 2 and a positive deviation.
- It re-evaluates on every campaign change and once per **sim-hour** of event time: the leader polls the newest
  hourly row.
- `first_ts` is the **event time** of the row that first flagged the van, so "at-risk before its own incident" is
  measured on the sim clock.

**Consequences.** There are no extra rows or tables (at 100K the telemetry writer was the limit), and S4 reuses the
columns. At-risk has hourly resolution, and a code-only family (e.g. EXHAUST) has no at-risk sisters.
