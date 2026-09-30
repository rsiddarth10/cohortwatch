# Model card: at-risk classifier (S9)

**Status: evaluated offline, NOT wired into the queue.** On a run with a different seed it ranks at-risk vans better than the deployed rule (PR-AUC 0.37 / 0.30 vs 0.07), with no false positives in the heatwave or naturally-hot groups. It is still not wired in, for the reasons under *Decision*.

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
| Van-hours | 275,882 | 273,899 |
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

| Scorer | PR-AUC | Precision@5 / @10 / @25 per hour | Fault vans caught before their incident* | False positives: heatwave + naturally-hot vans* |
|---|---|---|---|---|
| Gradient boosting, `full` | **0.369** | 0.42 / 0.31 / 0.16 | 22 of 35 | 0 (0 + 0) |
| Gradient boosting, `signals` | **0.303** | 0.40 / 0.28 / 0.14 | 17 of 35 | 0 (0 + 0) |
| Rule at-risk (S5 campaign flag, as deployed) | **0.069** | 0.17 / 0.12 / 0.06 | 11 of 35 | 0 (0 + 0) |
| Global threshold | **0.002** | 0.03 / 0.02 / 0.01 | 8 of 35 | 622 (593 + 29) |
| One signal (current peer-adjusted coolant slope z) | 0.010 | 0.06 / 0.06 / 0.04 | – | – |

Base rate: 0.20% of van-hours are positive. \* At a like-for-like operating point: the model flags as many van-hours as the rule does (38). The threshold is the model's top 38 scores. At that point precision is 1.00 (`full`) and 1.00 (`signals`), vs 0.97 for the rule.

**Most important features** (permutation importance on the test run, drop in PR-AUC):
- `full`: coolant_dev (0.27), powertrain (0.21), duty_type_id (0.16), climate_zone (0.15), coolant_zs_max6h (0.05), coolant_dev_delta6h (0.03)
- `signals`: coolant_z (0.23), batt_zs_max6h (0.19), coolant_dev (0.11), coolant_zs_max6h (0.09), coolant_dev_delta6h (0.07), coolant_zs (0.03)

In `full`, powertrain, duty and climate rank high: the model partly learns *which kind of cohort* breaks in these
scenarios. `signals` has none of them and still scores 0.30 PR-AUC, 4× the rule. Most of the
gain is real signal, above all the van's own coolant z and deviation, and its battery slope.

## Limits

- **Simulated data, few fault vans** (35 in the test run): the metrics have wide error bars. A different seed can
  shift them by several points.
- **The plants are few and similar** (COOLING outbreaks, a runaway, decoys). A model trained here learns these
  shapes, not the variety of real fleet faults.
- **Label timing uses our own detector's first incident** for real-fault vans. A fault our detector finds late
  makes the label late too.
- **Not calibrated** as a probability. Use it as a ranking.

## Decision

**Not wired into the queue (yet).** The numbers favour the model, but:

1. **The baseline is incomplete.** The rule column is the S5 campaign at-risk flag (`core.campaign_at_risk`). The
   queue also flags *solo* at-risk vans from their own trend (S4, `atRiskOf`), and that rule was not in the export.
   So "beats the rules" is shown against one of the two rules. Both runs' databases were reset before I noticed,
   so re-exporting would have meant two more runs.
2. **35 fault vans per run.** At that size, one seed's result can move several points.
3. **No online inference path.** The model is Python and the queue is Node. Serving it needs an export (ONNX, or
   the trees as JSON) and an hourly scorer.

**Next step if wanted:** add the solo at-risk rule to the export and re-run both seeds. If the model still wins,
export the `signals` variant, score it in the workshop as one more `AT_RISK` signal behind `ML_AT_RISK=on`
(default off), and show it in the reasons as "model: likely fault within 24 h (score 0.93)". The template agent's
evidence rules would apply unchanged.
