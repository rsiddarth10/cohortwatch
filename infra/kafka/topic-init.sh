#!/bin/sh
# One-shot: create every topic in brief §4.1 (idempotent). Dev cluster = 1 broker, RF 1.
set -eu
BROKERS="${KAFKA_BROKERS:-redpanda:9092}"
RF="${TOPIC_REPLICATION:-1}"
DAY_MS=86400000

# name partitions retention_days
TOPICS="
raw.oem-a.v1 24 3
raw.oem-b.v1 24 3
telemetry.canonical.v1 48 3
telemetry.dlq.v1 6 14
incidents.v1 24 14
campaign.events.v1 12 30
agent.proposals.v1 6 30
audit.v1 6 90
workshop.repairs.v1 3 7
"

echo "$TOPICS" | while read -r name parts days; do
  [ -z "$name" ] && continue
  retention=$((days * DAY_MS))
  if rpk topic describe "$name" -X brokers="$BROKERS" >/dev/null 2>&1; then
    echo "exists  $name"
    rpk topic alter-config "$name" --set retention.ms="$retention" -X brokers="$BROKERS" >/dev/null
  else
    rpk topic create "$name" -p "$parts" -r "$RF" -c retention.ms="$retention" -c cleanup.policy=delete \
      -X brokers="$BROKERS"
  fi
done
rpk topic list -X brokers="$BROKERS"
