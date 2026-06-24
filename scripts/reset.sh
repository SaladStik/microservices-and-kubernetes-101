#!/usr/bin/env bash
# Full reset of the local Docker stack. Wipes the Postgres database and the Kafka
# topics, then brings everything back fresh. macOS and Linux.
#
#   ./scripts/reset.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Resetting Orbit. This deletes the Postgres data and all Kafka topics."
docker compose down -v
docker compose up -d

# On a cold start the worker can latch onto Kafka before the broker has fully
# settled and get stuck rejoining the consumer group. Give Kafka a moment, then
# restart the consumers so they connect cleanly.
echo "Waiting for Kafka to settle..."
sleep 20
docker compose restart python-worker node-gateway

echo "Done. Open https://localhost in a minute (admin / admin)."
