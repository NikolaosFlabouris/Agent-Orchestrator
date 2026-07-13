#!/bin/bash
set -euo pipefail

OUTPUT_DIR="/output"
AGENT_LOG="$OUTPUT_DIR/progress.log"
RESULT="$OUTPUT_DIR/result.json"
TASK_DIR="/task"
META="$TASK_DIR/meta.json"
PROMPT_FILE="$TASK_DIR/prompt.md"

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

# ---- Usage-limit retry loop -------------------------------------------------
#
# When the agent CLI dies because the provider's usage limit is exhausted,
# exiting the container would hand the orchestrator a failure it can only
# handle by burning a task attempt on an error no retry fixes until the limit
# window resets — the observed result was tasks churning through max_attempts
# in minutes. Instead the container stays up: wait a fixed interval, then
# relaunch a FRESH agent against the intact workspace (no session resume —
# resume flags are vendor-specific; files, commits, and the branch are the
# durable state a new run reorients from). The orchestrator sees a container
# that is still running, so the task stays in-progress and no attempt is
# consumed. The wall-clock deadline below (and the orchestrator's own timeout
# sweep as backstop) bounds the worst case.

# Single deadline for EVERYTHING this container does — agent runs, usage-limit
# waits, retries. Replaces the old single-run `timeout ${MAX_MINUTES}m` budget.
DEADLINE=$(( $(date +%s) + MAX_MINUTES * 60 ))

# Fixed wait between usage-limit retries. Deliberately a dumb poll rather than
# parsing the CLI's "resets at ..." phrasing: the phrasing varies across
# Claude Code versions, while a failed probe costs seconds and ~no tokens.
# The env override exists for tests; production containers don't set it.
USAGE_RETRY_INTERVAL="${HARNESS_USAGE_RETRY_SECONDS:-600}"

# Timestamped harness marker appended to the same progress.log the UI
# live-streams — this is how operators see "waiting on a usage limit" on the
# task page while the task itself stays in-progress.
marker() {
  echo "[harness $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$AGENT_LOG"
}

