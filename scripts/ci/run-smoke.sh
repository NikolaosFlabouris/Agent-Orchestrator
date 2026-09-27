#!/usr/bin/env bash
# Run the harness smoke test against <image> inside the live orchestrator
# container and copy its JSON report out to <report.json>.
#
#   bash scripts/ci/run-smoke.sh <image> <report.json>
#
# Exit 0 when a report was produced, even if cases failed (smoke exit 1):
# the decision is made from the report by scripts/harness-update.mjs. A
# runner error (smoke exit 2) or a missing report fails the step.
set -uo pipefail

image=${1:?usage: run-smoke.sh <image> <report.json>}
out=${2:?usage: run-smoke.sh <image> <report.json>}
remote="/tmp/harness-smoke-${GITHUB_RUN_ID:-manual}-$$.json"

docker exec orchestrator node packages/server/dist/scripts/harness-smoke.js \
  --image "$image" --json "$remote"
rc=$?
if [ "$rc" -ge 2 ]; then
  echo "::error::harness smoke runner error (exit $rc) — see the log above; nothing promoted"
  exit "$rc"
fi
if ! docker cp "orchestrator:$remote" "$out"; then
  echo "::error::harness smoke test (exit $rc) wrote no report at $remote"
  exit 1
fi
docker exec orchestrator rm -f "$remote" || true
echo "harness smoke test exit code $rc; report at $out"
