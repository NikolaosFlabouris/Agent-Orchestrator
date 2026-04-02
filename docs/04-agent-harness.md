# Agent Harness & Tool Abstraction

## Overview

The agent harness is the container entrypoint. It manages the agent tool lifecycle (dependency install, agent invocation, result capture) while the orchestrator manages everything else (git operations, Forgejo interaction, state transitions). The harness is deliberately simple — it runs the agent and reports what happened.

## Harness Contract

### Inputs (mounted by orchestrator)

```
/task/prompt.md          ← assembled task description (includes review feedback on rework cycles)
/task/meta.json          ← structured metadata and configuration
```

### meta.json Structure

```json
{
  "issue_id": 42,
  "branch_name": "agent/issue-42-add-login-validation",
  "base_branch": "main",
  "max_runtime_minutes": 30,
  "attempt": 1,
  "role": "develop",
  "pr_number": null,
  "model": "sonnet",
  "max_turns": 100,
  "pre_agent_script": "npm ci",
  "agent_tool": "claude-agent-sdk",
  "agent_command": ""
}
```

The `agent_tool` field determines which harness path runs. The `agent_command` field is only used for CLI-type tools (e.g., OpenCode).

### Outputs (written by harness)

```
/output/result.json      ← structured outcome (always present after exit)
/output/progress.log     ← newline-delimited progress events (see below)
/output/review.json      ← structured review verdict (review role only)
```

### progress.log Format

Each line is a JSON object emitted by the agent tool during execution. The shape varies by tool — the SDK harness writes Agent SDK message objects, the CLI harness writes the tool's stream-json output. The orchestrator and UI treat these as **opaque text lines**:

- The WebSocket agent output stream (`/ws/tasks/:id/output`) sends each line as-is
- The UI's agent output panel displays lines in a terminal-like scrolling view
- No parsing of the internal structure is required by the frontend or orchestrator
- Lines may contain assistant messages, tool calls, tool results, and system events depending on the agent tool

If the UI later wants to extract structured data (e.g., highlight which file the agent is editing), that can be added as a future enhancement by parsing known message types from the SDK format.

### result.json Structure

```json
{
  "status": "success | failure | timeout",
  "exit_code": 0,
  "error_message": null,
  "usage": {
    "input_tokens": 125000,
    "output_tokens": 8500,
    "model": "claude-sonnet-4-20250514"
  }
}
```

The harness always exits with code 0. The `result.json` file carries the real status. This ensures the orchestrator has exactly one code path for reading results.

The `error_message` field is null on success and populated on failure/timeout with a diagnostic string. The SDK harness captures the caught exception message. The CLI harness captures the last 5 lines of stderr. This gives the orchestrator a meaningful error message for issue comments and log entries.

The `usage` field captures token consumption for the agent session. The SDK harness extracts this from the Agent SDK's response messages. The CLI harness parses it from the tool's stream-json output (Claude Code) or omits it if the tool doesn't report usage (OpenCode with local LLMs). The orchestrator reads these values and stores them per attempt for cost tracking.

For review agents, the additional `/output/review.json`:

```json
{
  "verdict": "approved | changes_needed | unclear",
  "summary": "Brief overall assessment",
  "feedback": [
    {
      "file": "src/auth/login.ts",
      "line": 42,
      "comment": "Description of issue"
    }
  ]
}
```

## Agent Tool Abstraction

The orchestrator supports multiple agent tools through a pluggable configuration. Each tool is either an **SDK type** (invoked programmatically via TypeScript) or a **CLI type** (invoked as a shell command).

Tool configuration is stored in the `agent_tools` table (see [08 - Technology Stack](./08-technology-stack.md) for the full schema). Each tool has a type (`sdk` or `cli`), a command template (CLI only), static environment variables, and authentication configuration.

**Authentication types:**

| `auth_type` | Behaviour | When to use |
|---|---|---|
| `api-key` | The orchestrator reads the env var named in `auth_config.env_var` from `process.env` and injects it into the container. | Remote LLM APIs (Anthropic, OpenAI-compatible). |
| `none` | No credentials injected. `auth_config` is ignored. | Local LLM servers with no authentication, or the mock agent in tests. |

When `auth_type` is `api-key` and `auth_config.optional` is `true`, a missing env var is silently skipped rather than logged as a warning. This supports tools where the API key is only required in some deployments (e.g., local LLM servers that may or may not require a key).

### Supported Agent Tools

