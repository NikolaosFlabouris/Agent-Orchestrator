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
# Lock-acquisition wait. Sized for the slowest realistic cold-cache install
# holding the lock (multi-step npm ci + go mod download + tool provisioning
# can run 10-15 minutes); containers that arrive second queue behind it
# instead of being failed for merely waiting their turn. Keep in sync with
# harness-sdk.ts. Total wall clock is still bounded by the orchestrator's
# runtime timeout sweep.
INSTALL_LOCK_WAIT=1800
INSTALL_COUNT=$(jq -r '.install_commands | length' "$META")
if [ "$INSTALL_COUNT" -gt 0 ]; then
  (
    flock -w "$INSTALL_LOCK_WAIT" 200 || {
      echo "[harness] Timed out after ${INSTALL_LOCK_WAIT}s waiting for the shared install lock ($LOCKFILE) — another container on this repo held it for the whole window." >> "$AGENT_LOG"
      exit 1
    }
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

# Fallback wait between usage-limit retries. The harness prefers the reset time
# the CLI states in its limit message (parsed by parse_reset_epoch below) and
# sleeps until then + a small buffer; this fixed poll is the fallback used only
# when that message can't be parsed or the parsed time is nonsensical. Blind
# polling was the old default — in production it cost 17 futile relaunches over
# a ~3h reset window — so it survives only as the safe fallback. The env
# override exists for tests; production containers don't set it.
USAGE_RETRY_INTERVAL="${HARNESS_USAGE_RETRY_SECONDS:-600}"

# Buffer added on top of the parsed reset instant so the fresh agent starts
# comfortably AFTER the window has actually reset, never a hair before it.
USAGE_RESET_BUFFER=60

# Timestamped harness marker appended to the same progress.log the UI
# live-streams — this is how operators see "waiting on a usage limit" on the
# task page while the task itself stays in-progress.
marker() {
  echo "[harness $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$AGENT_LOG"
}

# Select the agent CLI's stream-json result events from a log stream on stdin,
# emitting one compact JSON object per matching line (so `tail -1` still yields
# the newest event and `jq -s` can slurp them all).
#
# Order-agnostic BY DESIGN, and parsed rather than substring-matched. This was
# `grep '^{"type":"result"'` until 2026-08-04, when Claude Code 2.1.221
# reordered the keys of its final event: the line now starts
# `{"is_error":true,...}` with `"type":"result"` near the END of the object, so
# the start-anchored match found nothing. Usage-limit 429s were reported as hard
# failures (tasks burned every attempt in minutes), result.json carried a raw log
# tail, and the usage columns stayed NULL. Testing the top-level `.type` of each
# parsed line survives any future key reordering — and, unlike an unanchored
# substring grep, does not match an assistant message that merely QUOTES
# `"type":"result"` inside its text. Never fails the caller: unparseable lines
# are skipped and any jq error collapses to empty output.
result_events() {
  jq -cR 'fromjson? | select(type == "object" and .type == "result")' 2>/dev/null || true
}

# Usage-limit detector — deliberately Claude Code-specific for now (other
# CLIs' phrasings get added as they are observed in the wild). A false
# positive here parks the task until the deadline, so the patterns stay
# narrow. Input: the CURRENT run's final stream-json result event. Matches:
#   - api_error_status 429 (Anthropic API rate/usage limit), or
#   - "usage limit" / "session limit" in the result text. Subscription limits
#     surface as either "Claude AI usage limit reached|<reset-epoch>" (older)
#     or "You've hit your session limit · resets 2am (UTC)" (observed in
#     production) — the latter only classified before because it also carried a
#     429, so both phrasings are matched here to close that gap.
is_usage_limit_result() {
  [ -n "$1" ] || return 1
  printf '%s' "$1" | jq -e '
    (.is_error == true) and (
      ((.api_error_status // 0) == 429)
      or ((.api_error_status // "") == "429")
      or ((.result // "") | test("session limit|usage limit"; "i"))
    )
  ' > /dev/null 2>&1
}

# Parse the usage-limit reset time from the agent's result text, printing it as
# a unix epoch on stdout (nothing, exit 1, when no supported phrasing is
# found). Containers run in UTC, so no timezone juggling is needed. Handles:
#   1. "Claude AI usage limit reached|<unix-epoch>" — the epoch IS the reset.
#   2. "...resets 2am (UTC)" — wall-clock UTC. GNU `date -d "2am"` yields
#      TODAY's 2am, which may already be in the past, so roll forward one day
#      when the parsed instant is not in the future.
#   3. "...resets in 3 hours" / "in 45 minutes" — a relative offset from now.
# Callers sanity-clamp the result (see compute_usage_wait), so a wild parse
# here can never park the container until its deadline.
parse_reset_epoch() {
  local text="$1" now match epoch n unit
  now=$(date +%s)

  # Format 1: explicit epoch after a pipe.
  match=$(printf '%s' "$text" | grep -oiE 'reached\|[0-9]+' | grep -oE '[0-9]+' | head -1)
  if [ -n "$match" ]; then
    printf '%s\n' "$match"
    return 0
  fi

  # Format 3: "resets in N hour(s)/minute(s)".
  match=$(printf '%s' "$text" | grep -oiE 'resets in [0-9]+ (hour|minute)' | head -1)
  if [ -n "$match" ]; then
    n=$(printf '%s' "$match" | grep -oE '[0-9]+')
    unit=$(printf '%s' "$match" | grep -oiE '(hour|minute)')
    epoch=$(date -d "$n $unit" +%s 2>/dev/null || true)
    if [ -n "$epoch" ]; then printf '%s\n' "$epoch"; return 0; fi
  fi

  # Format 2: "resets [at] 2am / 11:30pm (UTC)".
  match=$(printf '%s' "$text" \
    | grep -oiE 'resets (at )?[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm)' \
    | grep -oiE '[0-9]{1,2}(:[0-9]{2})?[[:space:]]*(am|pm)' | head -1)
  if [ -n "$match" ]; then
    epoch=$(date -u -d "$match" +%s 2>/dev/null || true)
    if [ -n "$epoch" ]; then
      # date -d "2am" resolves to TODAY's 2am; roll to tomorrow when it has
      # already passed. UTC has no DST, so +86400s is exactly the next day.
      if [ "$epoch" -le "$now" ]; then
        epoch=$(( epoch + 86400 ))
      fi
      printf '%s\n' "$epoch"
      return 0
    fi
  fi

  return 1
}

# Format a whole number of seconds as a compact human duration: "3h11m",
# "10m", or "45s". Used only for the progress.log marker lines.
fmt_duration() {
  local s=$1 h m
  h=$(( s / 3600 ))
  m=$(( (s % 3600) / 60 ))
  if [ "$h" -gt 0 ]; then
    printf '%dh%dm' "$h" "$m"
  elif [ "$m" -gt 0 ]; then
    printf '%dm' "$m"
  else
    printf '%ds' "$s"
  fi
}

# Decide how long to wait before relaunching, given the current run's result
# text. Sets two globals: USAGE_WAIT_SECONDS (the sleep) and USAGE_WAIT_REASON
# (a human clause for the marker line). Prefers the reset time stated in the
# message (parse_reset_epoch); falls back to the fixed USAGE_RETRY_INTERVAL
# poll when no time is parseable OR the parsed wait is nonsensical — a reset
# well in the past (>5m) or absurdly far ahead (>12h) means a mis-parse, and a
# fallback poll is always safer than parking the container for hours on a bad
# read. The +USAGE_RESET_BUFFER lands the fresh agent just after the reset; a
# 60s floor guards against a zero/negative sleep.
compute_usage_wait() {
  local text="$1" reset now wait
  reset=$(parse_reset_epoch "$text" || true)
  if [ -n "$reset" ]; then
    now=$(date +%s)
    if [ "$reset" -ge $(( now - 300 )) ] && [ "$reset" -le $(( now + 12 * 3600 )) ]; then
      wait=$(( reset - now + USAGE_RESET_BUFFER ))
      [ "$wait" -lt 60 ] && wait=60
      USAGE_WAIT_SECONDS=$wait
      USAGE_WAIT_REASON="usage limit resets at $(date -u -d "@$reset" +%H:%M) UTC — waiting $(fmt_duration "$wait") (includes ${USAGE_RESET_BUFFER}s buffer)"
      return 0
    fi
  fi
  USAGE_WAIT_SECONDS=$USAGE_RETRY_INTERVAL
  USAGE_WAIT_REASON="reset time not parseable — waiting $(fmt_duration "$USAGE_RETRY_INTERVAL") (fixed poll)"
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
    | result_events | tail -1 || true)

  if ! is_usage_limit_result "$RUN_RESULT_LINE"; then
    break # real failure → the orchestrator's retry/attempt path owns it
  fi

  # Decide how long to wait: reset-aware if the limit message states a reset
  # time, otherwise the fixed poll. Logged before the give-up check so
  # progress.log records why the harness chose its wait even when it then
  # decides the budget is too tight to follow through.
  RUN_RESULT_TEXT=$(printf '%s' "$RUN_RESULT_LINE" | jq -r '.result // empty' 2>/dev/null || true)
  compute_usage_wait "$RUN_RESULT_TEXT"
  marker "Provider usage limit detected (agent exit ${AGENT_EXIT}) — ${USAGE_WAIT_REASON}."

  # Don't start a wait that can't be followed by a meaningful run (60s floor).
  if [ $(( $(date +%s) + USAGE_WAIT_SECONDS + 60 )) -ge "$DEADLINE" ]; then
    marker "Usage limit still active with the runtime budget nearly exhausted — reporting failure to the orchestrator."
    break
  fi

  USAGE_RETRIES=$(( USAGE_RETRIES + 1 ))
  checkpoint_workspace
  append_prompt_note
  marker "Waiting before relaunching a fresh agent (usage-limit retry ${USAGE_RETRIES}). Workspace is preserved; the task stays in progress."
  sleep "$USAGE_WAIT_SECONDS"
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
  RESULT_LINE=$(result_events < "$AGENT_LOG" 2>/dev/null | tail -1 || true)
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
USAGE_JSON=$(result_events < "$AGENT_LOG" 2>/dev/null | jq -cs '
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
