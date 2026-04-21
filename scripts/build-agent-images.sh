#!/usr/bin/env bash
# Build the agent container images used by the orchestrator.
#
# Image hierarchy (see docs/03-agent-containers.md):
#   orchestrator-agent-base       <- Ubuntu + Node 22 + Claude Code + OpenCode + Agent SDK + harnesses
#     orchestrator-agent-node     <- base (Node-specific customizations go here)
#     orchestrator-agent-python   <- base + python3, pip, venv
#     orchestrator-agent-go       <- base + Go toolchain
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

echo "==> Building orchestrator-agent-base:latest"
docker build \
  -t orchestrator-agent-base:latest \
  -f images/base/Dockerfile \
  .

for lang in node python go; do
  echo "==> Building orchestrator-agent-${lang}:latest"
  docker build \
    -t "orchestrator-agent-${lang}:latest" \
    -f "images/${lang}/Dockerfile" \
    "images/${lang}"
done

echo
echo "Agent images built:"
docker images --filter "reference=orchestrator-agent-*" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"
