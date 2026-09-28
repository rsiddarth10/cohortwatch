#!/bin/sh
# One-shot: create every topic in brief §4.1 (idempotent). Dev cluster = 1 broker, RF 1.
#
# LAPTOP_RETENTION=on (default) caps the high-volume topics so a laptop disk cannot fill:
#   raw.oem-a.v1, raw.oem-b.v1, telemetry.canonical.v1 -> 6 h, KAFKA_PARTITION_BYTES per partition
#   bench.raw.v1 (bench mode only)                       -> 10 min, same byte cap
# segment.bytes is kept small because Redpanda only deletes closed segments.
# LAPTOP_RETENTION=off restores the production values (brief §4.1: 3 d, no byte cap).
# Configs are applied on every run, so changing the env and re-running topic-init updates existing topics.
set -eu
BROKERS="${KAFKA_BROKERS:-redpanda:9092}"
RF="${TOPIC_REPLICATION:-1}"
LAPTOP="${LAPTOP_RETENTION:-on}"
PART_BYTES="${KAFKA_PARTITION_BYTES:-67108864}" # 64 MiB
SEGMENT_BYTES=16777216                          # 16 MiB
MIN_MS=60000
HOUR_MS=3600000
DAY_MS=86400000

# name partitions retention_ms capped(1 = laptop cap applies)
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
bench.raw.v1 48 $((10 * MIN_MS)) 1
"

echo "laptop retention: $LAPTOP (partition cap $PART_BYTES bytes)"
echo "$TOPICS" | while read -r name parts retention capped; do
  [ -z "$name" ] && continue
  if [ "$capped" = 1 ] && [ "$LAPTOP" = on ]; then
    [ "$name" = bench.raw.v1 ] || retention=$((6 * HOUR_MS))
    set_cfg="retention.ms=$retention retention.bytes=$PART_BYTES segment.bytes=$SEGMENT_BYTES"
    del_cfg=""
  else
    set_cfg="retention.ms=$retention"
    del_cfg="retention.bytes segment.bytes"
  fi
  if rpk topic describe "$name" -X brokers="$BROKERS" >/dev/null 2>&1; then
    echo "exists  $name  ($set_cfg)"
  else
    # tolerate a concurrent creator (TOPIC_ALREADY_EXISTS); fail only if the topic still is not there
    rpk topic create "$name" -p "$parts" -r "$RF" -c cleanup.policy=delete -X brokers="$BROKERS" ||
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
