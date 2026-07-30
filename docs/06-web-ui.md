# Web UI

## Overview

The web UI is a React SPA served by the orchestrator's Fastify process. It communicates exclusively with the orchestrator's API — it never talks to Forgejo or Docker directly. The orchestrator is the single backend.

## Authentication

The UI uses Forgejo as an OAuth2 provider:

```
User hits UI → Not authenticated → Redirect to Forgejo OAuth2 login
→ User authenticates in Forgejo → Redirect back with auth code
→ Orchestrator exchanges code for token → Creates signed cookie session
→ User is authenticated
```

Session management uses a signed cookie containing the access token, refresh token, and expiry timestamp. No server-side session store is needed. Before each authenticated request, the orchestrator checks the token expiry. If expired, it calls Forgejo's token endpoint with the refresh token to obtain a new access token and updates the cookie. If the refresh fails (token revoked, Forgejo unreachable), the user is redirected to the OAuth2 login flow.

The OAuth2 session is purely for UI access — the orchestrator's own Forgejo API tokens (used for issue/PR operations) are separate long-lived personal access tokens.

## Views

### Dashboard (Primary View)

The main view shows system state at a glance. Designed to be left open on a monitor.

**Header bar:** orchestrator status (running/paused), host pool usage (`Mem: used/total GB · CPU: used/total`), queue depth, daily completion count, pause/resume button, settings link.

**Active tasks section:** each active task shows issue number and title, target repository, current phase (implementing/reviewing), attempt number, elapsed time, and a stop button.

**Queue section:** ordered list of pending tasks, each showing issue number, title, target repository, dependency status (blocked/ready), and drag handles for reordering. An "Add task" button at the bottom.

**Recent completions section:** last N completed tasks showing issue number, title, result (merged/failed), time since completion, and attempt count.

### Task Detail View

Accessed by clicking any task (active, queued, or completed). Shows full task lifecycle:

**Header:** issue number, title, repo, branch name, PR number (linked to Forgejo), current status, elapsed time.

**Actions bar:** Cancel, Force Approve, Force Fail, Reset buttons (context-dependent). Reset is available on any terminal state (`failed`, `cancelled`, `awaiting-human-*`, `needs-human-review`) and requires confirmation: *"This will delete the branch, PR, and all agent work. The issue will return to an unqueued state. Continue?"*

**Timeline:** chronological list of orchestrator events (preparing, container started, agent running, review started, merged, etc.) with timestamps.

**Agent output panel:** live-streaming terminal-like display of agent output during execution. For completed tasks, shows the stored log.

**Attempt history:** for tasks with multiple attempts, shows each attempt's duration, role (develop/review), result, the snapshotted `harness_id` and `model_id`, and review feedback received.

**Links:** direct links to the Forgejo issue, PR, and raw agent log file.

### Task Creation View

The orchestrator only acts on issues that have the `status/queued` label. Issues without this label exist in Forgejo but are invisible to the orchestrator — they can be drafted, discussed, and refined in Forgejo before being queued for agent work.

Two modes:

**Queue existing issue:** select repository, browse open issues that don't have any `status/*` label (i.e., not already queued or in progress). Selecting an issue adds the `status/queued` label and any configured override labels (`human-merge`, `human-review`). Options: max attempts override, implementation profile override and review profile override (dropdowns defaulting to "Inherit", listing all configured profiles; the review select is disabled while human review is enabled, since the automated review agent doesn't run).

**Create and queue new task:** repository selector, title, description (markdown editor with dependency checklist support), same override options including both profile overrides. Creates the Forgejo issue with `status/queued` label and queues it in one action.

Both modes result in the same outcome: a Forgejo issue with `status/queued` that the orchestrator will pick up on its next tick. Users who want to create issues without immediately queuing them should use Forgejo directly — the orchestrator UI is specifically for dispatching work to agents.

### Settings View

The Settings page has five tabs:

