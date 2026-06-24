#!/usr/bin/env bash
# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Make a self signed cert here using Docker, so no host openssl is needed.
# The Compose path makes this for you. Use this for the Kubernetes path.
set -euo pipefail
cd "$(dirname "$0")"
docker run --rm -v "$PWD:/certs" alpine/openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout /certs/tls.key -out /certs/tls.crt -days 365 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "wrote tls.crt and tls.key"
