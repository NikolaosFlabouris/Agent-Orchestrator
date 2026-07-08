# Agent Harness, Profiles, Providers & Models

## Overview

An **agent profile** is the operator-composed pairing that a task references. It names a code-defined **harness** (one of `claude-sdk`, `claude-code`, `opencode`, `pi`), a **model** scoped to a **provider** (anthropic / openai / ollama / …), a `config_json` blob the harness understands, and a wall-clock `timeout_minutes`. The orchestrator resolves `task → profile → model → provider` at launch time, asks the harness module to build a launch invocation from that tuple, and writes a meta.json into the agent container.

The **harness** itself is the container entrypoint. It manages dependency install, agent invocation, and result capture; the orchestrator manages everything else (git operations, Forgejo interaction, state transitions). The harness is deliberately simple — it runs the agent and reports what happened.

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
  "max_runtime_minutes": 120,
  "attempt": 1,
  "role": "develop",
  "pr_number": null,
  "model": "claude-sonnet-4-6",
  "harness_id": "claude-sdk",
  "agent_profile_id": "default-claude-sdk",
  "install_commands": [
    { "command": "pnpm install", "cwd": "/repo" },
    { "command": "pip install -r requirements.txt", "cwd": "/repo/services/api" }
  ],
  "agent_command": ""
}
```

`harness_id` and `agent_profile_id` snapshot the resolved profile at
attempt-launch time so audit trails survive subsequent edits to the
profile or its model row. The same values are stored on the `attempts`
row (`attempts.harness_id`, `attempts.model_id`).

`model` is the harness's `resolved_model` — typically `model.model_id`
verbatim, or `<provider.kind>/<model.model_id>` for harnesses (pi,
OpenCode) whose binaries expect a prefix. The harness owns the convention.
For SDK harnesses the in-container script reads this field to drive the
SDK call; for CLI harnesses the model is already baked into
`agent_command` and the field is audit-only.

`install_commands` is the orchestrator's resolved view of the repo's
typed `install_steps`. Each entry is a literal command + working
directory; the harness runs them sequentially under a single `flock`
against `/cache`. The operator never sees this shape directly — the UI
edits the typed `install_steps` (kind + optional cwd) and the
orchestrator translates each `kind` to a hardcoded command at task
launch. The only operator-controlled strings are the `cwd` and (when the
repo's `allow_script_steps` is enabled) the `path` of a `script` step,
both validated server-side as relative paths without `..`.

`agent_command` is populated for CLI harnesses (`claude-code`, `opencode`,
`pi`) and empty for SDK harnesses (`claude-sdk`). Each harness module
builds the command itself from the resolved (profile, model, provider)
tuple — there is no operator-authored shell template anywhere in the
system. Adding a new harness or changing how an existing one launches
its binary is a code change in `packages/server/src/harnesses/<id>.ts`.

### Prompt handling

The task prompt is written to `/task/prompt.md` before the container
starts. Each harness module references that path directly when it builds
its `agent_command`:

```
# claude-code: stdin redirection
claude --print --dangerously-skip-permissions < /task/prompt.md

# pi: @file inclusion
pi -p --no-session @/task/prompt.md

