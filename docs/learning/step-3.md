# Step 3 walkthrough (state processor: van vs its own normal)

- `packages/domain/src/detect/ewtrend.ts`: level and slope from 5 decayed sums, origin at the newest reading. *Q: why O(1)?* Each reading decays the sums by exp(−Δ/τ) and adds itself; a test checks it equals a plain weighted least-squares fit.
- `vanstate.ts` `stepVan`: which readings count (driving, warmed up, unflagged), the jump guard, own normal − peers, robust z, 4 of 6, time to limit, and the DTC rate. *Q: why "minus peers" in °C, not z?* A shared +10 °C then cancels exactly, whatever each van's own spread.
- `batch/baselines` (Python + DuckDB): each van's median and MAD per metric, from 12-h window means and slopes in last week's history. *Q: why are the MADs peer-adjusted?* The stream removes the day/night swing with peers; a baseline that still contained it made z too small, so the slope rule never fired.
- *Q: why a region cohort?* Vans without history use the model × duty × region cohort. A climate-blind cohort put hot-region EVs +5 °C "above normal" (the 6 false criticals).
- Runaway = critical only when abnormal after peer adjustment, confirmed k of n, and < 12 h to the limit for 3 readings, using the van's fast rate minus its peers'. *Q: why?* A heatwave step raised 55 criticals before this rule; now 0.
- *Q: why is loudness in history?* A loud-but-stable van's codes are part of its normal. With plant-free history all 20 loud vans tripped the code-rate rule; now 2 of 20.
- `services/state-processor/src/main.ts`: state in memory per partition, JSON checkpoint to Redis every 10 s and on revoke, offsets committed after it. A failed batch exits the process (crash-only). *Q: why no double counting?* Each van's last applied seq skips replays; incident ids are uuid5(vin, family, window) and writes are upserts.
- The itest kills a replica with nothing checkpointed or committed, restarts, replays everything, and still ends with exactly one incident with the same id.
- Scorecard: `npm run eval:incidents` (runs as `cw_sim`, joins ground truth).
- *Q: are sisters caught earlier than the global threshold?* S1b yes (13 h vs 35 h). The main S1 sisters tie (22 h vs 22 h): after an overnight park, both fire on the first readings of day 2.
- **Late sisters** are caught later by the per-van detector (27 h vs 11 h for the global rule). They will be caught earlier by **S5's at-risk-sister rule** (same profile as an open campaign's members), not by per-van detection.
- Telemetry: one row per van per sim-hour into a Timescale hypertable (compression segmented by VIN) plus a real-time hourly aggregate; `npm run vehicle:normal` is the chart query.
- 100K: see `docs/perf/state-processor.md`. One run, not tuned; the telemetry writer's Postgres COPY limited throughput.