#### Claude Agent SDK (Recommended)

- **Type:** `sdk`
- **Authentication:** Anthropic API key (`ANTHROPIC_API_KEY`)
- **Cost model:** Pay-per-token via Anthropic API
- **Invocation:** TypeScript SDK, programmatic streaming

```json
{
  "id": "claude-agent-sdk",
  "display_name": "Claude Agent SDK",
  "type": "sdk",
  "command_template": null,
  "env_vars": {},
  "auth_type": "api-key",
  "auth_config": {
    "env_var": "ANTHROPIC_API_KEY"
  }
}
```

The Claude Agent SDK provides the same tools, agent loop, and context management that power Claude Code. It is available as both Python and TypeScript packages. The orchestrator uses the TypeScript SDK directly since the harness and orchestrator share the same language.

Key SDK capabilities used:
- `query()` function with async iterator for streaming
- `allowedTools` for scoping agent capabilities (Read, Edit, Bash, Glob, Grep)
- `permissionMode: "bypassPermissions"` for autonomous operation
- `model` selection per invocation (sonnet, opus, haiku)
- `maxTurns` to bound agent execution length
- Structured message objects for progress tracking

**Why API key over subscription:** The Agent SDK only supports API key authentication. Subscription (Max plan) billing is not available for programmatic SDK calls. API key billing also provides better cost attribution per task, hard spending caps via the Anthropic Console, and no rate limit quota sharing with interactive usage.

#### Claude Code CLI

- **Type:** `cli`
- **Authentication:** Anthropic API key (`ANTHROPIC_API_KEY`)
- **Cost model:** Pay-per-token via Anthropic API
- **Invocation:** Shell command with `--bare -p` flags

```json
{
  "id": "claude-code-cli",
  "display_name": "Claude Code CLI",
  "type": "cli",
  "command_template": "claude --bare --dangerously-skip-permissions --print --output-format stream-json -p \"${TASK_PROMPT}\"",
  "env_vars": {},
  "auth_type": "api-key",
  "auth_config": {
    "env_var": "ANTHROPIC_API_KEY"
  }
}
```

The `--bare` flag is important for automation: it skips OAuth, keychain reads, CLAUDE.md loading, and MCP server discovery. Authentication must come from `ANTHROPIC_API_KEY`.

#### OpenCode with Remote API

- **Type:** `cli`
- **Authentication:** Provider API key
- **Cost model:** Per-token via chosen provider
- **Invocation:** Shell command

```json
{
  "id": "opencode-anthropic",
  "display_name": "OpenCode (Anthropic API)",
  "type": "cli",
  "command_template": "opencode run --non-interactive --prompt \"${TASK_PROMPT}\"",
  "env_vars": {
    "OPENCODE_PROVIDER": "anthropic",
    "OPENCODE_MODEL": "claude-sonnet-4-20250514"
  },
  "auth_type": "api-key",
  "auth_config": {
    "env_var": "ANTHROPIC_API_KEY"
  }
}
```

#### OpenCode with Locally Hosted LLM

- **Type:** `cli`
- **Authentication:** None (local model), or API key if the local server requires one
- **Cost model:** Infrastructure cost only (self-hosted)
- **Invocation:** Shell command pointing to local OpenAI-compatible API

```json
{
  "id": "opencode-local",
  "display_name": "OpenCode (Local LLM)",
  "type": "cli",
  "command_template": "opencode run --non-interactive --prompt \"${TASK_PROMPT}\"",
  "env_vars": {
    "OPENCODE_PROVIDER": "openai-compatible",
    "OPENCODE_MODEL": "codestral-latest",
    "OPENCODE_BASE_URL": "http://192.168.1.50:8080/v1"
  },
  "auth_type": "api-key",
  "auth_config": {
    "env_var": "OPENCODE_API_KEY",
    "optional": true
  }
}
```

**Local LLM networking considerations:**

When the LLM server runs on a different machine from the dev containers, the `OPENCODE_BASE_URL` must be reachable from inside the agent container. Agent containers use a standard Docker bridge network with full outbound access, so the LLM server is reachable as long as it's on the LAN or internet.

The `OPENCODE_BASE_URL` should use the LLM server's LAN IP or hostname, not `localhost` (which would refer to the container itself). If the LLM server requires an API key, set `OPENCODE_API_KEY` in the auth config. If it's unauthenticated (common for local LLM servers), mark the auth as optional.

