#!/usr/bin/env bash
# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Submit many jobs fast to build a backlog and trigger autoscaling.
# Usage: ./scripts/load.sh [count] [baseurl]
set -euo pipefail
N="${1:-30}"
BASE="${2:-https://localhost}"

jar="$(mktemp)"
curl -sk -c "$jar" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' >/dev/null

for i in $(seq 1 "$N"); do
  curl -sk -b "$jar" -X POST "$BASE/api/jobs" -H 'Content-Type: application/json' \
    -d "{\"payload\":\"load $i\"}" >/dev/null &
done
wait
echo "submitted $N jobs to $BASE"
