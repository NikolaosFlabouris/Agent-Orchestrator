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

# Extract token usage from agent output (Claude Code stream-json format).
# The last JSON line carrying a `.usage` object has cumulative totals.
# Tools that don't report usage (e.g. OpenCode against local LLMs) leave
# all three values as the JSON literal "null".
#
# Previously this used `grep -o '{"usage":.*}'`, which is greedy: if any
# single line happened to contain multiple JSON objects with "usage"
# fields, the .* would span from the first "usage" to the last `}` on
# the line and the pieced-together value would fail jq parsing. Switching
# to `jq -c 'select(.usage != null)'` reads one full JSON value per
# input line and emits the whole object only when its top level has a
# .usage field — robust against nested usage objects, multi-object lines,
# and malformed/truncated trailing lines (the `--exit-status 1` style
# is not needed because we tolerate empty output).
INPUT_TOKENS="null"
OUTPUT_TOKENS="null"
MODEL="null"
USAGE_LINE=$(jq -c 'select(.usage != null)' "$AGENT_LOG" 2>/dev/null | tail -1 || true)
if [ -n "$USAGE_LINE" ]; then
  INPUT_TOKENS=$(echo "$USAGE_LINE" | jq -r '.usage.input_tokens // null')
  OUTPUT_TOKENS=$(echo "$USAGE_LINE" | jq -r '.usage.output_tokens // null')
  # MODEL is sourced from meta.json (the orchestrator's launch-time
  # snapshot of the resolved model id), NOT from the usage line — usage
  # entries on the stream don't carry the model field consistently
  # across stream-json versions. Gated on USAGE_LINE being non-empty so
  # we don't report a model id for a run that produced zero usage
  # events (those are almost always pre-API-call failures where the
  # model id is misleading).
  MODEL=$(jq -r '.model // null' "$META")
fi

cat > "$RESULT" <<EOF
{
  "status": "$STATUS",
  "exit_code": $AGENT_EXIT,
  "error_message": $ERROR_MSG,
  "usage": {
    "input_tokens": $INPUT_TOKENS,
    "output_tokens": $OUTPUT_TOKENS,
    "model": "$MODEL"
  }
}
EOF