# opencode: command-substitution as a single literal argument
opencode run "$(cat /task/prompt.md)"
```

Prompt content never reaches the shell as code, so metacharacters
(backticks, `$()`, unbalanced quotes) in issue bodies stay inert. There
is no operator-authored placeholder substitution any more — harnesses
hand the orchestrator a fully-formed `agent_command` string.

### Outputs (written by harness)

```
/output/result.json      ← structured outcome (always present after exit)
/output/progress.log     ← newline-delimited progress events (see below)
/output/review.json      ← structured review verdict (review role only)
```

### progress.log Format

Each line is a JSON object emitted by the agent during execution. The shape varies by harness — the SDK harness writes Agent SDK message objects, the CLI harnesses write whatever stream-json shape the underlying CLI produces. The CLI harness additionally appends timestamped plain-text `[harness ...]` marker lines around usage-limit retries (see below). The orchestrator and UI treat all of these as **opaque text lines**:

- The WebSocket agent output stream (`/ws/tasks/:id/output`) sends each line as-is
- The UI's agent output panel displays lines in a terminal-like scrolling view
- No parsing of the internal structure is required by the frontend or orchestrator
- Lines may contain assistant messages, tool calls, tool results, and system events depending on which harness is running

If the UI later wants to extract structured data (e.g., highlight which file the agent is editing), that can be added as a future enhancement by parsing known message types from the SDK format.

### result.json Structure

```json
{
  "status": "success | failure | timeout",
  "exit_code": 0,
  "error_message": null
}
```

The harness always exits with code 0. The `result.json` file carries the real status. This ensures the orchestrator has exactly one code path for reading results.

The `error_message` field is null on success and populated on failure/timeout with a diagnostic string. The SDK harness captures the caught exception message. The CLI harness captures the last 5 lines of stderr. This gives the orchestrator a meaningful error message for issue comments and log entries.

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

## Harnesses

Harnesses are code-defined and live under
`packages/server/src/harnesses/`. The registry in `harnesses/index.ts`
maps each `HarnessId` to a `HarnessSpec`:

```typescript
const REGISTRY: Record<HarnessId, HarnessSpec> = {
  'claude-sdk':  claudeSdkHarness,
  'claude-code': claudeCodeHarness,
  'opencode':    opencodeHarness,
  'pi':          piHarness,
};
```

A `HarnessSpec` declares:

- `id` and `display_name` for the UI dropdown.
- `runtime: 'sdk' | 'cli'` — picks the in-container entrypoint
  (`harness-sdk.ts` vs `harness-cli`).
- `supported_provider_kinds` — the provider kinds this harness can target
  (e.g. `claude-sdk` supports `anthropic` only; `opencode` supports
  every kind that OpenCode's own provider list covers).
- `buildInvocation(inputs)` — pure function that takes the resolved
  `(profile, model, provider, promptFilePath)` tuple and returns a
  `HarnessInvocation` `{ agent_command, config_files, extra_env,
  resolved_model }`. The scheduler stitches that into meta.json,
  writes any config files into `/repo/`, and exports the env vars.
- `validateConfig?(config_json)` — optional save-time well-formedness
  check on the operator-authored `agent_profiles.config_json`.

Harness↔provider compatibility is enforced at **both** save time and
launch time. The save-time check in the `/api/agent-profiles`
POST/PATCH validator rejects an incompatible pair before the profile
is persisted — the operator sees the error immediately in the
Settings UI. The launch-time check in `buildInvocation` stays as the
authoritative gate: if a profile somehow points at a provider kind
not in `supported_provider_kinds` at launch (e.g. an operator
re-pointed a model row's provider via direct DB edit), it throws with
a clear "harness X doesn't support kind Y" message and the task
fails loudly rather than silently routing to an unsupported endpoint.
Save-time runs the compatibility check **before** `validateConfig`
since the harness/provider mismatch is the categorical error.

### Shipped harnesses

| Id | Runtime | Supported provider kinds | Notes |
|---|---|---|---|
| `claude-sdk` | sdk | `anthropic` | `query()` from `@anthropic-ai/claude-agent-sdk`. Reads `meta.model` and runs the SDK call directly. The simplest, most-tested harness; the v21 bootstrap profile uses this. |
| `claude-code` | cli | `anthropic`, `claude-subscription` | Wraps the `claude` CLI with `--bare --dangerously-skip-permissions --print --verbose --output-format stream-json`. The `--bare` flag is important: it skips OAuth, keychain reads, CLAUDE.md loading, and MCP server discovery. |
| `opencode` | cli | every kind OpenCode supports (anthropic, openai, gemini, mistral, deepseek, openrouter, ollama) | Wraps `opencode run "$(cat /task/prompt.md)"`. For Ollama, the harness emits an `opencode.json` config file dropped into `/repo/` (orchestrator side) and adds it to `.git/info/exclude` so it never lands in a commit. For cloud providers, OpenCode reads provider/model from env vars the harness exports via `extra_env`. |
| `pi` | cli | every kind pi supports | `@mariozechner/pi-coding-agent`. Uses `pi -p --mode json --no-session --model <provider-prefixed-id> @/task/prompt.md`. For Ollama, pi requires a `~/.pi/agent/models.json` file outside `/repo/`; since the orchestrator can't write into the container's home from outside, the pi harness inlines a `mkdir -p ~/.pi/agent && printf ... > ~/.pi/agent/models.json && pi ...` sequence into `agent_command`. See `harnesses/pi.ts` for the worked example. |

### Adding a new harness

This is a code change, not a settings change:

1. Add the new id to the `HarnessId` union and `HARNESS_IDS` array in
   `packages/shared/src/types.ts`.
2. Create `packages/server/src/harnesses/<id>.ts` exporting a
   `HarnessSpec`. Implement `buildInvocation` (and optionally
   `validateConfig`).
3. Register it in `harnesses/index.ts`.
4. Add a matching React form component on the client (one per harness id
   under `packages/ui/src/components/harness-forms/`) so operators can
   author `config_json` for the new harness.

The orchestrator never reads operator-authored shell — every binary
invocation is constructed in `buildInvocation`, which means adding a
harness is the only way to teach the orchestrator a new way to invoke
an agent.

## Providers and models

A **provider** captures the connection identity of an LLM endpoint:
`kind` (anthropic / openai / gemini / mistral / deepseek / openrouter /
claude-subscription / ollama), `concurrency_limit`, optional `base_url`
(required for ollama, defaulted for cloud kinds), and exactly one of
`api_key_env_var` (orchestrator reads from its own env at launch) or
`auth_token` (inline plaintext, useful for multi-instance Ollama or for
multi-account setups on the same cloud kind).

Providers no longer share a global `FORWARDED_KEYS` list — each provider
row declares its own `api_key_env_var`. At launch, the scheduler
resolves the provider's credential (`auth_token` if set, otherwise
`process.env[api_key_env_var]`) and exports it into the agent container
under the kind's standard env-var name (e.g. `ANTHROPIC_API_KEY` for
`kind=anthropic`, `OPENAI_API_KEY` for `kind=openai`, …). Per-kind names
live in `packages/server/src/providers/kinds.ts`. The agent CLI/SDK reads
the standard name regardless of how the operator stored the credential.

A **model** is a `(provider_id, model_id, display_name)` triple stored
under a surrogate primary key; `agent_profiles.model_pk` references it.
The same `model_id` can exist under multiple providers (e.g.
`claude-sonnet-4-6` on Anthropic and on OpenRouter) — they're separate
rows because the launch surface differs per provider.

### Profile resolution

Each workflow stage launches the harness from the first profile in its
chain that isn't null. Implementation (develop):

```
tasks.agent_profile_id
  ↳ repos.agent_profile_id
      ↳ settings.default_agent_profile_id
