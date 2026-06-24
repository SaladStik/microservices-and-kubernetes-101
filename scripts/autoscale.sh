#!/bin/sh
# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Autoscaler for the Docker Compose demo only. It runs as the `autoscaler`
# service and reads the Kafka backlog (consumer group lag), then scales the
# worker to lag divided by 3, floor 1 and ceiling 10.
#
# This is a stand-in. Real Kubernetes does NOT run this. KEDA scales the
# pods there on the same rule. See docs/10-autoscaling.md.
#
# It scales up right away and scales down after a few idle checks, so it does not
# flap. If the service is toggled down it holds at one, since paused workers
# cannot help.
# set -eu
cd "$(dirname "$0")/.."

GROUP=python-worker
MIN=1
MAX=10
idle=0

scale_to() {
  docker compose up -d --no-recreate --scale "$GROUP=$1" "$GROUP" >/dev/null 2>&1 || true
}

echo "autoscaler running. lag divided by 3, between $MIN and $MAX."
while true; do
  flags=$(docker compose exec -T postgres psql -U orbit -d orbit -tAc \
    "select available, autoscale from worker_control where id=1" 2>/dev/null | tr -d '[:space:]' || true)
  avail=$(echo "$flags" | cut -d'|' -f1)
  auto=$(echo "$flags" | cut -d'|' -f2)
  current=$(docker compose ps -q "$GROUP" 2>/dev/null | wc -l | tr -d ' ')
  [ -z "$current" ] && current=0

  # autoscaling off, force the worker back to the floor and kill any extras now
  if [ "$auto" = "f" ]; then
    [ "$current" != "$MIN" ] && { echo "autoscaling off, scaling $current to $MIN"; scale_to $MIN; }
    idle=0
    sleep 5
    continue
  fi

  lag=$(docker compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 --describe --group "$GROUP" 2>/dev/null \
    | awk 'NR>1 && $6 ~ /^[0-9]+$/ { s += $6 } END { print s + 0 }' 2>/dev/null || echo 0)
  [ -z "$lag" ] && lag=0

  if [ "$avail" = "f" ]; then
    desired=$MIN
  else
    desired=$(( (lag + 2) / 3 ))
  fi
  [ "$desired" -lt "$MIN" ] && desired=$MIN
  [ "$desired" -gt "$MAX" ] && desired=$MAX

  if [ "$desired" -gt "$current" ]; then
    echo "lag $lag, scaling up $current to $desired"
    scale_to $desired
    idle=0
  elif [ "$desired" -lt "$current" ]; then
    idle=$(( idle + 1 ))
    if [ "$idle" -ge 3 ]; then
      echo "idle, scaling down $current to $desired"
      scale_to $desired
      idle=0
    fi
  else
    idle=0
  fi
  sleep 5
done
