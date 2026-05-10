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

**Header bar:** orchestrator status (running/paused), slot usage (N/M active), queue depth, daily completion count, daily cost (sum of all attempt costs today), pause/resume button, settings link.

**Active tasks section:** each active task shows issue number and title, target repository, current phase (implementing/reviewing), attempt number, elapsed time, and a stop button.

**Queue section:** ordered list of pending tasks, each showing issue number, title, target repository, dependency status (blocked/ready), and drag handles for reordering. An "Add task" button at the bottom.

**Recent completions section:** last N completed tasks showing issue number, title, result (merged/failed), time since completion, and attempt count.

### Task Detail View

Accessed by clicking any task (active, queued, or completed). Shows full task lifecycle:

**Header:** issue number, title, repo, branch name, PR number (linked to Forgejo), current status, elapsed time.

**Actions bar:** Cancel, Force Approve, Force Fail, Reset buttons (context-dependent). Reset is available on any terminal state (`failed`, `cancelled`, `awaiting-human-*`, `needs-human-review`) and requires confirmation: *"This will delete the branch, PR, and all agent work. The issue will return to an unqueued state. Continue?"*

**Timeline:** chronological list of orchestrator events (preparing, container started, agent running, review started, merged, etc.) with timestamps.

**Agent output panel:** live-streaming terminal-like display of agent output during execution. For completed tasks, shows the stored log.

**Attempt history:** for tasks with multiple attempts, shows each attempt's duration, role (develop/review), result, token usage (input/output), cost, and review feedback received.

**Cost summary:** total cost for this task across all attempts (sum of per-attempt costs).

**Links:** direct links to the Forgejo issue, PR, and raw agent log file.

### Task Creation View

The orchestrator only acts on issues that have the `status/queued` label. Issues without this label exist in Forgejo but are invisible to the orchestrator — they can be drafted, discussed, and refined in Forgejo before being queued for agent work.

Two modes:

**Queue existing issue:** select repository, browse open issues that don't have any `status/*` label (i.e., not already queued or in progress). Selecting an issue adds the `status/queued` label and any configured override labels (`human-merge`, `human-review`). Options: max attempts override, agent tool override (dropdown defaulting to "Repo default", listing all configured tools).

**Create and queue new task:** repository selector, title, description (markdown editor with dependency checklist support), same override options including agent tool. Creates the Forgejo issue with `status/queued` label and queues it in one action.

Both modes result in the same outcome: a Forgejo issue with `status/queued` that the orchestrator will pick up on its next tick. Users who want to create issues without immediately queuing them should use Forgejo directly — the orchestrator UI is specifically for dispatching work to agents.

### Settings View

**Global settings:** max concurrent agents (default: 5), default max attempts (default: 3), agent timeout in minutes (default: 30), poll interval in seconds (default: 60), merge strategy (default: `squash`; options: squash/merge/rebase).

**Repository configuration:** list of configured repos, each with base branch, dev image type, agent tool selection, pre-agent script (with validation warning — see below), image status/rebuild trigger.

**Pre-agent script validation:** the pre-agent script field accepts any shell command and runs it inside agent containers via `eval`. The UI validates the value against a set of known safe patterns (e.g., `npm ci`, `npm install`, `pip install -r requirements.txt`, `yarn install`, `pnpm install`). If the value doesn't match a known pattern, the UI displays a warning: *"This command doesn't match a common dependency install pattern. It will run with full shell access inside agent containers, including access to environment variables (API keys)."* The warning does not block saving — it is informational only.

**Agent tools:** list of configured tools with display name, type, and auth status.

**Model pricing:** editable table of model family names with input and output cost per million tokens. Used for cost calculation in the dashboard and task detail views. Defaults are provided; overrides are stored in the `settings` table.

**Forgejo connection:** instance URL, connection status indicator.

**Credentials (read-only):** shows which environment variables are configured and whether they are set (e.g., `ANTHROPIC_API_KEY: ✓ configured`). Credential values are loaded from the `.env` file and cannot be edited through the UI. To update credentials, modify the `.env` file and restart the orchestrator.

## Orchestrator API

The UI consumes the following REST and WebSocket endpoints:

### REST Endpoints

```
GET    /api/tasks                  → queue + active + recent tasks
GET    /api/tasks?status=queued    → filter by status (optional)
GET    /api/tasks?limit=20         → limit recent completions (default: 20)
POST   /api/tasks                  → create new Forgejo issue and queue
POST   /api/tasks/queue            → queue an existing Forgejo issue
PATCH  /api/tasks/:id              → update task (see request schema below)
GET    /api/tasks/:id              → full task detail with attempt history
GET    /api/tasks/:id/log          → raw agent log download (plain text, Content-Type: text/plain)
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
      "max_attempts": 3,
      "agent_tool": "claude-agent-sdk",
      "container_id": "abc123def",
      "started_at": "2025-03-15T10:42:00Z",
      "completed_at": null,
      "created_at": "2025-03-15T10:40:00Z",
      "blocked_by": []
    }
  ]
}
```

