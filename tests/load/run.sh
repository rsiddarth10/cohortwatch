#!/bin/sh
# Load + soak (S9): k6 (pinned image) on the compose network against the API, plus 50 SSE clients from the host.
# Usage: sh tests/load/run.sh load|soak [sse_seconds]   (stack must be up; see docs/perf/load.md)
set -e
PROFILE=${1:-load}
SSE_S=${2:-0}
cd "$(dirname "$0")/../.."
TOKEN=$(node tests/perf/token.mjs lead)
if [ "$SSE_S" -gt 0 ]; then node tests/load/sse-clients.mjs 50 "$SSE_S" > "tests/load/sse-$PROFILE.log" 2>&1 & fi
docker run --rm --network cohortwatch_default -v "$(pwd)/tests/load:/scripts" grafana/k6:0.54.0 \
  run -q -e TOKEN="$TOKEN" -e API=http://api:3100 -e PROFILE="$PROFILE" /scripts/api.js
wait
[ "$SSE_S" -gt 0 ] && tail -1 "tests/load/sse-$PROFILE.log" || true
