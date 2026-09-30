#!/bin/sh
# Chaos checks (S9, docs/perf/chaos.md). Run during a live run with the observability profile up (Prometheus).
#   1. restart Redis (the normaliser's anti-replay state)
#   2. SIGKILL one normaliser replica, then start it again (as an orchestrator would)
#   3. SIGKILL one state-processor replica, then start it again
# Recovery = time from the fault until the pipeline's canonical-out rate is back to >= 80% of its level before the
# fault (normaliser faults) or until the state processor's event rate is (state-processor fault), read from
# Prometheus. Exactness: a normaliser reconcile window spanning all three faults, plus unique counts in Postgres.
set -e
cd "$(dirname "$0")/../.."
PROM=${PROM:-http://localhost:9090}
GAP=${GAP:-90}          # seconds between faults
DOWN=${DOWN:-10}        # seconds a killed replica stays down before it is started again
OUT=tests/chaos/last-run.txt
: > "$OUT"
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$OUT"; }
now() { date +%s; }

# reconcile window covering the whole experiment (started in the background, reported at the end)
LEDGERS=$(for p in 9465 9466 9467 9468; do curl -sf -m 2 "http://localhost:$p/ledger" >/dev/null && printf 'http://localhost:%s/ledger,' "$p"; done; true)
SECS=$((GAP * 3 + 120))
node services/normaliser/dist/cli/reconcile.js --seconds "$SECS" --ledger "${LEDGERS%,}" > tests/chaos/reconcile.txt 2>&1 &
REC=$!
sleep 30

T1=$(now); log "fault 1: docker compose restart redis"
docker compose restart redis >/dev/null 2>&1
log "redis back (restart took $(( $(now) - T1 )) s)"
sleep "$GAP"

N=$(docker ps --filter name=cohortwatch-normaliser --format '{{.Names}}' | sort | head -1)
T2=$(now); log "fault 2: SIGKILL $N"
docker kill --signal=SIGKILL "$N" >/dev/null
sleep "$DOWN"; docker start "$N" >/dev/null; log "$N started again"
sleep "$GAP"

S=$(docker ps --filter name=cohortwatch-state-processor --format '{{.Names}}' | sort | head -1)
T3=$(now); log "fault 3: SIGKILL $S"
docker kill --signal=SIGKILL "$S" >/dev/null
sleep "$DOWN"; docker start "$S" >/dev/null; log "$S started again"
sleep "$GAP"

wait "$REC" || true
log "reconcile over the whole experiment (note: a killed replica's in-memory duplicate counter is lost with it):"
cat tests/chaos/reconcile.txt | tee -a "$OUT"
LEDGERS=$(for p in 9465 9466 9467 9468; do curl -sf -m 2 "http://localhost:$p/ledger" >/dev/null && printf 'http://localhost:%s/ledger,' "$p"; done; true)
log "reconcile, 60 s after the faults (steady state again):"
node services/normaliser/dist/cli/reconcile.js --seconds 60 --ledger "${LEDGERS%,}" 2>&1 | tail -7 | tee -a "$OUT" || true

# recovery times from Prometheus (5 s resolution)
recovery() { # $1 = fault epoch, $2 = PromQL rate expression
  node -e '
    const [t, q, prom] = process.argv.slice(1);
    const T = Number(t);
    const u = `${prom}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${T - 120}&end=${T + 600}&step=5`;
    fetch(u).then((r) => r.json()).then((j) => {
      const v = (j.data.result[0]?.values ?? []).map(([ts, x]) => [Number(ts), Number(x)]);
      const before = v.filter(([ts]) => ts < T - 5).map(([, x]) => x);
      const base = before.reduce((a, b) => a + b, 0) / Math.max(1, before.length);
      const dip = v.filter(([ts]) => ts >= T).map(([, x]) => x);
      const min = Math.min(...dip);
      const back = v.find(([ts, x]) => ts > T + 5 && x >= 0.8 * base && dip.length);
      const rec = back ? back[0] - T : null;
      console.log(`base ${base.toFixed(0)}/s, lowest after the fault ${min.toFixed(0)}/s, back to >= 80% after ${rec === null ? "no recovery in 10 min" : rec + " s"}`);
    });' "$1" "$2" "$PROM"
}
sleep 20
log "recovery, redis restart (canonical out): $(recovery "$T1" 'sum(rate(cw_norm_out_total[15s]))')"
log "recovery, normaliser kill (canonical out): $(recovery "$T2" 'sum(rate(cw_norm_out_total[15s]))')"
log "recovery, state-processor kill (events applied): $(recovery "$T3" 'sum(rate(cw_state_events_total[15s]))')"

log "unique counts (no duplicate effects after the faults):"
docker compose exec -T postgres psql -U postgres -d cohortwatch -At -c "
  SELECT 'incidents rows ' || count(*) || ' = distinct ids ' || count(DISTINCT id) || ' = distinct (vin, family, opened_ts) ' || count(DISTINCT (vin, fault_family, opened_ts)) FROM core.incident;
  SELECT 'campaign member rows ' || count(*) || ' = distinct (campaign, vin) ' || count(DISTINCT (campaign_id, vin)) FROM core.campaign_member;
  SELECT 'repairs ' || count(*) || ' = distinct (vin, repaired_ts) ' || count(DISTINCT (vin, repaired_ts)) FROM core.repair;
  SELECT 'queue versions per depot unique: ' || (count(*) = count(DISTINCT (depot_id, version))) FROM core.queue_snapshot;
  SELECT 'outbox unpublished ' || count(*) FROM core.outbox WHERE published_at IS NULL;" | tee -a "$OUT"
docker compose ps --format '{{.Service}} {{.Status}}' | grep -E 'normaliser|state-processor|redis' | tee -a "$OUT"