```

Review walks its own tiers first and falls back to the implementation
chain, so an install with no review profiles reviews with the same
profile that implemented:

```
tasks.review_agent_profile_id
  ↳ repos.review_agent_profile_id
      ↳ settings.default_review_agent_profile_id
          ↳ <the implementation chain above>
```

The scheduler walks `profile → models[model_pk] → providers[provider_id]`,
hands the de-referenced rows to `harness.buildInvocation`, and the harness
returns the `agent_command`, any config files to drop into `/repo/`, and
the env-var extras to merge with the provider's resolved credential.

The container image is the same regardless of the profile —
`orchestrator-agent:latest` ships Node, Python, and Go toolchains plus
all four agent CLIs and the SDK. The profile only chooses which one runs
and against which model and provider.

## In-container Harness Scripts

Two scripts live under `harness/` and are baked into the
`orchestrator-agent:latest` image. The orchestrator picks one as the
container entrypoint based on `harness.runtime`:

- `harness-sdk.ts` — entrypoint for `runtime: 'sdk'` harnesses
  (`claude-sdk`). Reads `meta.json`, runs install steps, then calls the
  SDK `query()` directly using `meta.model`.
- `harness-cli.sh` — entrypoint for `runtime: 'cli'` harnesses
  (`claude-code`, `opencode`, `pi`). Reads `meta.json`, runs install
  steps, then `bash -c "$AGENT_COMMAND"` against the literal
  `meta.agent_command` produced by `harness.buildInvocation`.

### SDK Harness (TypeScript)

```typescript
// harness/harness-sdk.ts (abridged — see source for current shape)
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const meta = JSON.parse(readFileSync('/task/meta.json', 'utf-8'));
const prompt = readFileSync('/task/prompt.md', 'utf-8');

