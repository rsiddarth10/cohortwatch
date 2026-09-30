#!/bin/sh
# One-shot: create every topic in brief §4.1 (idempotent). Dev cluster = 1 broker, RF 1.
#
# LAPTOP_RETENTION=on (default) caps the high-volume topics so a laptop disk cannot fill:
#   raw.oem-a.v1, raw.oem-b.v1, telemetry.canonical.v1 -> 6 h, KAFKA_PARTITION_BYTES per partition
#   bench.raw.v1, bench.canonical.v1 (bench only)       -> 10 min, BENCH_PARTITION_BYTES per partition
# segment.bytes is kept small because Redpanda only deletes closed segments, and segment.ms = 10 min closes idle ones.
# Configs are passed at create time too: Redpanda applies a changed segment size only from the next segment.
# Laptop mode also lowers segment_fallocation_step (32 MiB preallocated per partition -> 1 MiB).
# LAPTOP_RETENTION=off restores the production values (brief §4.1: 3 d, no byte cap).
# Configs are applied on every run, so changing the env and re-running topic-init updates existing topics.
set -eu
BROKERS="${KAFKA_BROKERS:-redpanda:9092}"
RF="${TOPIC_REPLICATION:-1}"
LAPTOP="${LAPTOP_RETENTION:-on}"
PART_BYTES="${KAFKA_PARTITION_BYTES:-268435456}"      # 256 MiB
BENCH_BYTES="${BENCH_PARTITION_BYTES:-16777216}"      # 16 MiB: bench measures throughput, keeps nothing
SEGMENT_BYTES=16777216                          # 16 MiB
SEGMENT_MS=600000                               # 10 min (Redpanda's minimum)
MIN_MS=60000
HOUR_MS=3600000
DAY_MS=86400000

# name partitions retention_ms capped(0 = never, 1 = laptop cap, 2 = bench cap)
TOPICS="
raw.oem-a.v1 24 $((3 * DAY_MS)) 1
raw.oem-b.v1 24 $((3 * DAY_MS)) 1
telemetry.canonical.v1 48 $((3 * DAY_MS)) 1
telemetry.dlq.v1 6 $((14 * DAY_MS)) 0
incidents.v1 24 $((14 * DAY_MS)) 0
campaign.events.v1 12 $((30 * DAY_MS)) 0
agent.proposals.v1 6 $((30 * DAY_MS)) 0
audit.v1 6 $((90 * DAY_MS)) 0
workshop.repairs.v1 3 $((7 * DAY_MS)) 0
workshop.outcomes.v1 6 $((30 * DAY_MS)) 0
queue.events.v1 12 $((7 * DAY_MS)) 0
bench.raw.v1 48 $((10 * MIN_MS)) 2
bench.canonical.v1 48 $((10 * MIN_MS)) 2
"

echo "laptop retention: $LAPTOP (partition cap $PART_BYTES bytes, bench $BENCH_BYTES bytes)"
if [ "$LAPTOP" = on ]; then FALLOC=1048576; else FALLOC=33554432; fi
rpk cluster config set segment_fallocation_step "$FALLOC" -X brokers="$BROKERS" -X admin.hosts="${ADMIN_HOSTS:-redpanda:9644}" >/dev/null
echo "$TOPICS" | while read -r name parts retention capped; do
  [ -z "$name" ] && continue
  if [ "$capped" = 2 ]; then
    # bench topics are capped in every mode (10 min, small partitions)
    set_cfg="retention.ms=$retention retention.bytes=$BENCH_BYTES segment.bytes=$SEGMENT_BYTES segment.ms=$SEGMENT_MS"
    del_cfg=""
  elif [ "$capped" = 1 ] && [ "$LAPTOP" = on ]; then
    retention=$((6 * HOUR_MS))
    set_cfg="retention.ms=$retention retention.bytes=$PART_BYTES segment.bytes=$SEGMENT_BYTES segment.ms=$SEGMENT_MS"
    del_cfg=""
  else
    set_cfg="retention.ms=$retention"
    del_cfg="retention.bytes segment.bytes segment.ms"
  fi
  if rpk topic describe "$name" -X brokers="$BROKERS" >/dev/null 2>&1; then
    echo "exists  $name  ($set_cfg)"
  else
    # tolerate a concurrent creator (TOPIC_ALREADY_EXISTS); fail only if the topic still is not there
    create_cfg="-c cleanup.policy=delete"
    for kv in $set_cfg; do create_cfg="$create_cfg -c $kv"; done
    # shellcheck disable=SC2086 # word splitting of create_cfg is intended
    rpk topic create "$name" -p "$parts" -r "$RF" $create_cfg -X brokers="$BROKERS" ||
      rpk topic describe "$name" -X brokers="$BROKERS" >/dev/null
  fi
  for kv in $set_cfg; do
    rpk topic alter-config "$name" --set "$kv" -X brokers="$BROKERS" >/dev/null
  done
  for k in $del_cfg; do
    rpk topic alter-config "$name" --delete "$k" -X brokers="$BROKERS" >/dev/null 2>&1 || true
  done
done
rpk topic list -X brokers="$BROKERS"
