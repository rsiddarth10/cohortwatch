# Step 9: evaluation, ML, load, tuning, observability. What I learned

1. **An evaluation needs a fixed end point.** A stack left running kept adding sim-days, and the background false-incident rate grew with it. Pausing the sim clock at T0+88 h made every scored run comparable.
2. **Take N from the data, not the config.** My first `eval:all` labelled a 30K run as 5K because the host config said 5,000.
3. **Report the cells where the baseline wins.** The global threshold fired 0.2 h earlier on the runaway at 5K, and the page says so, with what that rule costs (175 false alarms per 1,000 healthy vans).
4. **Batching can make a query slower.** 30,000 VINs through `vin = ANY(…)` probed the key 30,000 times (6.1 s). One time-range scan did the same work in 1.3 s. EXPLAIN's buffer counts showed it, not intuition.
5. **Unneeded sorts are expensive.** `ORDER BY vin` on a text cast spilled to disk. The code groups rows in memory anyway, so `ORDER BY ts DESC` (a backward index scan) was 5× faster.
6. **"Only re-rank what changed" needs a change signal.** Telemetry changes every depot every hour, so the honest version reads everything once and writes only what differs.
7. **Categorical features can learn the scenario, not the signal.** If the plants always sit in the same kind of cohort, the model learns "diesel urban breaks". Train on one seed, test on another, and also report a signals-only variant.
8. **Background jobs show up in `pg_stat_statements`.** The TimescaleDB aggregate refresh ranked third. It is a freshness trade-off, not a tuning knob.
9. **Chaos needs "no loss" and "no duplicates" as separate proofs.** Count in = count out, and unique counts downstream. A killed replica takes its in-memory counters with it.
10. **Contract tests pin what the UI reads, nothing more.** Type matchers let the API add fields freely.
