#!/usr/bin/env bash
# Make sure the job container has the Docker CLI plus the buildx and compose
# plugins. The runner mounts the host's Docker socket into `docker`-label job
# containers, but the job image (node:22-bookworm) ships no Docker client.
# Static binaries, pinned; each piece is skipped when it is already present.
# Used by .forgejo/workflows/harness-update.yml and agent-image-rebuild.yml.
set -euo pipefail

DOCKER_VERSION=27.5.1
BUILDX_VERSION=0.20.1
COMPOSE_VERSION=2.32.4

case "$(uname -m)" in
  x86_64) arch=x86_64; goarch=amd64 ;;
  aarch64 | arm64) arch=aarch64; goarch=arm64 ;;
  *) echo "::error::unsupported architecture $(uname -m)"; exit 1 ;;
esac

plugins=/usr/local/lib/docker/cli-plugins
mkdir -p "$plugins"

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker
fi
if ! docker buildx version >/dev/null 2>&1; then
  curl -fsSL -o "$plugins/docker-buildx" \
    "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${goarch}"
  chmod +x "$plugins/docker-buildx"
fi
if ! docker compose version >/dev/null 2>&1; then
  curl -fsSL -o "$plugins/docker-compose" \
    "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${arch}"
  chmod +x "$plugins/docker-compose"
fi

docker version --format 'Docker client {{.Client.Version}}, daemon {{.Server.Version}}'
docker buildx version
docker compose version
