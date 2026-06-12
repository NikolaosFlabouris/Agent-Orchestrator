---
description: Walk a developer through creating and queueing a task in the Agent Orchestrator over MCP. Pick a registered repo, write a focused Markdown description (the agent's task prompt), set optional overrides (implementation/review agent profiles, max attempts, human review/merge), then create the Forgejo issue + orchestrator task atomically via the `create_task` MCP tool.
---

You are helping a developer create a task for the Agent Orchestrator. This task will become a Forgejo issue that the orchestrator picks up and assigns to an AI agent for implementation.

Walk through each step interactively. Ask one question at a time, confirm choices before moving on, and help the developer write a clear, well-structured issue that an AI agent can act on.

## How this skill creates the task

You talk to the orchestrator over MCP (Model Context Protocol). The plugin's `.mcp.json` declares a remote MCP server pointing at `${user_config.orchestrator_url}/mcp`; Claude Code handles the OAuth flow (Dynamic Client Registration + PKCE + browser-delegated user consent through the orchestrator's existing Forgejo login) the first time a tool is invoked, and stores + refreshes the access token transparently. The skill itself never sees or handles a credential.

Three MCP tools cover the whole flow:

- **`list_repos`** — registered repos with the agent profiles that will run a fresh task against them by default, one per workflow stage (implementation and review). Read-only.
- **`list_agent_profiles`** — every configured agent profile, with model + provider + usage stats. Read-only.
- **`create_task`** — creates the Forgejo issue, applies the `status/queued` label (plus optional `human-merge` / `human-review`), inserts the matching orchestrator task row with any overrides set atomically, broadcasts on the dashboard websocket, and triggers the scheduler. Returns the created task + issue identity.

Validation, label semantics, override resolution, and the scheduler kick all happen server-side inside the orchestrator — the path is race-free by construction and stays consistent with the orchestrator's REST API. If the developer hasn't authenticated to this orchestrator before, the first MCP call surfaces an OAuth prompt; instruct them to run `/mcp` if they need to manage the connection.

## Step 1: Select repository

Call the `list_repos` MCP tool. Present the results to the developer as `owner/name` along with the effective profile's display name, harness, and model (e.g. `Claude SDK + Sonnet — claude-sdk / anthropic/claude-sonnet-4-6`). Mark the source of the profile in the summary line: `(repo override)` when `agent_profile_source` is `"repo"`, `(global default)` when `"global"`, `(none — task cannot launch until configured)` when `"none"`. When `effective_review_agent_profile_id` differs from `effective_agent_profile_id`, append the review profile too (e.g. `; review: Claude Opus`) — otherwise omit it, since review inherits the implementation profile.

If the tool returns no repos, tell the developer the orchestrator has none registered and to add one via Settings → Repositories in the web UI before continuing.

