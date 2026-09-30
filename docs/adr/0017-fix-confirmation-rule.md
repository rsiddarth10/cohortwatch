# ADR 0017: Fix confirmation is judged on post-repair driven hours

- **Status:** accepted (S6, 2026-09-30)
- **Context:** "did the repair actually work?" A van parked after its repair tells us nothing. Temperature readings
  exist only while driving, and single noisy hours must not flip the verdict.

**Decision.**
- For each repair, the **fault's metric** (from its open incident or campaign, else its powertrain's main signal)
  is judged on the **post-repair driven hourly rows** in `core.telemetry`: the peer-adjusted z written by S3 after
  the trend reset (ADR 0016). The hour containing the repair is excluded.
- **FIXED:** at least 6 of the last 8 driven hours inside the band |z| < 2, with at least 12 driven hours, within
  48 sim-h.
- **NOT_FIXED:** 24 driven hours without FIXED, or the 48 sim-h window over with at least 12 driven hours.
- **PENDING:** not driven yet, or not enough driving to decide. The text says "n driven hours so far".
- The leader re-judges open repairs once per **sim-hour** of event time.
- A decision writes `core.repair_outcome` and an outbox message to `workshop.outcomes.v1` (key = VIN).
  - NOT_FIXED puts the van back in its depot queue with a boost and "repair on <date> did not hold".
  - The campaign engine marks the member fixed; a campaign closes only when all its members are FIXED.
- While a repair is PENDING or FIXED, the van's pre-repair incidents, campaign membership and at-risk rows don't
  queue it.

**Consequences.** An urban van drives ~10 h a day, so FIXED takes about a day and a half of sim time, and NOT_FIXED
up to the 48-h window. All thresholds are config (`FIX_*`).
