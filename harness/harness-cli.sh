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
PRE_SCRIPT=$(jq -r '.pre_agent_script // empty' "$META")
ATTEMPT=$(jq -r '.attempt' "$META")
ROLE=$(jq -r '.role' "$META")

# Pre-agent script (dependency install)
# Lock file lives on /cache (shared volume) — NOT /tmp (container-local)
#
# Note: PRE_SCRIPT is executed via eval with full shell access.
# The value is configured per repository via the Settings UI and stored in the DB.
# It runs inside the agent container with access to all environment variables,
# including LLM API keys and the agent git token. The UI warns administrators
# when the value doesn't match a known dependency install pattern.
if [ -n "$PRE_SCRIPT" ]; then
  LOCKFILE="/cache/.dep-install-lock"
  (
    flock -w 300 200
    eval "$PRE_SCRIPT"
  ) 200>"$LOCKFILE"
fi

# prompt.md is the complete prompt — including review feedback on rework cycles.
# The orchestrator assembles the full prompt before the container starts.
PROMPT="$TASK_DIR/prompt.md"

# Prompt substitution: {{PROMPT_FILE}} is replaced with the literal path
# /task/prompt.md. The agent tool reads the file itself (e.g. via
# `"$(cat {{PROMPT_FILE}})"`), so prompt content never reaches the shell as
# code — safe against shell metacharacters in user-authored issue bodies.
RESOLVED_COMMAND="${AGENT_COMMAND//\{\{PROMPT_FILE\}\}/$PROMPT}"

# Run agent with timeout
AGENT_EXIT=0
timeout --foreground --kill-after=30s "${MAX_MINUTES}m" \
  bash -c "$RESOLVED_COMMAND" \
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
  # Capture last 5 lines of agent output as error context
  ERROR_MSG=$(tail -5 "$AGENT_LOG" 2>/dev/null | jq -Rs '.' || echo '"Agent exited with code '$AGENT_EXIT'"')
else
  STATUS="success"
fi

# For review agents, verify review.json
if [ "$ROLE" = "review" ] && [ "$STATUS" = "success" ]; then
  if ! jq -e '.verdict' /output/review.json > /dev/null 2>&1; then
    STATUS="failure"
  fi
fi

# Extract token usage from agent output (Claude Code stream-json format)
# The last JSON line with a "usage" field contains cumulative totals.
# For tools that don't report usage (e.g., OpenCode with local LLMs), usage is null.
INPUT_TOKENS="null"
OUTPUT_TOKENS="null"
MODEL="null"
USAGE_LINE=$(grep -o '{"usage":.*}' "$AGENT_LOG" | tail -1 2>/dev/null || true)
if [ -n "$USAGE_LINE" ]; then
  INPUT_TOKENS=$(echo "$USAGE_LINE" | jq -r '.usage.input_tokens // null')
  OUTPUT_TOKENS=$(echo "$USAGE_LINE" | jq -r '.usage.output_tokens // null')
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
