# ADR 0016: A repair resets the van's trend in the state processor

- **Status:** accepted (S6, 2026-09-30)
- **Context:** after a repair, the van should be judged on post-repair readings (brief §1.6: "a repair resets the van's
  normal"). The S3 trend has τ = 12 sim-h, so without a reset a fixed van keeps a hot EW mean for hours: its incident
  and its peer-adjusted z would still describe the fault, and fix confirmation would call good repairs NOT_FIXED.

**Decision.**
- Every state-processor replica reads the tiny `workshop.repairs.v1` topic **in full** (its own throwaway consumer
  group, never committed) into a map vin → repair time.
- Before stepping a van whose state predates its latest repair, `resetForRepair` clears the van's EW sums, k-of-n
  windows, runaway counters and code-rate rings, and records `repairTs` in the (checkpointed) state. It is
  idempotent.
- Readings with an event time before the repair that arrive late are ignored for the trend.
- An open incident is **not** closed by decree: it closes after 12 normal post-repair readings, so a bad repair
  (the drift continues) keeps it open.
- The map is consulted when the van is stepped, so partition ownership and the order of the two topics do not
  matter.

**Consequences.** Hourly scores after a repair reflect only post-repair driving, which is what fix confirmation reads
(ADR 0017). A repair that arrives after later readings were already applied drops those few readings from the new
trend (conservative). Each replica holds one map entry per repaired van.
