#!/usr/bin/env bash
# Redeploy the live orchestrator from its deploy directory, so harness
# modules and the smoke runner changed under packages/** are what the smoke
# test runs.
#
#   bash scripts/ci/redeploy-orchestrator.sh <deploy-dir>
#
# The deploy directory is the operator's checkout that compose project
# `agent-orchestrator` runs from (it holds the untracked .env). It is
# bind-mounted into the job at the same path. Compose only ever runs inside
# it, never in the job's own checkout, so no second stack can appear.
set -euo pipefail

dir=${1:?usage: redeploy-orchestrator.sh <deploy-dir>}
project=agent-orchestrator

fail() {
  echo "::error::$*"
  exit 1
}

if [ ! -f "$dir/docker-compose.yml" ] || [ ! -f "$dir/.env" ]; then
  fail "$dir is not the orchestrator deploy directory (docker-compose.yml/.env missing). Is it in the runner's valid_volumes?"
fi

# Run git as the checkout's owner, so a pull from a root job container
# doesn't leave root-owned files in the operator's working tree.
owner_uid=$(stat -c %u "$dir")
owner_gid=$(stat -c %g "$dir")
dgit() {
  if [ "$(id -u)" = 0 ] && [ "$owner_uid" != 0 ] && command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$owner_uid" --regid="$owner_gid" --clear-groups \
      env HOME=/tmp git -c safe.directory="$dir" -C "$dir" "$@"
  else
    git -c safe.directory="$dir" -C "$dir" "$@"
  fi
}

branch=$(dgit symbolic-ref --short -q HEAD || echo '(detached HEAD)')
if [ "$branch" != main ]; then
  fail "deploy directory $dir is on '$branch', not 'main'. Check out main there and re-run the workflow."
fi
dirty=$(dgit status --porcelain)
if [ -n "$dirty" ]; then
  echo "$dirty"
  fail "deploy directory $dir has uncommitted changes (listed above). Commit, stash or discard them and re-run the workflow."
fi

dgit pull --ff-only

# --no-deps: `up orchestrator` would otherwise also rebuild the agent-image
# service and retag orchestrator-agent:latest with an untested build. The
# agent image only changes through the smoke-gated promotion.
# stop_grace_period (35m) lets running agents drain, so this can block that
# long; the job timeout allows for it.
cd "$dir"
docker compose --project-name "$project" up -d --build --no-deps orchestrator

# Wait until the new container is running and has the smoke runner.
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' orchestrator 2>/dev/null)" = true ] \
    && docker exec orchestrator test -f packages/server/dist/scripts/harness-smoke.js; then
    echo "orchestrator redeployed at $(dgit rev-parse --short HEAD)"
    exit 0
  fi
  sleep 5
done
fail "orchestrator did not come back up after redeploy (docker logs orchestrator)"