// Install steps run sequentially under a single flock against /cache.
// Each step's command + cwd is pre-resolved by the orchestrator from the
// repo's typed install_steps; the harness never sees free-text input.
for (const step of meta.install_commands ?? []) {
  execSync(
    `flock -w 300 /cache/.dep-install-lock sh -c ${JSON.stringify(step.command)}`,
    { cwd: step.cwd, stdio: 'inherit' }
  );
}

const timer = setTimeout(() => {
  writeFileSync('/output/result.json', JSON.stringify({
    status: 'timeout', exit_code: 124,
    error_message: `Agent exceeded timeout of ${meta.max_runtime_minutes} minutes`,
  }));
  process.exit(0);
}, meta.max_runtime_minutes * 60 * 1000);

for await (const message of query({
  prompt,
  options: {
    permissionMode: 'bypassPermissions',
    // No allowedTools allowlist — agent containers are ephemeral, non-root,
    // and isolated. bypassPermissions grants Read/Edit/Bash/Write/Glob/Grep
    // and friends. No maxTurns cap — the wall-clock timeout above is the
    // lifetime safety net.
    model: meta.model,
  },
})) {
  writeFileSync('/output/progress.log', JSON.stringify(message) + '\n', { flag: 'a' });
}

clearTimeout(timer);
writeFileSync('/output/result.json', JSON.stringify({
  status: 'success', exit_code: 0, error_message: null,
}));
```

### CLI Harness (Bash)

```bash
#!/bin/bash
set -euo pipefail
META="/task/meta.json"

# Install steps (same structure as the SDK harness, just bash)
INSTALL_COUNT=$(jq -r '.install_commands | length' "$META")
if [ "$INSTALL_COUNT" -gt 0 ]; then
  (
    flock -w 300 200
    for i in $(seq 0 $((INSTALL_COUNT - 1))); do
      CMD=$(jq -r ".install_commands[$i].command" "$META")
      CWD=$(jq -r ".install_commands[$i].cwd" "$META")
      ( cd "$CWD" && sh -c "$CMD" )
    done
  ) 200>"/cache/.dep-install-lock"
fi

# meta.agent_command is the literal command the harness module emitted.
# No placeholder substitution and no operator-authored shell.
AGENT_COMMAND=$(jq -r '.agent_command' "$META")
MAX_MINUTES=$(jq -r '.max_runtime_minutes' "$META")
ROLE=$(jq -r '.role' "$META")

# Usage-limit retry loop (see next section): the whole container shares one
# wall-clock deadline; a usage-limit failure sleeps and relaunches a fresh
# agent instead of exiting the container.
DEADLINE=$(( $(date +%s) + MAX_MINUTES * 60 ))
while :; do
  AGENT_EXIT=0
  timeout --foreground --kill-after=30s "$(( DEADLINE - $(date +%s) ))s" \
    bash -c "$AGENT_COMMAND" \
    >> /output/progress.log 2>&1 \
    || AGENT_EXIT=$?
  # success / timeout / non-usage-limit failure → exit loop
  # usage-limit failure → WIP-commit dirty work, append interruption note
  # to prompt.md, sleep 10 minutes (budget permitting), relaunch
