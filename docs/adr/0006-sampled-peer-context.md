# ADR 0006: Peer context is a per-replica sampled estimate, with a region-wide fallback

- **Status:** accepted (S3, 2026-09-30)
- **Context:** the peer adjustment subtracts what vans in the same context are doing right now (the median of
  their deviation from their own normal). An exact fleet-wide value would need a shared store updated on every
  reading, or a second pass.

**Decision.**
- Each replica estimates the context from the vans in the partitions it owns. Partitions are keyed by VIN, so a
  replica's vans are a random third of the fleet (with 3 replicas), and the median of a random sample is an
  unbiased, robust estimate.
- The context is region × duty, falling back to the whole region when region × duty has fewer than `minPeers`
  (10) peers reporting in the last 2 sim-hours. At N = 5,000 with 3 replicas, region × duty was often too small
  (8 of 181 heatwave incidents had a context), so the heatwave leaked through; the region level fixes that,
  and a regional heatwave is regional anyway.
- The adjustment is in the metric's unit (°C, V), not in z units, so a shared +10 °C cancels exactly whatever each
  van's own spread is. Level, slow slope and fast rate (for time to limit) are all peer-adjusted.

**Consequences.** No cross-replica coordination. At 100K each replica sees about 33K vans, far more than
enough. At very small N or a very quiet night, the context can fall back to "none" (no adjustment), which the
clues state.
