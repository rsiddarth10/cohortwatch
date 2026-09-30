# ADR 0010: Poisson guard with a regional expected rate

- **Status:** accepted (S5, 2026-09-30)
- **Context:** five incidents in a key can be an outbreak or a coincidence. Scan-statistic practice asks: "more
  cases than expected in this place and time?". A heatwave makes every van in a region run hot, so five at one
  depot is not surprising, and a fleet-wide baseline cannot know that.

**Decision.**
- A group opens as a campaign only with **≥ 5 distinct vans AND P(X ≥ n | λ) < α**. Below that it is WATCHING
  (visible later in a strip, no card). The tail is summed in log space (accurate far below 1e-12).
- λ = vans in the key × days in the merged window × max(**floor** 2 per 1,000 van-days, **baseline** for the
  family × model × duty from the batch fault-rate table, **current regional rate**).
- The regional rate is the share of the **same model × duty in the same region, outside this depot** with an
  incident of the family in the last 72 h (per 1,000 van-days).
  - The first version divided by *all* vans in the region. Most of those vans (diesels, other duties) cannot
    respond to a battery heatwave, so a synchronised response of linehaul EVs at one depot opened a campaign
    (p = 1e-8).
  - With the cohort-type denominator, 5 of 11 sisters elsewhere were already affected: λ ≈ 1.4, p ≈ 0.01, so the
    group stays WATCHING.
- α = **1e-4** (the reference plan's value). It was the first step of the tuning order, before the regional fix;
  1e-3 was the plan's default.
- The baseline is **codes** per 1,000 van-days (history has no incidents). That is a conservative stand-in for
  the background incident rate.

**Consequences.** A real outbreak at one depot, with the same cohort elsewhere in the region normal, opens fast:
S1 at p ≈ 5e-22, S1b at p ≈ 1e-12. A region-wide condition, or a common fault in a big cohort, needs more cases.
The guard only looks back in event time, so if a regional response reaches the other depots later than this one,
the regional term arrives late too.

**Measured:** 5K and 30K runs to the produced T0+72 h: S1 = 1, S1b = 1 (separate), heatwave 0, decoys 0, background 0 (`docs/perf/campaign-engine.md`).
