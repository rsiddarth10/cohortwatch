# ADR 0014: Queue scoring, runaway pinning and the behaviour cap

- **Status:** accepted (S4, 2026-09-30)
- **Context:** the workshop queue decides which vans take today's and tomorrow's bays at each depot. Workshops tend
  to fix whoever is loudest, but the expensive failures are the quiet vans that are getting worse, and the shared
  outbreaks (brief §1.1). Behaviour data must never become a driver score (brief §1.5).

**Decision.**
- **One entry per van**, merging its open incidents, campaign membership, campaign at-risk sister status, solo
  at-risk status (the S5 rule on its own hourly scores) and a failed repair.
- **Score**, weights in config (reference plan §9.10):
  - 0.35 × severity (WARN 0.4, HIGH 0.7, CRITICAL 1; at-risk only 0.2);
  - an **at-risk-only** van (no incident, not a member, no failed repair) gets half its severity and trend terms ("at a
    lower weight", brief §1.3.1): it is queued and shown, but never takes a bay;
  - 0.25 × trend = max(z_slope / 4, 1 − hours-to-limit / 72);
  - 0.20 × campaign = log2(1 + members) / log2(21), half that for an at-risk sister;
  - 0.10 × in service tomorrow;
  - behaviour, **capped at 0.10**: harsh events per driven hour against the median of the van's duty at its depot,
    full at 3×;
  - +0.15 when a repair did not hold.
- The **fault-code count is not a term**; it only appears as a reason phrase. So a loud-but-stable van (40 codes a
  day, flat trend) ranks below a quiet van that is getting worse. A unit test and a BDD scenario pin that pair.
- A **runaway / critical** van is pinned above every score (soonest limit first) and always gets a bay.
- **Bays:** `core.workshop_bay` × 1 slot per bay per day, filled today then tomorrow in rank order. Only items with
  score ≥ **0.40** take a bay; the rest wait. At 0.35 (the first choice), flat heatwave incidents (scores 0.35–0.38)
  and steep solo at-risk vans took spare bays; 0.40 removed most of them at the cost of 3 of 29 true-risk vans'
  earliest hours (S4 tuning, 5K).
- **Cost of waiting:** P(breakdown before its slot) × breakdown cost (the S5 money assumptions). P = wait / time to
  limit when that is known, otherwise 1 − (1 − daily hazard)^days by severity and role. Deliberately rough, and
  labelled as such.
- **Privacy:** no driver ids anywhere in the queue; behaviour is per van, relative to its duty.

**Consequences.** It is explainable: every item carries its phrases and its score parts. The weights are a
judgement, not a fitted model; S9's ML at-risk classifier is compared against this rule.
