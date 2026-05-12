#!/usr/bin/env bash
# Force-rebuild the agent container image (`orchestrator-agent:latest`).
#
# The standard bring-up path is `docker compose up -d --build`, which
# builds this image automatically via the `agent-image` service in
# docker-compose.yml. This script is a convenience wrapper for the case
# where you only want to rebuild the agent image — e.g. after editing
# images/agent/Dockerfile or anything under harness/ — without
# restarting the orchestrator container.
#
# After the rebuild, the NEXT agent container the orchestrator spawns
# will use the updated image. Containers already running keep their
# original image (Docker behaviour, not something this script changes).
#
# Idempotent — Docker's layer cache handles re-runs.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Building orchestrator-agent:latest"
docker compose build agent-image

echo
echo "Agent image built:"
docker images --filter "reference=orchestrator-agent" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"