Field notes:
- `issue_title` is fetched from Forgejo, not stored in the DB
- `repo` is joined from the `repos` table
- `blocked_by` is computed from dependency parsing (array of issue IDs that are still open)
- Active and queued tasks are always returned in full; completed tasks are limited by `limit`
- Cost tracking was removed in schema v14 — there is no `total_cost_usd` field on the task or `cost_usd`/`input_tokens`/`output_tokens` on the per-attempt rows

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
  "max_attempts": 3,
  "agent_tool": "claude-agent-sdk",
  "container_id": "abc123def",
  "started_at": "2025-03-15T10:42:00Z",
  "completed_at": null,
  "created_at": "2025-03-15T10:40:00Z",
  "blocked_by": [],
  "attempts": [
    {
      "id": 1,
      "attempt_number": 1,
      "role": "develop",
      "status": "success",
      "verdict": null,
      "started_at": "2025-03-15T10:42:00Z",
      "completed_at": "2025-03-15T10:55:00Z",
      "model": "sonnet",
      "feedback": null
    },
    {
      "id": 2,
      "attempt_number": 1,
      "role": "review",
      "status": "success",
      "verdict": "changes_needed",
      "started_at": "2025-03-15T10:55:30Z",
      "completed_at": "2025-03-15T11:02:00Z",
      "model": "sonnet",
      "feedback": "[{\"file\":\"src/login.ts\",\"line\":42,\"comment\":\"Missing null check\"}]"
    },
    {
      "id": 3,
      "attempt_number": 2,
      "role": "develop",
      "status": "running",
      "verdict": null,
      "started_at": "2025-03-15T11:02:30Z",
      "completed_at": null,
      "model": null,
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

The request body contains an `action` field that determines the operation. Each action has its own optional fields:

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

GET    /api/settings               → current configuration (see response schema below)
PATCH  /api/settings               → update configuration (partial update, same shape as GET response)

GET    /api/repos                  → configured repositories (see response schema below)
POST   /api/repos                  → add repository (see request schema below)
PATCH  /api/repos/:id              → update repository config (partial update, same shape as POST)
GET    /api/repos/:id/issues       → open Forgejo issues available for queuing

GET    /api/tools                  → configured agent tools (see response schema below)
POST   /api/tools                  → add agent tool (see request schema below)
PATCH  /api/tools/:id              → update agent tool (partial update, same shape as POST)

GET    /api/status                 → system health (see response schema below)
POST   /api/status/pause           → pause queue processing (no request body, returns updated status)
POST   /api/status/resume          → resume queue processing (no request body, returns updated status)

POST   /webhooks/forgejo            → Forgejo webhook receiver (payload defined by Forgejo, not consumed by UI)
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
      "agent_tool": "claude-agent-sdk",
      "install_steps": [{ "kind": "npm-ci" }],
      "allow_script_steps": false,
      "container_memory_mb": null,
      "container_cpu_cores": null,
      "merge_strategy": "squash"
    }
  ]
}
```

`POST /api/repos` request — required: `owner`, `name`, `agent_tool`. All other fields are optional (defaults: `base_branch` = `"main"`, `install_steps` = `[]`, `allow_script_steps` = `false`, nullable resource fields = `null`):

```json
{
  "owner": "org",
  "name": "backend",
  "base_branch": "main",
  "agent_tool": "claude-agent-sdk",
  "install_steps": [
    { "kind": "pip-requirements", "cwd": "services/api" },
    { "kind": "pnpm-install" }
  ]
}
```

`install_steps` is an ordered list. Recognised kinds: `npm-ci`, `npm-install`, `yarn-install`, `pnpm-install`, `pip-requirements`, `pip-pyproject`, `uv-sync`, `cargo-fetch`, `go-mod-download`. Each entry may include an optional `cwd` (relative to `/repo`, no `..`, no leading `/`). The `script` kind (`{ kind: "script", path: "scripts/setup.sh", cwd: "..." }`) runs `bash <path>` and is only accepted when this repo's `allow_script_steps` is `true`. Toggling `allow_script_steps` is the operator's per-repo opt-in for letting committers influence what runs at pre-agent time, since scripts inherit the agent container env (`ANTHROPIC_API_KEY`, `FORGEJO_AGENT_TOKEN`, etc.).

Nullable resource fields (`container_memory_mb`, `container_cpu_cores`) mean "use global default". Setting a value overrides the global for all tasks in this repo.

#### GET /api/tools Response & POST /api/tools Request

`GET` returns all configured agent tools. `POST` creates a new tool. `PATCH` accepts a partial object.

```json
{
  "tools": [
    {
      "id": "claude-agent-sdk",
      "display_name": "Claude Agent SDK",
      "type": "sdk",
      "command_template": null,
      "env_vars": {}
    },
    {
      "id": "opencode-local",
      "display_name": "OpenCode (Local LLM)",
      "type": "cli",
      "command_template": "opencode run \"$(cat {{PROMPT_FILE}})\" --non-interactive",
      "env_vars": {
        "OPENCODE_PROVIDER": "openai-compatible",
        "OPENCODE_MODEL": "codestral-latest",
        "OPENCODE_BASE_URL": "http://192.168.1.50:8080/v1"
      }
    }
  ]
}
```

`POST /api/tools` request — required: `id`, `display_name`, `type`. All other fields are optional:

```json
{
  "id": "opencode-anthropic",
  "display_name": "OpenCode (Anthropic API)",
  "type": "cli",
  "command_template": "opencode run \"$(cat {{PROMPT_FILE}})\" --non-interactive",
  "env_vars": {
    "OPENCODE_PROVIDER": "anthropic",
    "OPENCODE_MODEL": "claude-sonnet-4-20250514"
  }
}
```

The `env_vars` object contains non-secret configuration injected as container environment variables. Provider credentials (API keys) are never stored here — they live in the orchestrator's `.env` and are forwarded into every container via the fixed `FORWARDED_KEYS` list (see `packages/server/src/credentials.ts`).

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
  "agent_tool": "claude-agent-sdk",
  "max_attempts": 3,
  "human_merge": false,
  "human_review": false
}
```