**Supported local LLM servers:** Any server exposing an OpenAI-compatible API endpoint works, including:
- Ollama (`http://host:11434/v1`)
- vLLM (`http://host:8000/v1`)
- llama.cpp server (`http://host:8080/v1`)
- LocalAI (`http://host:8080/v1`)
- LM Studio (`http://host:1234/v1`)

### Tool Selection

Each repository has a default agent tool configured in the `repos` table. Individual tasks can override this default via the `tasks.agent_tool` column (set at task creation time in the UI).

**Resolution order:**
```
effective_tool = task.agent_tool OR repo.agent_tool
```

If the task has an `agent_tool` value, it takes precedence. If null, the repo's default is used. This resolution is applied everywhere the tool is needed: container entrypoint selection, credential injection, and meta.json assembly.

**Example:** a repo defaults to `claude-agent-sdk` (Sonnet), but a complex architectural task is overridden to use `claude-agent-sdk` with `model: opus` for higher quality, while a trivial docs fix might use `opencode-local` to save API costs.

Note: the `image_type` (node, python, go) always comes from the repo configuration — it describes the language runtime and is not task-specific. The agent tool describes which LLM to use, which is independent of the language runtime.

## Harness Implementation

### SDK Harness (TypeScript)

Used for `sdk` type tools (Claude Agent SDK):

```typescript
// harness/harness-sdk.ts
import { query, ClaudeAgentOptions } from '@anthropic-ai/agent-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const meta = JSON.parse(readFileSync('/task/meta.json', 'utf-8'));
// prompt.md is the complete prompt — including review feedback on rework cycles.
// The orchestrator assembles the full prompt before the container starts.
const prompt = readFileSync('/task/prompt.md', 'utf-8');

// Run pre-agent script (dependency install) with file lock on shared cache volume.
// The lock prevents two containers on the same repo from running npm ci / pip install
// simultaneously against the shared dependency cache mount.
if (meta.pre_agent_script) {
  try {
    execSync(
      `flock -w 300 /cache/.dep-install-lock ${meta.pre_agent_script}`,
      { cwd: '/repo', stdio: 'inherit' }
    );
  } catch (e) {
    writeFileSync('/output/result.json', JSON.stringify({
      status: 'failure',
      exit_code: 1,
      error_message: 'Pre-agent script failed: ' + (e.message || String(e))
    }));
    process.exit(0);
  }
}

async function main() {
  const result = { status: 'success', exit_code: 0, error_message: null, usage: null };
  const usage = { input_tokens: 0, output_tokens: 0, model: meta.model || 'sonnet' };
  const timeoutMs = meta.max_runtime_minutes * 60 * 1000;
  const timer = setTimeout(() => {
    result.status = 'timeout';
    result.exit_code = 124;
    result.error_message = 'Agent exceeded timeout of ' + meta.max_runtime_minutes + ' minutes';
    result.usage = usage;
    writeFileSync('/output/result.json', JSON.stringify(result));
    process.exit(0);
  }, timeoutMs);

  try {
    for await (const message of query({
      prompt: prompt,
      options: {
        allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        model: meta.model || 'sonnet',
        maxTurns: meta.max_turns || 100,
      }
    })) {
      // Accumulate token usage from each message
      if (message.usage) {
        usage.input_tokens += message.usage.input_tokens || 0;
        usage.output_tokens += message.usage.output_tokens || 0;
      }
      writeFileSync('/output/progress.log',
        JSON.stringify(message) + '\n',
        { flag: 'a' }
      );
    }
  } catch (error) {
    result.status = 'failure';
    result.exit_code = 1;
    result.error_message = error.message || String(error);
  }

  clearTimeout(timer);
  result.usage = usage;

  // For review agents, verify review.json was produced
  if (meta.role === 'review') {
    try {
      const review = JSON.parse(readFileSync('/output/review.json', 'utf-8'));
      if (!review.verdict) throw new Error('No verdict');
    } catch {
      result.status = 'failure';
    }
  }

  writeFileSync('/output/result.json', JSON.stringify(result));
}

main();
```

### CLI Harness (Bash)

Used for `cli` type tools (OpenCode, Claude Code CLI):

```bash
#!/bin/bash
set -euo pipefail

OUTPUT_DIR="/output"
AGENT_LOG="$OUTPUT_DIR/agent.log"
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

# Substitute prompt into command template
TASK_PROMPT=$(cat "$PROMPT")
export TASK_PROMPT
RESOLVED_COMMAND=$(envsubst '${TASK_PROMPT}' <<< "$AGENT_COMMAND")

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
```

