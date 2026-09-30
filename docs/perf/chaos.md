# Chaos checks (S9)

**Setup.** During a live 30K run (run B, sim time past T0+100 h, the simulator still streaming at the 360× demo
rate), [tests/chaos/run.sh](../../tests/chaos/run.sh) injects three faults, 90 s apart:

1. **Redis restart** (`docker compose restart redis`). Redis holds the normaliser's per-VIN anti-replay state.
2. **SIGKILL one normaliser replica** (`docker kill --signal=SIGKILL`), started again 10 s later with `docker start`,
   as an orchestrator would. Docker's restart policy does not restart a container killed by hand.
3. **SIGKILL one state-processor replica**, the same way.

**Measures.**
- **Recovery:** time from the fault until throughput is back to ≥ 80% of its level before the fault, from
  Prometheus (5 s resolution). Canonical-out rate for the normaliser faults, events applied for the
  state-processor fault.
- **No loss:** a normaliser reconcile window spanning all three faults (count in = out + DLQ + duplicates
  dropped), and a second one after the faults.
- **No duplicate effects:** unique counts in Postgres (incidents, campaign members, repairs, queue versions)
  and the outbox drained.

## Results (run C, 30K, 2026-10-01 03:45–03:55 IST, sim ≈ T0+100 → T0+160 h)

| Fault | Down | Throughput before | Lowest after | Back to ≥ 80% after |
|---|---|---|---|---|
| Redis restart (anti-replay state) | 1 s | 1,911 canonical/s | 726/s | **10 s** |
| SIGKILL normaliser replica 1 (1 of 3), started again 10 s later | 11 s | 5,713 canonical/s | 709/s | **15 s** |
| SIGKILL state-processor replica 1 (1 of 3), started again 10 s later | 11 s | 4,247 events/s | 465/s | **50 s** |

The state processor takes longest: its partitions are re-assigned, and the restarted replica reloads its checkpoint
and baselines (the 30K `vehicle_baseline` load, docs/perf/queries.md #5) before it catches up.

**No loss.** The reconcile window 60 s after the faults is **BALANCED**: 106,650 raw records in = 104,123 canonical
out + 161 DLQ + 2,366 duplicates dropped. All replicas were healthy again.

**No duplicate effects** (Postgres, after all three faults):

| Check | Result |
|---|---|
| Incidents: rows = distinct ids = distinct (VIN, family, opened_ts) | 169 = 169 = 169 |
| Campaign members: rows = distinct (campaign, VIN) | 168 = 168 |
| Repairs: rows = distinct (VIN, repaired_ts) | 15 = 15 |
| Queue versions unique per depot | true |
| Outbox rows not yet published | 0 |

**Run 1 (same run, 10 min earlier)** gave the same picture:
- State-processor kill: back in 40 s.
- Reconcile after the faults: BALANCED, 455,673 = 445,986 + 694 + 8,993.
- Unique counts: 157 = 157 incidents, 157 = 157 members, 15 = 15 repairs.

Its Redis and normaliser recovery times are not usable: Prometheus had only just started, so there was no
baseline. Also, a stale copy of my run script restarted Redis a second time, 3 s after the first. Run 2 is the
clean one.

## Limits

- **The whole-window reconcile cannot run across a replica kill.** Its end snapshot reads every replica's
  `/ledger`, and a killed replica's ledger (including its in-memory duplicate counter) is gone. The window after the
  faults, plus the unique counts, is the evidence instead. Persisting the ledger counters (e.g. in Redis) would
  make a whole-window check possible.
- The faults are process-level on one Docker host. Network partitions, broker loss and Postgres failover are not
  tested.