Required: `repo_id`, `title`, `description`. All other fields are optional (defaults from repo/global settings).

#### POST /api/tasks/queue Request Schema

```json
{
  "issue_id": 42,
  "repo_id": 1,
  "agent_tool": null,
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
  "default_model": "sonnet"
}
```

Note: `poll_interval_seconds` (60s), `default_max_attempts` (7), and
`workspace_retention_days` (7) are compile-time constants in
`packages/server/src/constants.ts`, not editable settings. Per-task
`max_attempts` overrides are settable via `POST /api/tasks` at create time
and via `PATCH /api/tasks/:id` (with `{ max_attempts: N }`) on the Task
Detail page for non-terminal tasks. Cost tracking (`model_pricing`,
`daily_cost_usd`, per-task / per-attempt cost) was removed in schema v14 —
use Anthropic's console for spend visibility.

#### HTTP Status Codes

All endpoints follow consistent status code conventions:

| Status | Meaning | When |
|---|---|---|
| `200` | Success | GET requests, PATCH updates, POST actions (pause/resume/rebuild) |
| `201` | Created | POST /api/tasks, POST /api/tasks/queue, POST /api/repos, POST /api/tools |
| `400` | Bad request | Validation error, invalid action for current state, missing required fields |
| `401` | Unauthorized | No valid session cookie, expired OAuth2 token |
| `404` | Not found | Unknown task/repo/tool ID |
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
  "daily_completions": 12,
  "forgejo_connected": true,
  "last_poll_at": "2025-03-15T11:00:03Z",
  "uptime_seconds": 86400
}
```

The UI dashboard header uses `state`, `host_pool` (rendered as `Mem: used/total GB · CPU: used/total`), `queue_depth`, and `daily_completions`. The remaining fields (`forgejo_connected`, `last_poll_at`, `uptime_seconds`) are visibility-only — the orchestrator no longer alerts on a disk threshold (use OS-level disk monitoring instead). The host resource pool replaces the older count-based `active_slots` / `max_concurrency` pair: per-repo `container_memory_mb` / `container_cpu_cores` make a count of running tasks a leaky proxy for actual host capacity.

### WebSocket Endpoints

```
/ws/dashboard                      → real-time dashboard state updates
/ws/tasks/:id/output               → live agent output stream for a specific task
```

### Dashboard WebSocket Events

All WebSocket events use `type` as the discriminator field (matching the `DashboardEvent` union type in `events.ts`). The primary event types send full task objects rather than partial updates, simplifying client-side state management:

```json
{"type": "snapshot", "tasks": [...], "activeCount": 3, "maxConcurrency": 5, "queueDepth": 7, "paused": false}
{"type": "task_updated", "task": {"id": 42, "status": "in-review", "..."}}
{"type": "task_created", "task": {"id": 47, "status": "queued", "..."}}
{"type": "task_removed", "taskId": 43}
{"type": "status_changed", "paused": false, "activeCount": 3, "queueDepth": 6}
```

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
  "activeCount": 3,
  "maxConcurrency": 5,
  "queueDepth": 7,
  "paused": false
}
```

The snapshot uses the `DashboardSnapshot` type from `events.ts`. The `tasks` array uses the same task object shape as `GET /api/tasks`. Top-level fields provide the status summary. The client replaces its entire local state with the snapshot on (re)connect.

**On disconnect:** the client reconnects automatically with exponential backoff (1s, 2s, 4s, 8s, max 30s). On successful reconnection, the server sends a fresh state snapshot, and the client replaces its local state entirely (not merged, to avoid stale data).

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