Ask the developer to pick one and record its `id` (the orchestrator's internal repo id) for the `create_task` call later.

## Step 2: Write the issue title

Ask the developer to describe what they want done in a few words. Help them refine it into a concise, action-oriented title (e.g. "Add input validation to user registration endpoint"). The title should make sense as a standalone summary when viewed in a list. The orchestrator uses it as the PR title and the squash-commit subject; it is NOT injected into the agent's task prompt (the description is).

## Step 3: Write the issue description

This is the most important part — the description becomes the agent's task prompt verbatim, and the automated reviewer evaluates the agent's PR against the same text. Guide the developer through writing it by asking about:

1. **What** needs to change — the specific feature, fix, or refactor.
2. **Where** in the codebase — relevant files, modules, or areas (if known).
3. **Acceptance criteria** — how to know the task is done (tests to pass, behaviour to verify). This is the load-bearing section; the automated review verdict turns on whether these are met.
4. **Constraints** — anything task-specific the agent should avoid doing, plus any context about prerequisites.

Note on dependencies: the orchestrator does **not** enforce task ordering. There is no `depends_on` relationship in the data model; the scheduler dequeues purely by queue position and capacity. If this task has prerequisites, the developer should either (a) wait to create it until the prerequisite PR merges, or (b) document the dependency in the description as agent-readable context, with no ordering guarantee.

Then assemble the inputs into a well-structured Markdown description using this format:

```markdown
## Description

[Clear explanation of what needs to be done and why]

## Requirements

- [Specific requirement 1]
- [Specific requirement 2]
- ...

## Relevant files

- `path/to/file.ts` — [why this file is relevant]
- ...

## Acceptance criteria

- [ ] [Testable criterion 1]
- [ ] [Testable criterion 2]
- ...

## Notes

[Any task-specific constraints, context, or guidance for the agent. The orchestrator already injects standard git workflow + "follow existing code style" + "don't modify unrelated files" + "push before exit" — focus on the task-specific bits.]
```

Show the developer a preview of the full description and ask if they want to adjust anything before proceeding.

## Step 4: Configure task options

Ask about each option, explaining what it does. Use defaults unless the developer wants to change something:

- **Implementation profile override** — Use a different profile than the repo default for the implementation (develop) stage? List available profiles by calling the `list_agent_profiles` MCP tool. Show each profile as `<id>: <display_name> (<harness_id> / <provider_id>/<model_id>, timeout=<timeout_minutes>m)`. Default: leave blank → inherit from the repo's `agent_profile_id`, which itself inherits from the global default.

- **Review profile override** — Use a different profile for the automated review stage? Useful when a cheaper/local model implements and a stronger model reviews (e.g. a local Ollama profile implements, Claude Opus reviews). Reuse the `list_agent_profiles` output from the previous question — don't call the tool twice. Default: leave blank → inherit from the repo's review default, then the global review default, finally falling back to the implementation profile. Skip this question entirely when the developer enabled **Human review** below — the automated review agent doesn't run, so the review profile is unused.

- **Max attempts** — How many dev attempts before the task transitions to `failed`. Default: leave blank → use the orchestrator's system default (currently 7). Must be a positive integer ≥ 1 when set.

- **Human review** — Get a human to review the PR instead of the automated review agent. The orchestrator applies the `human-review` label. The dev agent still runs and opens a PR as normal; once the PR exists, status derivation sees the label and forces the task to `awaiting-human-review` rather than launching the automated review agent — a human then reviews/approves the PR. (Note: the label only takes effect *after* the PR is opened, not before.) Default: false.

- **Human merge** — After the automated review approves, leave the PR open instead of auto-merging. The orchestrator applies the `human-merge` label, and the review path sets the task to `awaiting-human-merge` so a human performs the merge. Default: false.

## Step 5: Confirm and create

Show a final summary of everything:

- Repository: `owner/name`
- Title: the issue title
- Description: the full Markdown body (preview)
- Options: implementation profile override, review profile override, max attempts, human review, human merge

Ask the developer to confirm. On confirmation, invoke the `create_task` MCP tool with:

- `repo_id`: the integer id from Step 1
- `title`: the title from Step 2
- `description`: the assembled Markdown body from Step 3
- `agent_profile_id`: the chosen implementation override, or omit when inheriting
- `review_agent_profile_id`: the chosen review override, or omit when inheriting
- `max_attempts`: the chosen number, or omit for the default
- `human_merge`: `true` when set, otherwise omit
- `human_review`: `true` when set, otherwise omit

The tool returns `{ task: {...}, issue: {...} }` on success — task id, issue number, repo, status, queue position, attempts allowed, and the stored per-task profile overrides (null when inheriting).

On success, report:

- Task id and queue position (e.g. "Task #42 created at queue position 3")
- The Forgejo issue number (and link if the orchestrator URL is reachable from the developer's browser; you can construct `${orchestrator_url_root_minus_orchestrator}/<owner>/<name>/issues/<issue.number>` if the developer asks, but it's not in the tool's response).
- The effective agent profiles, noting "(inherits repo / global default)" when the tool returned a null `agent_profile_id`, and "(inherits — falls back to the implementation profile)" when `review_agent_profile_id` is null.

On failure, the MCP tool returns a structured error with one of these prefixes:

- **`Invalid input:`** — a validation rule failed (missing required field, unknown `agent_profile_id` or `review_agent_profile_id`, non-positive `max_attempts`, repo title/description type mismatch). The message after the prefix is operator-readable; show it and ask the developer to fix the input.
- **`Not found:`** — the `repo_id` doesn't resolve. Re-run `list_repos` to refresh the list.
- **`Forgejo upstream failure:`** — the orchestrator could not reach Forgejo (token revoked, network blip, Forgejo deployment offline). The orchestrator's operator needs to investigate; this is not something the developer can fix from their end. Show the message and suggest they ping their orchestrator operator.

If the tool call itself fails with an authentication error before reaching the orchestrator (the OAuth token is missing or expired and the refresh failed), Claude Code surfaces this as an MCP error rather than a tool error — tell the developer to run `/mcp` and select the `agent-orchestrator` server to re-authenticate.

## Important notes

- The issue description IS the agent's task prompt verbatim. Be specific and unambiguous. Vague descriptions lead to poor results.
- If the developer isn't sure about file paths, help them search the codebase to identify the right locations before including them in the description.
- Keep the description focused on one coherent change. If the developer describes multiple unrelated changes, suggest splitting into separate tasks.
- The per-task `agent_profile_id`, `review_agent_profile_id`, and `max_attempts` overrides are also editable from the orchestrator's Task Detail page after creation. The developer doesn't need to decide upfront — leaving them blank and adjusting later is fine.
- The orchestrator runs all Forgejo communication itself. The developer's machine never needs Forgejo credentials, Docker, or direct access to the orchestrator's database; the only thing they configure once is the orchestrator's URL (via the plugin's `orchestrator_url` user config).