### Entrypoint Selection

The container entrypoint is set by the orchestrator at container creation time based on the resolved tool type. See [03 - Agent Containers](./03-agent-containers.md) for the `createAgentContainer` code.

## Prompt Assembly

The orchestrator constructs task prompts from Forgejo issue content. Templates are stored in the orchestrator codebase and can be iterated on.

### Code Quality Enforcement

There is no server-side CI/CD pipeline. Code quality checks (linting, formatting, type checking, tests) are enforced through pre-commit hooks and checklists configured in individual repositories. Agents encounter these checks as part of the normal `git commit` workflow:

- **Pre-commit hooks** (via tools like husky, lefthook, or pre-commit): run linters, formatters, and type checkers automatically when the agent commits. If the hook fails, the commit is rejected and the agent must fix the issue.
- **Repository-level checklists** (e.g., a `CONTRIBUTING.md` or `.claude/CLAUDE.md`): guide agents through manual verification steps (run tests, check build output, etc.).
- **Test suites**: the dev agent prompt instructs agents to run existing tests. The review agent prompt instructs the reviewer to run the test suite as part of evaluation.

This approach keeps quality enforcement close to the code (each repo defines its own standards) and avoids the complexity of a centralized CI system. Repos that need strict enforcement use pre-commit hooks that block bad commits. Repos with lighter requirements rely on the review agent to catch issues.

### Dev Agent Prompt Template

```markdown
## Task

{issue_body}

## Context

- Repository: {owner}/{name}
- Branch: {branch_name}
- Base branch: {base_branch}
- Working directory: /repo

## Instructions

1. Fetch the latest base branch and rebase your work onto it:
   git fetch origin {base_branch}
   git rebase origin/{base_branch}
   If there are conflicts, resolve them before proceeding.
2. Read and understand the task above
3. Explore the relevant codebase to understand existing patterns
4. Implement the changes described in the task
5. Run any existing tests to verify your changes don't break anything
6. Ensure your changes are complete and ready for review
7. Commit your changes and push:
   git add -A
   git commit -m "feat: <concise description>"
   git push origin {branch_name}
   If pre-commit hooks fail, fix the issues and commit again.
   Do not skip or bypass pre-commit hooks.

## Constraints

- Follow the existing code style and conventions in the repo
- Do not modify files unrelated to the task
- If the task is unclear, make reasonable assumptions and document them
- Always push your work before exiting
- If the repo has pre-commit hooks, all hooks must pass before pushing

## Review Feedback (Attempt N)
(Only included on rework cycles)

{review_feedback}

Address all feedback items while preserving the working parts of the implementation.
```

### Review Agent Prompt Template

```markdown
## Review Task

Review the changes on the current branch against the base branch ({base_branch}).

## Original Task Description

{issue_body}

## Instructions

1. Fetch the latest base branch to ensure an up-to-date comparison:
   git fetch origin {base_branch}
2. Run: git diff origin/{base_branch}...HEAD to see all changes
3. Run: git diff origin/{base_branch}...HEAD --name-only for a summary of affected files
4. Read and understand every changed file
5. Run the test suite if one exists
6. Evaluate against the task requirements
7. Check for bugs, security issues, and code quality problems

## Output

Create a file at /output/review.json with this exact structure:

{
  "verdict": "approved" or "changes_needed",
  "summary": "Brief overall assessment in 1-2 sentences",
  "feedback": [
    {"file": "path/to/file.ts", "line": 42, "comment": "description of issue"}
  ]
}

Set verdict to "approved" only if:
- All task requirements are met
- Tests pass (or no test suite exists)
- No bugs or security issues found
- Code quality is acceptable

Set verdict to "changes_needed" if any concrete issues exist.
Include specific, actionable feedback for every issue found.
```

## Completion Detection

The orchestrator detects agent completion through three redundant signals:

1. **Docker container exits** — `container.wait()` returns. Primary signal, 100% reliable.
2. **Progress event** — the final message appears in `/output/progress.log`. Arrives slightly before container fully exits.
3. **Timeout fallback** — if the container hasn't exited within `max_runtime_minutes + 5 minutes` (grace period), the orchestrator kills it and reads whatever partial result exists.

The harness always exits with code 0 and always writes `result.json`, ensuring the orchestrator has exactly one code path for reading results regardless of what happened inside.
