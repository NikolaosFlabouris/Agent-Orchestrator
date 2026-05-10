#!/usr/bin/env bash
# Build the agent container image used by the orchestrator.
#
# A single image — orchestrator-agent:latest — ships the Node, Python, and Go
# toolchains plus the harnesses and agent CLIs (see images/agent/Dockerfile).
# This replaces the previous orchestrator-agent-{base,node,python,go} hierarchy
# so adding a repo no longer requires picking a language image.
#
# Run from the repo root. Idempotent — Docker's layer cache handles re-runs.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Ensure the agent-network exists. docker-compose.yml declares it as external,
# so it must exist before `docker compose up`. Idempotent — no-op if present.
if ! docker network inspect agent-network >/dev/null 2>&1; then
  echo "==> Creating agent-network (bridge)"
  docker network create --driver bridge agent-network
fi

echo "==> Building orchestrator-agent:latest"
docker build \
  -t orchestrator-agent:latest \
  -f images/agent/Dockerfile \
  .

echo
echo "Agent image built:"
docker images --filter "reference=orchestrator-agent" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"