# Usage-limit detector — deliberately Claude Code-specific for now (other
# CLIs' phrasings get added as they are observed in the wild). A false
# positive here parks the task until the deadline, so the patterns stay
# narrow. Input: the CURRENT run's final stream-json result event. Matches:
#   - api_error_status 429 (Anthropic API rate/usage limit), or
#   - "usage limit" in the result text (subscription limits surface as e.g.
#     "Claude AI usage limit reached|<reset-epoch>").
is_usage_limit_result() {
  [ -n "$1" ] || return 1
  printf '%s' "$1" | jq -e '
    (.is_error == true) and (
      ((.api_error_status // 0) == 429)
      or ((.api_error_status // "") == "429")
      or ((.result // "") | test("usage limit"; "i"))
    )
  ' > /dev/null 2>&1
}

# Before sleeping, commit any uncommitted work as a WIP checkpoint. Two
# purposes: the fresh agent that retries cannot destroy in-flight work with a
# checkout/reset, and the work is visible in `git log` where the next run will
# find it. Inline -c identity because nothing configures user.email/user.name
# in the workspace (the same gap the orchestrator's salvage path documents).
# Dev runs only — review runs don't mutate the workspace.
checkpoint_workspace() {
  if [ "$ROLE" != "develop" ]; then return 0; fi
  if [ -z "$(git -C /repo status --porcelain 2>/dev/null || true)" ]; then return 0; fi
  git -C /repo add -A >> "$AGENT_LOG" 2>&1 || true
  if git -C /repo \
      -c user.email=harness@orchestrator.local \
      -c user.name='Orchestrator Harness' \
      commit -m "WIP: auto-checkpoint before usage-limit retry ${USAGE_RETRIES}" \
      >> "$AGENT_LOG" 2>&1; then
    marker "Uncommitted work saved as a WIP checkpoint commit."
  fi
}

# One-time note appended to the prompt so the next (fresh, context-free) agent
# reliably discovers the partial work instead of restarting it — weak models
# don't dependably run git log/status unprompted. /task is mounted read-write
# and the orchestrator chowns prompt.md to the agent user (uid 1000) so this
# append succeeds; it also reassembles prompt.md from scratch at every
# container launch, so the note never leaks across attempts.
PROMPT_NOTE_MARKER='<!-- harness:usage-limit-interruption-note -->'
append_prompt_note() {
  if [ "$ROLE" != "develop" ]; then return 0; fi
  if grep -qF "$PROMPT_NOTE_MARKER" "$PROMPT_FILE" 2>/dev/null; then return 0; fi
  {
    printf '\n%s\n\n' "$PROMPT_NOTE_MARKER"
    cat <<'NOTE'
## Interrupted Earlier Run

A previous agent run on this task was interrupted by a provider usage
limit. Partial work may already exist as uncommitted changes and/or
"WIP: auto-checkpoint" commits on this branch. Before starting, run
`git log` and `git status` to see what is already done, then CONTINUE
that work — do not discard, revert, or restart it.
NOTE
  } >> "$PROMPT_FILE" 2>/dev/null \
    || marker "Could not append interruption note to prompt.md (check /task/prompt.md ownership/permissions)."
}

# progress.log is truncated once per container (the output dir persists across
# task attempts and each attempt's log stands alone) and appended to from then
# on: the UI's log watcher streams by size delta, so in-loop truncation would
# silently drop output. Appending also preserves every run's output for the
# operator and for the usage summing below.
: > "$AGENT_LOG"

USAGE_RETRIES=0
AGENT_EXIT=0

while :; do
  BUDGET=$(( DEADLINE - $(date +%s) ))
  if [ "$BUDGET" -le 0 ]; then
    # Only reachable after at least one retry cycle — treat as a timeout so
    # the orchestrator's salvage path handles whatever work exists.
    AGENT_EXIT=124
    break
  fi

  # Byte offset where this run's output starts — classification below must
  # only see the CURRENT run's output, or a stale usage-limit line from an
  # earlier run could keep a genuinely-broken task looping to the deadline.
  RUN_START_BYTES=$(stat -c %s "$AGENT_LOG" 2>/dev/null || echo 0)

  AGENT_EXIT=0
  timeout --foreground --kill-after=30s "${BUDGET}s" \
    bash -c "$AGENT_COMMAND" \
    >> "$AGENT_LOG" 2>&1 \
    || AGENT_EXIT=$?

  # Kill orphaned processes from this run
  pkill -P $$ 2>/dev/null || true

  if [ "$AGENT_EXIT" -eq 0 ] || [ "$AGENT_EXIT" -eq 124 ]; then
    break # success or wall-clock timeout → normal handling below
  fi

  RUN_RESULT_LINE=$(tail -c +$(( RUN_START_BYTES + 1 )) "$AGENT_LOG" 2>/dev/null \
    | grep -a '^{"type":"result"' | tail -1 || true)

  if ! is_usage_limit_result "$RUN_RESULT_LINE"; then
    break # real failure → the orchestrator's retry/attempt path owns it
  fi

  # Don't start a wait that can't be followed by a meaningful run (60s floor).
  if [ $(( $(date +%s) + USAGE_RETRY_INTERVAL + 60 )) -ge "$DEADLINE" ]; then
    marker "Usage limit still active with the runtime budget nearly exhausted — reporting failure to the orchestrator."
    break
  fi

  USAGE_RETRIES=$(( USAGE_RETRIES + 1 ))
  checkpoint_workspace
  append_prompt_note
  marker "Provider usage limit detected (agent exit ${AGENT_EXIT}). Waiting $(( USAGE_RETRY_INTERVAL / 60 ))m, then relaunching a fresh agent (usage-limit retry ${USAGE_RETRIES}). Workspace is preserved; the task stays in progress."
  sleep "$USAGE_RETRY_INTERVAL"
  marker "Usage-limit wait over — relaunching agent (usage-limit retry ${USAGE_RETRIES})."
done

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
  # line crowds out the actual failure. The last result line in the log
  # belongs to the final run, so retries don't distort this.
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
# with input/output token counts. Usage-limit retries append one result event
# per run to the log, so sum each field across every event that carries it —
# a single-run log degenerates to the old behaviour. Tools that don't emit
# stream-json (OpenCode's text logs, etc.) leave the block out and the
# orchestrator keeps the attempt's usage columns NULL. Raw counts only — no
# dollar cost is computed. Never fails the run: any jq error or missing field
# collapses to an empty USAGE_FIELD.
USAGE_FIELD=""
USAGE_JSON=$(grep -a '^{"type":"result"' "$AGENT_LOG" 2>/dev/null | jq -cs '
  {}
  + ([ .[] | .num_turns? | numbers ]           | if length > 0 then { num_turns: add } else {} end)
  + ([ .[] | .usage.input_tokens? | numbers ]  | if length > 0 then { input_tokens: add } else {} end)
  + ([ .[] | .usage.output_tokens? | numbers ] | if length > 0 then { output_tokens: add } else {} end)
' 2>/dev/null || true)
if [ -n "$USAGE_JSON" ] && [ "$USAGE_JSON" != "{}" ]; then
  USAGE_FIELD=",
  \"usage\": $USAGE_JSON"
fi

cat > "$RESULT" <<EOF
{
  "status": "$STATUS",
  "exit_code": $AGENT_EXIT,
  "error_message": $ERROR_MSG$USAGE_FIELD
}
EOF
