#!/usr/bin/env bash
# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Start the whole stack locally. You only need Docker. macOS and Linux.
set -euo pipefail
cd "$(dirname "$0")"
echo "Starting Orbit. When it is up open https://localhost and log in with admin / admin."
docker compose up --build "$@"