**Global Settings.** Host resource pool (`max_agent_memory_mb`, `max_agent_cpu_cores`), the fallback `default_agent_profile_id` (implementation stage), and the optional `default_review_agent_profile_id` (review stage; unset = reviews use the implementation profile). The UI exposes profile pickers for both; deletion is gated on a profile not being either global default.

**Repositories.** List of configured repos. Per-repo fields: base branch, default implementation profile (`agent_profile_id`, nullable — blank means inherit the global default), default review profile (`review_agent_profile_id`, nullable — blank means inherit the global review default, then the implementation profile), `install_steps` (typed entries: kind from a fixed dropdown plus optional `cwd`, plus an `allow_script_steps` toggle for the script escape hatch), per-repo container memory/CPU overrides (blank = compile-time defaults), preferred merge strategy (squash / merge / rebase).

**Providers & Models.** Nested layout: the providers list is the outer view, and selecting a provider expands its model list. Provider fields: `id`, `display_name`, `kind` (anthropic / claude-subscription / openai / gemini / mistral / deepseek / openrouter / ollama), `concurrency_limit`, `base_url` (required for ollama, hidden for cloud kinds), and exactly one of `api_key_env_var` (env-var pointer) or `auth_token` (inline plaintext). Per-kind form components render only the fields that kind supports. Model fields are just `model_id` and `display_name` under a fixed `provider_id`.