done

# Status from exit code + review.json check (review role only) →
# /output/result.json, always with exit_code 0 from the harness itself.
# Usage counts are summed across every run this container performed.
```

### Usage-Limit Retries (CLI Harness)

When the agent CLI exits because the provider's usage limit is exhausted
(e.g. a Claude Pro/Max 5-hour window), exiting the container would hand the
orchestrator a failure it can only answer by burning a task attempt on an
error no retry fixes until the limit window resets — tasks would churn
through `max_attempts` in minutes. Instead, the CLI harness keeps the
container alive and retries internally:

1. **Detect** — after a non-zero agent exit, the harness inspects the final
   `{"type":"result"}` stream-json event of the *current* run only. It
   classifies the failure as a usage limit when `is_error` is set and either
   `api_error_status` is 429 or the result text contains "usage limit"
   (Claude Code's subscription-limit phrasing). Detection is deliberately
   Claude Code-specific and narrow — a false positive would park the task
   until its deadline; other CLIs' phrasings get added as they are observed.
2. **Preserve** — uncommitted work is committed as a
   `WIP: auto-checkpoint` commit (dev role only), so the next run cannot
   destroy it and will find it in `git log`. A one-time note is appended to
   `/task/prompt.md` telling the next agent to review `git log`/`git status`
   and continue the existing work rather than restart it.
3. **Wait and relaunch** — the harness sleeps a fixed 10 minutes
   (`HARNESS_USAGE_RETRY_SECONDS` overrides this for tests) and re-runs the
   same `agent_command` as a fresh agent against the intact workspace. No
   session resume: resume flags are vendor-specific, and files/commits are
   the durable state a new run reorients from. Polling is deliberate — the
   CLI's "resets at ..." phrasing varies across versions, while a failed
   probe costs seconds and ~no tokens.
4. **Stay observable** — every wait and relaunch appends a timestamped
   `[harness ...]` marker line to `progress.log`, which the task page
   live-streams. The task simply stays `in-progress`; the operator can see
   it is waiting on a usage limit and intervene (cancel, reset) if desired.

The orchestrator needs no changes for this: the container just looks
long-running. Every retry and sleep is bounded by the single wall-clock
deadline (`max_runtime_minutes`); when the remaining budget cannot fit
another wait-plus-run, the harness stops retrying and reports the failure
normally, and the orchestrator's timeout sweep remains the backstop. A
parked container intentionally holds its scheduler slot and its provider's
concurrency slot — which also stops the scheduler from launching more tasks
against the exhausted provider beyond its `concurrency_limit`.

Non-usage failures are unaffected: the harness exits after the first
failure exactly as before, and the orchestrator's attempt handling owns the
retry. Because retries append multiple result events to one `progress.log`,
the `usage` block in `result.json` sums turn/token counts across every run
in the container.

The real-harness contract (including this retry loop) is covered by the
Docker-gated `harness-usage-limit.test.ts`, which runs the actual
`harness-cli.sh` in a container (image: `images/test-harness/`) against
scripted agent commands.

### Entrypoint Selection

The container entrypoint is set by the orchestrator at container
creation time based on the harness's `runtime`:
`harness-sdk.ts` for `'sdk'`, `harness-cli` for `'cli'`. See
[03 - Agent Containers](./03-agent-containers.md) for the
`createAgentContainer` code.

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
6. Self-review before committing — critique your own work; do not rely solely on the downstream review:
   - Re-read the task requirements and acceptance criteria above.
   - Compare them against your working tree (git status / git diff).
   - Explicitly enumerate any unmet requirements, bugs, missing tests, or unrelated/incidental changes.
   - (Rework cycles only) Also re-check your diff against the "Review Feedback" section below and confirm every feedback item is fully addressed.
   - Fix every gap you found, then continue.
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
