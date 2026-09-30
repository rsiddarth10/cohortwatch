# Model card: at-risk classifier (S9)

**Status: evaluated offline, NOT wired into the queue.** On a run with a different seed it **clearly beats both deployed rules**: at the queue rule's alert volume it catches 76% vs 20% of pre-incident hours with far fewer heatwave/naturally-hot false alarms. Wiring it in (behind a flag, default off) is **not done**: see *Decision*.

## What it predicts

Per van, per hour: **"will this van have a real fault incident in the next 24 h?"**. This is the question the rule-based
*at-risk* flag (S5) answers for the workshop queue.

- **Decision time** τ = the end of the hour. Features use nothing after τ.
- **Positive** when the van is a real fault (planted role) and its first confirmed incident for that fault family
  opens in (τ, τ + 24 h]. A faulty van's hours from its incident on are dropped: it is no longer "at risk", it is
  faulty.
- **Where labels would come from in production:** confirmed repairs (S6 fix-confirmation outcomes: a repair that
  was needed and held), not a simulator. Here they come from the simulator's ground truth, read offline by the
  evaluation role `cw_sim`. Detection never reads it.

## Data

| | Training run | Test run |
|---|---|---|
| Seed | `cohortwatch-ml-7` | `cohortwatch-42` (the evaluation seed) |
| Fleet | 5,000 vans | 5,000 vans |
| Window | T0 → T0+84 h, hourly (only hours a van drove) | same |
| Van-hours | 275,882 | 273,900 |
| Positive van-hours (vans) | 537 (35 vans) | 535 (35 vans) |

A different seed means a different fleet: other VINs, depots, noise and fault onsets. No van or hour of the test
run is in training. Export: `docker compose --profile ml run --rm ml-at-risk export.py /data/<file>` at the end of
each run. Training: `… train.py <train> <test> /data/out full|signals`.

## Features (detection-visible only)

- **The van's own signals** (written hourly by the state processor, S3): deviation from its own normal, its z,
  and its peer-adjusted slope z for coolant, battery and 12 V. Rolling 3 h / 6 h means, maxima and 6 h change.
  DTC counts (6 h, 24 h), harsh-driving count (24 h), readings per hour.
- **Peers:** incidents among the van's cohort (same model, duty, depot) in the last 24 h. Whether an outbreak
  campaign is open for that cohort. Whether the van has an open incident itself.
- **Context (the `full` variant only):** powertrain, duty type, climate zone, ambient temperature.
- **Never used:** VIN, model id, depot id (identifiers that let a model memorise the training fleet), anything
  from the driver (fairness: a van's risk must not depend on who drives it), and the ground-truth columns.

**Two variants.** The plants sit in the same kinds of cohorts under every seed. For example, the big COOLING outbreak is
always a diesel urban model. So context features can learn "this kind of cohort breaks" instead of reading the
signal. `signals` drops the context to show how much the model gets from the signals alone.

## Model

scikit-learn `HistGradientBoostingClassifier`: 300 iterations max with early stopping, learning rate 0.05, 31
leaves, min 40 samples per leaf, L2 1.0. Positives are up-weighted (they are about 0.2% of van-hours).
Deterministic (`random_state=7`).

## Results on the test run

| Scorer | PR-AUC | Precision@5 / @10 / @25 per hour | At the queue rule's volume (8,870 van-hours): recall · precision · fault vans caught · heatwave + naturally-hot vans flagged |
|---|---|---|---|
| Gradient boosting, `full` | **0.368** | 0.41 / 0.30 / 0.17 | 0.76 · 0.046 · 34 of 35 · 45 + 15 |
| Gradient boosting, `signals` | **0.285** | 0.38 / 0.27 / 0.15 | 0.59 · 0.036 · 34 of 35 · 216 + 31 |
| Rule: S5 campaign at-risk flag | **0.071** | 0.18 / 0.12 / 0.06 | – (flags only 39 van-hours) |
| Rule: queue at-risk (campaign + solo, S4/S5), as deployed | **0.004** | 0.10 / 0.08 / 0.05 | 0.20 · 0.012 · 29 of 35 · 324 + 22 |
| Global threshold | **0.002** | 0.03 / 0.02 / 0.01 | (flags 45,361) 0.07 · 0.001 · 8 of 35 · 593 + 29 |
| One signal (current peer-adjusted coolant slope z) | 0.010 | 0.06 / 0.06 / 0.04 | – |

Base rate: 0.20% of van-hours are positive. The last column compares everyone at the
same alert budget: the deployed queue rule's 8,870 flagged van-hours. The model gets the same number of flags
(its top-scored van-hours).

**Reading it.**
- **Against the deployed queue rule, at the same number of alerts:** the `full` model catches **76% vs 20%** of the
  pre-incident hours, at about **4× the precision**. It flags **60 vs 346** heatwave and naturally-hot vans,
  and 605 vs 1888 healthy background vans. `signals` (no context): 59% recall,
  247 heatwave/naturally-hot vans.
- **Against the campaign flag at its own tiny volume** (39 van-hours): same precision, twice the fault vans (22 vs 11).
- The queue rule's low PR-AUC (0.004) is expected. It is a yes/no flag that fires on many vans for a while; it
  was built to put vans *into the queue* and let the score order them, not to predict a fault within 24 h.

**Most important features** (permutation importance on the test run, drop in PR-AUC):
- `full`: powertrain (0.19), coolant_dev (0.16), duty_type_id (0.15), climate_zone (0.13), coolant_zs_max6h (0.06), coolant_dev_delta6h (0.03)
- `signals`: batt_zs_max6h (0.13), coolant_z (0.09), coolant_dev_delta6h (0.07), coolant_zs_max6h (0.06), coolant_dev (0.06), lv_zs_3h (0.04)

In `full`, context features (powertrain, duty, climate) rank high: the model partly learns which kind of cohort
breaks in these scenarios. `signals` has none of them and still beats every rule, so most of the gain is real
signal (the van's own coolant z, deviation and 6 h change, its battery slope).

## Limits

- **Simulated data, few fault vans** (35 in the test run): the metrics have wide error bars. A different seed can
  shift them by several points.
- **The plants are few and similar** (COOLING outbreaks, a runaway, decoys). A model trained here learns these
  shapes, not the variety of real fleet faults.
- **Label timing uses our own detector's first incident** for real-fault vans. A fault our detector finds late
  makes the label late too.
- **Not calibrated** as a probability. Use it as a ranking.

## Decision

**It beats the rules; it is not wired into the queue yet (partial).** The brief says: wire it behind a flag, default
off, if it clearly wins. It does, on these runs, against both rules (the second baseline was added and both seeds
were re-run for it). Wiring was not done overnight because the queue is Node and the model is Python, so it needs
an inference path. The time went to the S10 deliverables instead.

**How it would be wired (next step):**
1. Export the `signals` variant's trees to JSON (or ONNX).
2. Add a pure scorer in `packages/domain` with its own tests.
3. In the workshop, compute the same features from the inputs it already reads (the 6 h scores, 24 h codes, cohort
   incidents), and add an `AT_RISK` signal "model: likely fault within 24 h (score 0.93)" behind `ML_AT_RISK=on`,
   default off.
4. Keep the evaluation's alert-budget comparison as the regression test.

Caveats that stay: 35 fault vans per run (wide error bars), plants that are few and similar, and label timing that
comes from our own detector.
