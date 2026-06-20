#!/bin/bash
set -euo pipefail

OUTPUT_DIR="/output"
AGENT_LOG="$OUTPUT_DIR/progress.log"
RESULT="$OUTPUT_DIR/result.json"
TASK_DIR="/task"
META="$TASK_DIR/meta.json"

mkdir -p "$OUTPUT_DIR"

MAX_MINUTES=$(jq -r '.max_runtime_minutes' "$META")
AGENT_COMMAND=$(jq -r '.agent_command' "$META")
ATTEMPT=$(jq -r '.attempt' "$META")
ROLE=$(jq -r '.role' "$META")

# Install steps (dependency install). Each entry of meta.install_commands is
# { command, cwd } pre-resolved by the orchestrator from the repo's typed
# install_steps — operators cannot inject free-text shell here. Steps run
# sequentially under a single flock against /cache so concurrent containers
# on the same repo don't race on the dependency cache.
LOCKFILE="/cache/.dep-install-lock"
INSTALL_COUNT=$(jq -r '.install_commands | length' "$META")
if [ "$INSTALL_COUNT" -gt 0 ]; then
  (
    flock -w 300 200
    for i in $(seq 0 $((INSTALL_COUNT - 1))); do
      CMD=$(jq -r ".install_commands[$i].command" "$META")
      CWD=$(jq -r ".install_commands[$i].cwd" "$META")
      ( cd "$CWD" && sh -c "$CMD" )
    done
  ) 200>"$LOCKFILE"
fi

# prompt.md is the complete prompt — including review feedback on rework cycles.
# The orchestrator assembles the full prompt before the container starts. The
# harness module that produced AGENT_COMMAND already embeds the literal
# /task/prompt.md path (via `< /task/prompt.md`, `@/task/prompt.md`, or
# `"$(cat /task/prompt.md)"` depending on the binary). The agent reads the
# file itself, so prompt content never reaches the shell as code.

# Run agent with timeout
AGENT_EXIT=0
timeout --foreground --kill-after=30s "${MAX_MINUTES}m" \
  bash -c "$AGENT_COMMAND" \
  > "$AGENT_LOG" 2>&1 \
  || AGENT_EXIT=$?

# Kill orphaned processes
pkill -P $$ 2>/dev/null || true

# Determine status and error message
ERROR_MSG="null"
if [ "$AGENT_EXIT" -eq 124 ]; then
  STATUS="timeout"
  ERROR_MSG="\"Agent exceeded timeout of ${MAX_MINUTES} minutes\""
elif [ "$AGENT_EXIT" -ne 0 ]; then
  STATUS="failure"
  # Prefer a structured error from the agent's output, when available.
  # Claude Code's stream-json mode emits a final {"type":"result", ...}
  # event whose ".result" field carries a human-readable error (e.g. an
  # API 404 with the offending model id). Surfacing that is far more
  # actionable than tail -5 of a multi-KB JSON blob, where the long init
  # line crowds out the actual failure.
  RESULT_LINE=$(grep -a '^{"type":"result"' "$AGENT_LOG" 2>/dev/null | tail -1 || true)
  if [ -n "$RESULT_LINE" ] \
     && [ "$(echo "$RESULT_LINE" | jq -r '.is_error // false' 2>/dev/null)" = "true" ]; then
    RESULT_TEXT=$(echo "$RESULT_LINE" | jq -r '.result // empty' 2>/dev/null)
    API_STATUS=$(echo "$RESULT_LINE" | jq -r '.api_error_status // empty' 2>/dev/null)
    if [ -n "$RESULT_TEXT" ]; then
      if [ -n "$API_STATUS" ]; then
        ERROR_MSG=$(printf '[API %s] %s' "$API_STATUS" "$RESULT_TEXT" | jq -Rs '.')
      else
        ERROR_MSG=$(printf '%s' "$RESULT_TEXT" | jq -Rs '.')
      fi
    fi
  fi
  # Fallback: last 5 lines of raw agent output (covers tools that don't
  # emit stream-json, like OpenCode's text logs, and pre-init failures).
  if [ "$ERROR_MSG" = "null" ]; then
    ERROR_MSG=$(tail -5 "$AGENT_LOG" 2>/dev/null | jq -Rs '.' || echo '"Agent exited with code '$AGENT_EXIT'"')
  fi
else
  STATUS="success"
fi

# For review agents, verify review.json
if [ "$ROLE" = "review" ] && [ "$STATUS" = "success" ]; then
  if ! jq -e '.verdict' /output/review.json > /dev/null 2>&1; then
    STATUS="failure"
  fi
fi

# Best-effort per-run usage (#115). Claude Code's stream-json mode emits a
# final {"type":"result", ...} event carrying num_turns and a usage object
# with input/output token counts. Parse it into a `usage` block when present;
# tools that don't emit stream-json (OpenCode's text logs, etc.) leave it out
# and the orchestrator keeps the attempt's usage columns NULL. Raw counts
# only — no dollar cost is computed. Never fails the run: any jq error or
# missing field collapses to an empty USAGE_FIELD.
USAGE_FIELD=""
USAGE_LINE=$(grep -a '^{"type":"result"' "$AGENT_LOG" 2>/dev/null | tail -1 || true)
if [ -n "$USAGE_LINE" ]; then
  USAGE_JSON=$(echo "$USAGE_LINE" | jq -c '
    {}
    + (if (.num_turns | type) == "number" then { num_turns: .num_turns } else {} end)
    + (if (.usage.input_tokens | type) == "number" then { input_tokens: .usage.input_tokens } else {} end)
    + (if (.usage.output_tokens | type) == "number" then { output_tokens: .usage.output_tokens } else {} end)
  ' 2>/dev/null || true)
  if [ -n "$USAGE_JSON" ] && [ "$USAGE_JSON" != "{}" ]; then
    USAGE_FIELD=",
  \"usage\": $USAGE_JSON"
  fi
fi

cat > "$RESULT" <<EOF
{
  "status": "$STATUS",
  "exit_code": $AGENT_EXIT,
  "error_message": $ERROR_MSG$USAGE_FIELD
}
EOF