**Agent Profiles.** Operator-composed pairings. Fields: `id`, `display_name`, `harness_id` (one of the four code-defined harnesses), `model_pk` (picker scoped to the chosen harness's `supported_provider_kinds`), `timeout_minutes`, and a per-harness `config_json` form. The UI renders a different form component per `harness_id`; harnesses with no operator-tunable knobs render an empty form.

**Credentials (read-only).** Shows which orchestrator-only env vars are set in `.env` (`FORGEJO_*`, `ORCHESTRATOR_URL`). Provider credentials are configured per-provider on the Providers & Models tab — this tab no longer enumerates LLM provider keys.

## Orchestrator API

The UI consumes the following REST and WebSocket endpoints:

### REST Endpoints

```
GET    /api/tasks                          → queue + active + recent tasks
GET    /api/tasks?status=queued            → filter by status (optional)
GET    /api/tasks?limit=20                 → limit recent completions (default: 20)
POST   /api/tasks                          → create new Forgejo issue and queue
POST   /api/tasks/queue                    → queue an existing Forgejo issue
PATCH  /api/tasks/:id                      → update task (see request schema below)
GET    /api/tasks/:id                      → full task detail with attempt history
GET    /api/tasks/:id/log                  → raw agent log download (plain text)
```

#### GET /api/tasks Response

Returns all active and queued tasks, plus the most recent completed tasks (limited by `limit` parameter, default 20). Single array — the frontend groups by status.

```json
{
  "tasks": [
    {
      "id": 1,
      "issue_id": 42,
      "issue_title": "Add login validation",
      "repo": { "id": 1, "owner": "org", "name": "frontend" },
      "branch_name": "agent/issue-42-add-login-validation",
      "pr_number": 7,
      "status": "in-progress",
      "queue_position": null,
      "attempt": 2,
      "max_attempts": 7,
      "agent_profile_id": "default-claude-sdk",
      "container_id": "abc123def",
      "started_at": "2026-03-15T10:42:00Z",
      "completed_at": null,
      "created_at": "2026-03-15T10:40:00Z",
      "blocked_by": []
    }
  ]
}
```

Field notes:
- `issue_title` is fetched from Forgejo, not stored in the DB
- `repo` is joined from the `repos` table
- `agent_profile_id` is the per-task implementation-stage override; `null` means inherit from `repos.agent_profile_id`, which falls back to `settings.default_agent_profile_id`
- `review_agent_profile_id` is the per-task review-stage override; `null` means inherit from `repos.review_agent_profile_id` → `settings.default_review_agent_profile_id` → the effective implementation profile. Responses also carry the resolved `effective_agent_profile_id` / `agent_profile_source` and `effective_review_agent_profile_id` / `review_agent_profile_source` (`task` / `repo` / `global` / `implementation` / `none`) so the UI can render the inherit chains without re-deriving them
- `has_human_review_label` is a live read of the Forgejo `human-review` driver label from the same snapshot the status derivation uses: `true` = the automated review agent is skipped (so the review profile is unused; the UI greys out its selector), `false` = it will run, `null` = unknown (no Forgejo snapshot available). GET responses only — POST/PATCH responses omit it
- `blocked_by` is computed from dependency parsing (array of issue IDs that are still open)
- Active and queued tasks are always returned in full; completed tasks are limited by `limit`

Frontend grouping: active = `status IN ('preparing', 'in-progress', 'in-review', 'changes-needed')`, queued = `status == 'queued'`, completed = everything else.

#### GET /api/tasks/:id Response

Returns the same task object as above, plus the full attempt history and timeline:

```json
{
  "id": 1,
  "issue_id": 42,
  "issue_title": "Add login validation",
  "repo": { "id": 1, "owner": "org", "name": "frontend" },
  "branch_name": "agent/issue-42-add-login-validation",
  "pr_number": 7,
  "status": "in-progress",
  "queue_position": null,
  "attempt": 2,
  "max_attempts": 7,
  "agent_profile_id": "default-claude-sdk",
  "container_id": "abc123def",
  "started_at": "2026-03-15T10:42:00Z",
  "completed_at": null,
  "created_at": "2026-03-15T10:40:00Z",
  "blocked_by": [],
  "attempts": [
    {
      "id": 1,
      "attempt_number": 1,
      "role": "develop",
      "status": "success",
      "verdict": null,
      "started_at": "2026-03-15T10:42:00Z",
      "completed_at": "2026-03-15T10:55:00Z",
      "harness_id": "claude-sdk",
      "model_id": "claude-sonnet-4-6",
      "feedback": null
    },
    {
      "id": 2,
      "attempt_number": 1,
      "role": "review",
      "status": "success",
      "verdict": "changes_needed",
      "started_at": "2026-03-15T10:55:30Z",
      "completed_at": "2026-03-15T11:02:00Z",
      "harness_id": "claude-sdk",
      "model_id": "claude-sonnet-4-6",
      "feedback": "[{\"file\":\"src/login.ts\",\"line\":42,\"comment\":\"Missing null check\"}]"
    },
    {
      "id": 3,
      "attempt_number": 2,
      "role": "develop",
      "status": "running",
      "verdict": null,
      "started_at": "2026-03-15T11:02:30Z",
      "completed_at": null,
      "harness_id": "claude-sdk",
      "model_id": "claude-sonnet-4-6",
      "feedback": null
    }
  ],
  "forgejo_links": {
    "issue": "http://forgejo:3000/org/frontend/issues/42",
    "pr": "http://forgejo:3000/org/frontend/pulls/7"
  }
}
```

The `attempts` array contains every attempt row for this task, ordered chronologically. The `feedback` field is a JSON string (the review agent's feedback array) — the frontend parses it for display. The `forgejo_links` object provides direct URLs for the Forgejo issue and PR.

#### PATCH /api/tasks/:id Request Schema

Two request shapes. **Direct field updates** carry one or more editable fields and no `action` key; every recognized field is validated up front and applied atomically (a validation failure on any field rejects the whole request with nothing applied):

```json
{ "agent_profile_id": "opencode-ollama-qwen", "review_agent_profile_id": "default-claude-sdk" }
{ "review_agent_profile_id": null }
{ "max_attempts": 5 }
```

`agent_profile_id` / `review_agent_profile_id` accept a profile id or `null` to clear the per-task override (empty string is rejected). `max_attempts` must be a positive integer ≥ the current attempt count and is not editable in terminal states (use `extend`/`requeue`).

**Actions** carry an `action` field that determines the operation. Each action has its own optional fields:

```json
{ "action": "reorder", "queue_position": 3 }
{ "action": "cancel", "reason": "No longer needed" }
{ "action": "force_approve" }
{ "action": "force_fail", "reason": "Known bad approach" }
{ "action": "reset" }
```

| Action | Description | Valid from states | Effect |
|---|---|---|---|
| `reorder` | Change position in queue | `queued` | Updates `queue_position`. Requires `queue_position` (integer). |
| `cancel` | Cancel the task | Any active state | Stops container, deletes branch/PR, relabels. Optional `reason` (string). |
| `force_approve` | Skip review, go straight to merge | `in-review` | Treats review as approved, attempts merge. |
| `force_fail` | Manually fail the task | Any active state | Stops container, marks as failed. Optional `reason` (string). |
| `reset` | Reset to clean unqueued state | Any terminal state (`failed`, `cancelled`, `awaiting-human-*`, `needs-human-review`) | Deletes branch/PR/workspace, removes labels, resets attempt counter. |

Response: `200` with updated task object, or `400` if the action is invalid for the current task state.

```

GET    /api/settings                       → current configuration
PATCH  /api/settings                       → update configuration (partial)

GET    /api/repos                          → configured repositories
POST   /api/repos                          → add repository
PATCH  /api/repos/:id                      → update repository config (partial)
GET    /api/repos/:id/issues               → open Forgejo issues available for queuing

GET    /api/providers                      → configured providers (with stats)
POST   /api/providers                      → add provider
PATCH  /api/providers/:id                  → update provider (partial)
DELETE /api/providers/:id                  → delete provider (409 if any models reference it)
GET    /api/provider-kinds                 → registry metadata for the per-kind UI form

GET    /api/providers/:id/models           → models scoped to one provider
POST   /api/providers/:id/models           → add a model under this provider
PATCH  /api/models/:pk                     → update model display name (by surrogate PK)
DELETE /api/models/:pk                     → delete model (409 if any profile references it)

GET    /api/agent-profiles                 → configured agent profiles (with stats)
POST   /api/agent-profiles                 → add agent profile
PATCH  /api/agent-profiles/:id             → update agent profile (partial)
DELETE /api/agent-profiles/:id             → delete profile (409 if it's the global default or referenced)
GET    /api/harnesses                      → code-defined harness registry (read-only)

GET    /api/status                         → system health
POST   /api/status/pause                   → pause queue processing
POST   /api/status/resume                  → resume queue processing

POST   /webhooks/forgejo                   → Forgejo webhook receiver
```

#### GET /api/repos Response & POST /api/repos Request

`GET` returns all configured repositories. `POST` creates a new repo config. `PATCH` accepts a partial object.

```json
{
  "repos": [
    {
      "id": 1,
      "owner": "org",
      "name": "frontend",
      "base_branch": "main",
      "agent_profile_id": null,
      "review_agent_profile_id": null,
      "install_steps": [{ "kind": "npm-ci" }],
      "allow_script_steps": false,
      "container_memory_mb": null,
      "container_cpu_cores": null,
      "merge_strategy": "squash"
    }
  ]
}
```

`POST /api/repos` request — required: `owner`, `name`. `agent_profile_id` is optional; `null` means inherit `settings.default_agent_profile_id` at task launch time. `review_agent_profile_id` is optional with the same shape; `null` means inherit the global review default, then the implementation profile. Other defaults: `base_branch` = `"main"`, `install_steps` = `[]`, `allow_script_steps` = `false`, nullable resource fields = `null`.

```json
{
  "owner": "org",
  "name": "backend",
  "base_branch": "main",
  "agent_profile_id": "opencode-ollama-qwen",
  "install_steps": [
    { "kind": "pip-requirements", "cwd": "services/api" },
    { "kind": "pnpm-install" }
  ]
}
```

`install_steps` is an ordered list. Recognised kinds: `npm-ci`, `npm-install`, `yarn-install`, `pnpm-install`, `pip-requirements`, `pip-pyproject`, `uv-sync`, `cargo-fetch`, `go-mod-download`. Each entry may include an optional `cwd` (relative to `/repo`, no `..`, no leading `/`). The `script` kind (`{ kind: "script", path: "scripts/setup.sh", cwd: "..." }`) runs `bash <path>` and is only accepted when this repo's `allow_script_steps` is `true`. Toggling `allow_script_steps` is the operator's per-repo opt-in for letting committers influence what runs at pre-agent time, since scripts inherit the agent container env (provider credential under the kind's standard name, `FORGEJO_AGENT_TOKEN`, etc.).

Nullable resource fields (`container_memory_mb`, `container_cpu_cores`) mean "use global default". Setting a value overrides the global for all tasks in this repo.

#### GET /api/providers, GET /api/providers/:id/models

`GET /api/providers` returns providers enriched with `models_count` and live `active_slots`:

```json
{
  "providers": [
    {
      "id": "anthropic",
      "display_name": "Anthropic",
      "kind": "anthropic",
      "concurrency_limit": 5,
      "base_url": null,
      "auth_token": null,
      "api_key_env_var": "ANTHROPIC_API_KEY",
      "notes": null,
      "models_count": 3,
      "active_slots": 1
    },
    {
      "id": "ollama-gpu",
      "display_name": "Ollama (gpu host)",
      "kind": "ollama",
      "concurrency_limit": 1,
      "base_url": "http://192.168.1.50:11434",
      "auth_token": null,
      "api_key_env_var": null,
      "notes": null,
      "models_count": 2,
      "active_slots": 0
    }
  ]
}
```

`POST /api/providers` request — required: `id`, `display_name`, `kind`. `concurrency_limit` defaults to `1`. `base_url` is required for `kind=ollama` and forbidden for cloud kinds. Operators choose between `api_key_env_var` (env-var pointer) and `auth_token` (inline plaintext); leave both null when no auth is required.

`GET /api/providers/:id/models` returns the models scoped to one provider:

```json
{
  "models": [
    { "id": 1, "provider_id": "anthropic", "model_id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6" },
    { "id": 2, "provider_id": "anthropic", "model_id": "claude-opus-4-7",   "display_name": "Claude Opus 4.7" }
  ]
}
```

`POST /api/providers/:id/models` request: `{ "model_id": "...", "display_name": "..." }`. The composite `(provider_id, model_id)` must be unique. Update display name via `PATCH /api/models/:pk`; delete via `DELETE /api/models/:pk` (409 if any agent profile references it).

`GET /api/provider-kinds` returns the per-kind metadata the UI uses to render the right form fields per kind:

```json
{
  "kinds": [
    { "kind": "anthropic", "display_name": "Anthropic", "requires_base_url": false, "container_env_name": "ANTHROPIC_API_KEY", "auth_optional": false, "description": "..." },
    { "kind": "ollama",    "display_name": "Ollama (self-hosted)", "requires_base_url": true,  "container_env_name": null,                "auth_optional": true,  "description": "..." }
  ]
}
```

#### GET /api/agent-profiles, GET /api/harnesses

`GET /api/agent-profiles` returns profiles with stats:

```json
{
  "profiles": [
    {
      "id": "default-claude-sdk",
      "display_name": "Claude SDK + Sonnet",
      "harness_id": "claude-sdk",
      "model_pk": 1,
      "config_json": {},
      "timeout_minutes": 120,
      "repos_using": 0,
      "tasks_using": 3,
      "provider_id": "anthropic",
      "model_id": "claude-sonnet-4-6"
    }
  ]
}
```

`POST /api/agent-profiles` request — required: `id`, `display_name`, `harness_id`, `model_pk`. `config_json` defaults to `{}`; `timeout_minutes` defaults to `2880` (48h). The harness module's `validateConfig` hook runs server-side on save and returns a 400 with a human-readable message if `config_json` is malformed. Harness↔provider compatibility is intentionally not validated at save — mismatches surface at task launch with a clear "harness X doesn't support kind Y" message.

`DELETE /api/agent-profiles/:id` returns 409 when the profile is either global default (`settings.default_agent_profile_id` or `settings.default_review_agent_profile_id`) or when any repo or task references it in either profile column (implementation or review).

`GET /api/harnesses` returns the code-defined harness registry — read-only, used by the Agent Profiles form to populate the harness dropdown and scope the model picker:

```json
{
  "harnesses": [
    { "id": "claude-sdk",  "display_name": "Claude Agent SDK", "runtime": "sdk", "supported_provider_kinds": ["anthropic"] },
    { "id": "claude-code", "display_name": "Claude Code CLI",  "runtime": "cli", "supported_provider_kinds": ["anthropic", "claude-subscription"] },
    { "id": "opencode",    "display_name": "OpenCode",         "runtime": "cli", "supported_provider_kinds": ["anthropic", "openai", "gemini", "mistral", "deepseek", "openrouter", "ollama"] },
    { "id": "pi",          "display_name": "pi",               "runtime": "cli", "supported_provider_kinds": ["anthropic", "openai", "gemini", "mistral", "deepseek", "openrouter", "ollama"] }
  ]
}
```

#### GET /api/repos/:id/issues Response

Returns open Forgejo issues for the specified repo that don't have any `status/*` label (i.e., available for queuing). The orchestrator proxies the Forgejo API and filters out issues that are already tracked as tasks.

```json
{
  "issues": [
    { "id": 42, "title": "Add login validation", "created_at": "2025-03-14T09:00:00Z" },
    { "id": 45, "title": "Fix dashboard layout", "created_at": "2025-03-15T08:30:00Z" }
  ]
}
```

#### POST /api/tasks Request Schema

```json
{
  "repo_id": 1,
  "title": "Add login validation",
  "description": "Implement email format validation on the login form...",
  "agent_profile_id": "default-claude-sdk",
  "review_agent_profile_id": null,
  "max_attempts": 7,
  "human_merge": false,
  "human_review": false
}
```

Required: `repo_id`, `title`, `description`. All other fields are optional. `agent_profile_id` overrides the repo's default for the implementation stage; omit (or pass `null`) to inherit `repos.agent_profile_id`, which falls back to `settings.default_agent_profile_id`. `review_agent_profile_id` is the review-stage counterpart; omit/`null` inherits `repos.review_agent_profile_id` → `settings.default_review_agent_profile_id` → the implementation profile.

#### POST /api/tasks/queue Request Schema

```json
{
  "issue_id": 42,
  "repo_id": 1,
  "agent_profile_id": null,
  "review_agent_profile_id": null,
  "max_attempts": null,
  "human_merge": false,
  "human_review": false
}
```

Required: `issue_id`, `repo_id`. All other fields are optional.

#### GET /api/settings Response & PATCH /api/settings Request

`GET` returns all settings. `PATCH` accepts a partial object — only the fields included are updated.

```json
{
  "max_agent_memory_mb": 20480,
  "max_agent_cpu_cores": 10,
  "default_agent_profile_id": "default-claude-sdk",
  "default_review_agent_profile_id": "default-claude-code-subscription"
}
```

`default_review_agent_profile_id` is absent from the GET response when
unset (the default) — reviews then run with the implementation profile.
PATCH with `null` clears it back to that state.

Note: `poll_interval_seconds` (60s), `default_max_attempts` (7), and
`workspace_retention_days` (7) are compile-time constants in
`packages/server/src/constants.ts`, not editable settings. Per-task
`max_attempts` overrides are settable via `POST /api/tasks` at create time
and via `PATCH /api/tasks/:id` (with `{ max_attempts: N }`) on the Task
Detail page for non-terminal tasks.

#### HTTP Status Codes

All endpoints follow consistent status code conventions:

| Status | Meaning | When |
|---|---|---|
| `200` | Success | GET requests, PATCH updates, POST actions (pause/resume/rebuild) |
| `201` | Created | POST /api/tasks, POST /api/tasks/queue, POST /api/repos, POST /api/providers, POST /api/providers/:id/models, POST /api/agent-profiles |
| `400` | Bad request | Validation error, invalid action for current state, missing required fields |
| `401` | Unauthorized | No valid session cookie, expired OAuth2 token |
| `404` | Not found | Unknown task/repo/provider/model/profile ID |
| `409` | Conflict | Duplicate id; or RESTRICTed delete (provider has models, model has profiles, profile is the global default or referenced) |
| `500` | Server error | Unexpected internal error (Forgejo unreachable, Docker error, DB error) |

All error responses include a JSON body: `{ "error": "Human-readable description" }`.

#### GET /api/status Response

```json
{
  "state": "running",
  "host_pool": {
    "memory_used_mb": 12288,
    "memory_total_mb": 20480,
    "cpu_used_cores": 6,
    "cpu_total_cores": 10
  },
  "queue_depth": 7,
  "forgejo_connected": true,
  "last_poll_at": "2025-03-15T11:00:03Z",
  "uptime_seconds": 86400
}
```

The UI dashboard header uses `state`, `host_pool` (rendered as `Mem: used/total GB · CPU: used/total`), and `queue_depth`. The remaining fields (`forgejo_connected`, `last_poll_at`, `uptime_seconds`) are visibility-only — the orchestrator no longer alerts on a disk threshold (use OS-level disk monitoring instead). The host resource pool replaces the older count-based `active_slots` / `max_concurrency` pair: per-repo `container_memory_mb` / `container_cpu_cores` make a count of running tasks a leaky proxy for actual host capacity.

### WebSocket Endpoints

```
/ws/dashboard                      → real-time dashboard state updates
/ws/tasks/:id/output               → live agent output stream for a specific task
```

### Dashboard WebSocket Events

All WebSocket events use `type` as the discriminator field (matching the `DashboardEvent` union type in `events.ts`). The primary event types send full task objects rather than partial updates, simplifying client-side state management:

```json
{"type": "snapshot", "tasks": [...], "hostPool": {"memory_used_mb": 8192, "memory_total_mb": 32768, "cpu_used_cores": 4, "cpu_total_cores": 12}, "queueDepth": 7, "paused": false}
{"type": "task_updated", "task": {"id": 42, "status": "in-review", "..."}}
{"type": "task_created", "task": {"id": 47, "status": "queued", "..."}}
{"type": "status_changed", "paused": false, "hostPool": {"...": "..."}, "queueDepth": 6}
{"type": "resource_changed", "resource": "profiles"}
```

Every task payload — in `snapshot`, `task_updated` and `task_created` alike — is the **same enriched object** `GET /api/tasks` returns (`TaskView` in `packages/shared`), produced by the single serializer in `packages/server/src/task-view.ts`. The client replaces a task wholesale when an event arrives, so a leaner payload would silently strip fields (`repo`, `dependencies`/`blocked`, `health`, the resolved agent-profile chains) off rows it already held.

One caveat applies to the broadcast path only: it is synchronous and never calls Forgejo or Docker, so `status` is Forgejo-derived only when a snapshot is already cached for that task, and `health` uses the Docker-free derivation (it can report `orphaned` for a null container, but not for a container that vanished). With no cached snapshot the payload carries the stored runtime status — the same degradation `deriveStatus` documents. REST reads keep their stale-while-revalidate snapshot fetch and Docker-derived health.

The UI subscribes to the dashboard WebSocket on load and maintains local state from events. REST endpoints are used for actions and initial page load only.

### WebSocket Connection Lifecycle

**On connect:** the server sends a full state snapshot as the first message. The client initialises its local state from this snapshot. Subsequent messages are incremental events.

The snapshot combines the data from `GET /api/tasks` and `GET /api/status` into a single message:

```json
{
  "type": "snapshot",
  "tasks": [
    { "id": 1, "issue_id": 42, "status": "in-progress", "..." : "..." }
  ],
  "hostPool": {
    "memory_used_mb": 8192,
    "memory_total_mb": 32768,
    "cpu_used_cores": 4,
    "cpu_total_cores": 12
  },
  "queueDepth": 7,
  "paused": false
}
```

The snapshot uses the `DashboardSnapshot` type from `events.ts`. The `tasks` array uses the same task object shape as `GET /api/tasks`. Top-level fields provide the status summary. The client replaces its entire local state with the snapshot on (re)connect.

**One shared connection:** the app opens exactly one dashboard socket, owned by `LiveDataProvider` (`packages/ui/src/live.tsx`) which `GatedLayout` mounts above the route table. It survives navigation between Dashboard, TaskDetail, Reports and Settings rather than cold-starting a socket and snapshot per route, and the store's event handlers live there so state stays live regardless of which view is rendered. Views needing raw events (TaskDetail, which refetches its own task on a matching `task_updated`) subscribe via `useDashboardEvents`; the underlying singleton is reference-counted, with a short teardown grace period so a StrictMode double-mount or a route transition reuses the live socket instead of churning it.

**Heartbeat:** the server pings every 25s and, on the same tick, sends a `status_changed` frame — browsers cannot observe pong frames from JS, so the application-level frame is what the client can actually see. A socket whose peer misses two consecutive pongs is terminated; the per-socket interval is cleared on both `close` and `error` so a long-lived server leaks no timers. The client tracks the time of the last received message and, after 60s of silence (roughly two missed beats), closes the socket itself so the backoff reconnect below engages. This is what catches a connection that died silently — an idle NAT timeout, a host IP change, a suspended laptop — which never fires `onclose`. Connection state is surfaced in the store and rendered in `AppHeader` as a muted "Live" marker or an amber "Reconnecting — data may be stale" chip, so a dead feed is visible on every view.

**On disconnect:** the client reconnects automatically with exponential backoff (1s, 2s, 4s, 8s, max 30s). On successful reconnection, the server sends a fresh state snapshot, and the client replaces its local state entirely (not merged, to avoid stale data).

**REST reconciliation:** the periodic `GET /api/tasks` refresh goes through the store's `syncTasks`, which upserts every returned row (healing a missed `task_created`) and prunes local rows the response omitted. Pruning applies **only** to rows whose local status is active or queued — the buckets that route returns whole. The completed bucket is truncated by `?limit`, so a missing completed row is one the server intentionally withheld, not one it deleted. Snapshots keep the wholesale-replace semantics above; `syncTasks` is for the REST path only.

**Agent output stream (`/ws/tasks/:id/output`):** on connect, the server sends all buffered output from the current container's progress log, then streams new lines as they arrive. On reconnect, the same replay-then-stream behaviour ensures no output is missed. When the container exits, the server sends a final `{"event": "stream_complete"}` message and closes the connection.

## Alerts

Alerts are shown as a banner at the top of the dashboard for states requiring human attention. See [07 - Deployment & Operations](./07-deployment-operations.md) for the full alert conditions table with severity levels and actions.

## Data Sources

| Source | Provides |
|--------|----------|
| Forgejo (via orchestrator API) | Issue list, titles, bodies, labels, state; PR status; issue comments; repository list |
| Orchestrator internal state | Queue ordering; active slot assignments; current phase per task; elapsed time; attempt counters; container IDs |
| Docker (via orchestrator) | Container running/stopped state; resource usage; log streams |
| Derived/computed | Dependency resolution; average completion time; success rate; rework rate |

## Design Principles

- The UI talks exclusively to the orchestrator API. No direct Forgejo or Docker access.
- Real-time updates via WebSocket eliminate polling from the frontend.
- The dashboard is designed for passive monitoring — leave it open, glance at it.
- Task detail is designed for active investigation — drill in when something needs attention.
- All destructive actions (cancel, force-fail) require confirmation.
