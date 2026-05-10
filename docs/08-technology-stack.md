# Technology Stack

## Overview

The technology stack prioritizes uniformity (TypeScript everywhere), minimal external dependencies, and low operational overhead. The entire system runs as Docker containers with no external databases, message queues, or build services.

## Language

**TypeScript** is used for the orchestrator backend, the web UI frontend, the shared type definitions, and the SDK-based agent harness. A single language across the stack eliminates context-switching, enables shared type definitions between API and UI, and reduces the toolchain footprint.

The only exception is the CLI agent harness, which is a bash script for tools invoked via shell command (e.g., OpenCode). This is kept as bash because it's ~50 lines with no dependencies.

## Backend

### Runtime: Node.js 22

Long-term support release. Provides native `fetch`, good TypeScript support via `tsx`, and mature Docker SDK libraries.

### HTTP Framework: Fastify

Chosen over Express for:

- First-party WebSocket plugin (`@fastify/websocket`) integrated into the routing model
- Better TypeScript type support for request/response schemas
- Serves REST API, WebSocket connections, and static UI files from a single process

The HTTP layer is simple (a dozen REST endpoints, two WebSocket routes) — either Fastify or Express would work. Fastify's integrated WebSocket support is the deciding factor since the orchestrator relies on WebSockets for live agent output and dashboard events.

### OAuth2: @fastify/oauth2

Handles the Forgejo OAuth2 authorization code flow — redirect, callback, token exchange, and token refresh. Eliminates custom OAuth2 implementation. The plugin manages the token lifecycle; the orchestrator stores the access token, refresh token, and expiry in a signed cookie via `@fastify/cookie`.

### Logging: Pino (via Fastify)

Fastify uses Pino as its built-in logger. All structured JSON logging (the `ts`, `level`, `event`, `task_id` format specified in the design) goes through Pino. Benefits over custom `console.log(JSON.stringify(...))`:

- Log levels (`info`, `warn`, `error`) with filtering
- Child loggers with bound context (e.g., `logger.child({ task_id: 42 })`)
- Automatic request/response logging for all HTTP endpoints
- Same JSON-line-to-stdout format the design specifies

Application log events (task state changes, container lifecycle, git operations) use `logger.info({ event: '...', task_id: ... })`. No separate logging library needed.

### Database: SQLite via better-sqlite3

- Embedded, no separate service
- Backs up as a single file
- WAL mode for crash resilience
- Synchronous API (simpler code, no async query complexity)
- Handles the write volume of this system trivially

No ORM. Queries are raw SQL strings. The schema is small enough that an ORM adds complexity without value.

### Docker Management: dockerode

Standard Node.js Docker client. Talks to the Docker socket directly. Supports:

- Container creation with labels, mounts, env vars, resource limits
- Container start/stop/wait/remove
- Log streaming via the attach API (feeds WebSocket agent output stream)
- Container listing with label filters (for orphan cleanup on restart)

### Git Operations: child_process (execSync / execFileSync)

With agents handling their own git fetch, commit, and push, the orchestrator's git usage is limited to workspace preparation (clone, fetch, checkout, branch creation) and occasional salvage (add, commit, push for work the agent left uncommitted). These are straightforward commands executed via Node.js `child_process.execFileSync('git', [...args], { cwd: workdir })`. No wrapper library is needed for this limited surface area.

### Agent SDK: @anthropic-ai/claude-agent-sdk (TypeScript)

The Claude Agent SDK provides the same agent loop and tools as Claude Code, programmable in TypeScript. Used for the SDK-type agent harness. Key features:

- `query()` async iterator for streaming agent messages
- `allowedTools` for scoping capabilities
- `permissionMode: "bypassPermissions"` for autonomous operation
- Model selection per invocation
- Structured message objects for progress tracking

Authentication is via `ANTHROPIC_API_KEY` environment variable. API key billing (pay-per-token) is the only supported path for the SDK. Subscription billing is not available for programmatic calls.

## Frontend

### Framework: React

Warranted because the dashboard has real-time updating state from WebSockets, interactive queue reordering, and multiple views. Plain HTML/JS would become unwieldy.

No Next.js, no SSR. The UI is a SPA that talks to the orchestrator API. It's built by Vite into static files that Fastify serves.

### Build Tool: Vite

Fast build times, good TypeScript support, simple configuration. Produces static files that the orchestrator serves via `@fastify/static`.

### State Management: zustand

Tiny (~1KB), no boilerplate, works well with React. Stores the dashboard state (task list, slot status, queue order) and updates it from WebSocket events. No Redux, no MobX.

### Styling: Tailwind CSS

Utility-first CSS framework. Avoids writing custom CSS. Works well with React components. No CSS-in-JS, no styled-components.

### Drag and Drop: @dnd-kit/core

For queue reordering. Lightweight, accessible, React-native drag-and-drop.

### Routing: react-router-dom

Client-side routing for the four views (Dashboard, TaskDetail, CreateTask, Settings). The TaskDetail view requires URL-based routing (`/tasks/:id`) so users can link directly to a task. Standard choice for React SPAs.

### Markdown Editor: textarea with preview

The task creation description field uses a plain `<textarea>` with a markdown preview toggle. No rich-text editor library — the input is markdown text that becomes the Forgejo issue body. A preview pane renders the markdown using a lightweight library (e.g., `react-markdown`) so the user can verify formatting and dependency checklists before submitting.

## Shared Types

The `packages/shared` workspace package contains TypeScript type definitions used by both the server and UI:

- Task, QueueItem, AgentResult, ReviewVerdict types
- Label constants (status/queued, status/merged, etc.)
- WebSocket event type definitions
- API request/response types
- Agent tool configuration types

This is a build-time dependency — types are compiled and imported by both server and UI. No runtime dependency between them.

## Project Structure

```
orchestrator/
├── packages/
│   ├── shared/                  ← shared types
│   │   └── src/
│   │       ├── types.ts
│   │       ├── labels.ts
│   │       └── events.ts
│   │
│   ├── server/                  ← orchestrator backend
│   │   └── src/
│   │       ├── index.ts         ← Fastify setup, entry point
│   │       ├── config.ts        ← configuration loading
│   │       ├── db.ts            ← SQLite setup and queries
│   │       ├── queue.ts         ← task queue (priority, ordering, deps)
│   │       ├── scheduler.ts     ← main loop (poll, fill slots, completions)
│   │       ├── docker.ts        ← container lifecycle management
│   │       ├── forgejo.ts       ← Forgejo API client
│   │       ├── git.ts           ← git operations
│   │       ├── workspace.ts     ← workspace preparation and cleanup
│   │       ├── agents/
│   │       │   ├── develop.ts   ← dev agent orchestration flow
│   │       │   └── review.ts    ← review agent orchestration flow
│   │       ├── routes/
│   │       │   ├── tasks.ts     ← task management endpoints
│   │       │   ├── settings.ts  ← configuration endpoints
│   │       │   ├── repos.ts     ← repository management endpoints
│   │       │   ├── tools.ts     ← agent tool endpoints
│   │       │   └── status.ts    ← system status endpoints
│   │       └── ws/
│   │           ├── dashboard.ts ← dashboard event stream
│   │           └── output.ts    ← agent log stream
│   │
│   └── ui/                      ← React SPA
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── api.ts           ← typed REST client
│           ├── ws.ts            ← typed WebSocket client
│           ├── store.ts         ← zustand state management
│           ├── views/
│           │   ├── Dashboard.tsx
│           │   ├── TaskDetail.tsx
│           │   ├── CreateTask.tsx
│           │   └── Settings.tsx
│           └── components/
│               ├── ActiveTask.tsx
│               ├── QueueList.tsx
│               ├── AgentOutput.tsx
│               ├── Timeline.tsx
│               └── AlertBanner.tsx
│
├── harness/
│   ├── harness-sdk.ts           ← TypeScript harness for SDK tools
│   └── harness-cli.sh           ← Bash harness for CLI tools
│
├── images/
│   ├── base/
│   │   └── Dockerfile           ← common base (git, jq, node, agent tools)
│   ├── node/
│   │   └── Dockerfile           ← Node.js runtime
│   ├── python/
│   │   └── Dockerfile           ← Python runtime
│   └── go/
│       └── Dockerfile           ← Multi-runtime
│
├── docker-compose.yml           ← orchestrator deployment
├── Dockerfile                   ← orchestrator container build
├── package.json                 ← workspace root
└── tsconfig.base.json
```

Uses npm workspaces for the monorepo.

## Full Dependency Inventory

### Backend (packages/server)

| Package | Purpose |
|---------|---------|
| `fastify` | HTTP server |
| `@fastify/websocket` | WebSocket support |
| `@fastify/static` | Serve UI build files |
| `@fastify/cookie` | Session cookie management |
| `@fastify/oauth2` | Forgejo OAuth2 authorization code flow |
| `dockerode` | Docker API client |
| `better-sqlite3` | SQLite driver |

Pino is included with Fastify (not a separate dependency). Webhook HMAC verification uses Node.js built-in `crypto` module.

### Frontend (packages/ui)

| Package | Purpose |
|---------|---------|
| `react` + `react-dom` | UI framework |
| `react-router-dom` | Client-side routing |
| `react-markdown` | Markdown preview in task creation |
| `zustand` | State management |
| `@dnd-kit/core` | Drag-and-drop for queue |
| `tailwindcss` | Styling |

### Dev/Build

| Package | Purpose |
|---------|---------|
| `typescript` | Language |
| `vite` | Frontend build |
| `tsx` | Run TypeScript directly in dev |

### Agent Container

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Claude Agent SDK (TypeScript) |
| `@anthropic-ai/claude-code` | Claude Code CLI (global install) |
| OpenCode binary | Alternative agent tool |

**Total: 7 runtime dependencies for backend, 6 for frontend.**

No ORM, no state management framework, no API schema generator, no CSS-in-JS.

## Database Schema

The `tasks.status` column stores the label name without the `status/` prefix (e.g., `queued`, `preparing`, `in-progress`, `in-review`, `merged`). This matches the Forgejo label suffix exactly, so converting between DB status and Forgejo label is: `'status/' + task.status`.

The `tasks.repo_id` is a foreign key to the `repos` table. All repo-level fields (`owner`, `name`, `base_branch`, `agent_tool`) are accessed via: `repo = db.getRepo(task.repo_id)`. The pseudocode in other documents uses `repo.base_branch`, `repo.owner`, `repo.name` etc. — these always come from the joined `repos` row.

The issue `title` is not stored in the `tasks` table. The REST API populates `issue_title` from the Forgejo API when practical (single-task endpoints like `GET /api/tasks/:id`), and falls back to a placeholder (`Issue #N`) in list responses to avoid N Forgejo API calls. This avoids stale data if the issue title is edited in Forgejo, at the cost of titles only appearing after the Forgejo API is reachable. The UI can fetch updated titles client-side for display purposes.

The following fields are held in memory on the task object during the active slot lifecycle. They do not need to survive a restart — startup recovery re-evaluates state from external sources:

| Field | Purpose | Set by | Reset on restart |
|---|---|---|---|
| `pre_review_sha` | Detect if review agent modified the branch | `launch_review_container` | Yes — recovery re-runs review |
| `current_attempt_id` | Links to the active `attempts` row | `start_attempt` | Yes — recovery looks up by composite key |
| `review_retry_count` | Tracks consecutive review agent failures | `on_review_agent_complete` | Yes — resets to 0 |

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  branch_name TEXT,
  pr_number INTEGER,
  status TEXT NOT NULL,  -- label suffix: 'queued', 'preparing', 'in-progress', etc.
  queue_position INTEGER,
  attempt INTEGER DEFAULT 1,
  max_attempts INTEGER DEFAULT 3,
  prep_failure_count INTEGER DEFAULT 0,
  agent_tool TEXT,       -- per-task override; NULL = use repo's configured tool
  model TEXT,            -- per-task override; NULL = use repo's model or global default
  container_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(issue_id)        -- one task per Forgejo issue
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_repo_id ON tasks(repo_id);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  attempt_number INTEGER,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  started_at TEXT,
  completed_at TEXT,
  log_path TEXT,
  feedback TEXT,
  model TEXT
  -- Cost tracking (input_tokens, output_tokens, cost_usd) was removed in
  -- schema v14. The harness layer recorded the user's intended model alias
  -- rather than the actual model id reported by the agent's stream, so the
  -- pricing lookup missed every time and cost was always 0. Rather than fix
  -- the bug + maintain a pricing table, the whole cost-tracking feature is
  -- gone. Use Anthropic's console for spend visibility.
);

CREATE INDEX idx_attempts_task_id ON attempts(task_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  base_branch TEXT DEFAULT 'main',
  agent_tool TEXT NOT NULL,
  install_steps TEXT NOT NULL DEFAULT '[]',   -- JSON array of typed { kind, cwd?, path? } entries; see InstallStep
  allow_script_steps INTEGER NOT NULL DEFAULT 0,  -- 1 = repo opted in to the `script` install-step kind
  container_memory_mb INTEGER,   -- per-repo override; NULL = use DEFAULT_CONTAINER_MEMORY_MB constant (4096)
  container_cpu_cores INTEGER,   -- per-repo override; NULL = use DEFAULT_CONTAINER_CPU_CORES constant (2)
  UNIQUE(owner, name)     -- one config per repo
);

CREATE TABLE agent_tools (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL,
  command_template TEXT,
  -- Flat key/value JSON. Forwarded as container env vars at launch on top
  -- of FORWARDED_KEYS so per-tool entries override host defaults on collision.
  env_vars TEXT NOT NULL DEFAULT '{}',
  -- Optional config file dropped into /repo before the agent runs. Both set
  -- together or both null. Used by tools (e.g. OpenCode) that read structured
  -- config from a file rather than env vars.
  config_file_path TEXT,
  config_file_content TEXT
  -- Provider credentials are forwarded from the orchestrator's host env into
  -- every container via a fixed FORWARDED_KEYS list (see credentials.ts).
  -- Tools no longer declare their own credentials.
);
```

### Schema Versioning

The `settings` table contains a `schema_version` row initialized to `1` on first run. On startup, the orchestrator checks the current version and runs any pending migrations sequentially:

```typescript
const CURRENT_SCHEMA_VERSION = 1;

function runMigrations(db: Database) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
  const version = row ? parseInt(row.value, 10) : 0;

  if (version < 1) {
    // Initial schema — created by CREATE TABLE IF NOT EXISTS statements above
    // Seed all default settings
    seedDefaultSettings(db);
    db.exec("UPDATE settings SET value = '1' WHERE key = 'schema_version'");
  }

  // Future migrations follow the same pattern:
  // if (version < 2) {
  //   db.exec('ALTER TABLE repos ADD COLUMN new_field TEXT');
  //   db.exec("UPDATE settings SET value = '2' WHERE key = 'schema_version'");
  // }
}
```

### Settings Inventory

All settings keys, their types, and defaults. Seeded on first run by `seedDefaultSettings()`. Editable via the Settings UI.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `schema_version` | integer | `1` | Schema migration version |
| `max_agent_memory_mb` | integer | `20480` | Host memory pool (MB) — sum of per-repo `container_memory_mb` across active tasks may not exceed this |
| `max_agent_cpu_cores` | integer | `10` | Host CPU pool (cores) — sum of per-repo `container_cpu_cores` across active tasks may not exceed this |
| `default_model` | string | `sonnet` | Default LLM model for agent tools |
| `last_shutdown` | string | `''` | Records how the orchestrator last exited (`graceful` or empty). Used by startup recovery to distinguish clean shutdown from crash. |

Compile-time constants (live in `packages/server/src/constants.ts` — not editable per-install):

| Constant | Value | Purpose |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `60` | Fallback reconciliation tick / Forgejo poll cadence. Webhooks drive the real-time path. |
| `DEFAULT_MAX_ATTEMPTS` | `7` | Default cap on dev/review cycles before a task is marked `failed`. Per-task override is editable from the Task Detail page. |
| `WORKSPACE_RETENTION_DAYS` | `7` | How long workspaces stick around after a task hits a terminal state, and how long an orphan workspace (no task row) must persist before the orphan-sweep deletes it. |
| `DRAIN_TIMEOUT_MINUTES` | `30` | Hard cap on how long the orchestrator's graceful shutdown waits for in-flight agent containers. Long-running tasks (per-tool timeouts can be 48 h) get SIGKILL'd at the cap; recovery handles them on the next boot. Must align with `stop_grace_period` in docker-compose.yml. |
| `STUCK_TASK_TIMEOUT_MULTIPLIER` | `2` | Multiplier on a task's per-tool timeout above which the alerts pass flags it as stuck. |
| `DEFAULT_CONTAINER_MEMORY_MB` | `4096` | Default agent container memory limit when a repo doesn't override it via `repos.container_memory_mb`. Heavy workloads (Rust, large Next.js, Bazel) need the per-repo override. |
| `DEFAULT_CONTAINER_CPU_CORES` | `2` | Default agent container CPU quota when a repo doesn't override it via `repos.container_cpu_cores`. |

Each migration is idempotent and runs inside the startup sequence before the scheduler starts. No external migration framework is needed — the schema is small enough that a sequential version check covers all foreseeable changes.

## Cost Considerations

### Anthropic API (Claude Agent SDK / Claude Code)

Per-task cost depends on model, task complexity, and codebase size:

| Model | Per Task (est.) | 20 tasks/day | Monthly (weekdays) |
|-------|----------------|--------------|-------------------|
| Sonnet | $2-10 | $40-200/day | $800-4,000 |
| Opus | $10-50 | $200-1,000/day | $4,000-20,000 |

**Recommendation:** use Sonnet for implementation, reserve Opus for complex architectural tasks or reviews. Model selection is configurable per task via the orchestrator.

### Local LLM (OpenCode)

Infrastructure cost only. No per-token charges. Quality depends on the model — smaller local models may produce lower quality code and require more rework cycles, potentially offsetting the cost savings.

### Infrastructure

The orchestrator and agent containers run on a single machine. Resource requirements scale with max concurrency:

| Concurrency | RAM (est.) | CPU (est.) |
|------------|-----------|-----------|
| 5 agents | 24 GB | 12 cores |
| 10 agents | 48 GB | 24 cores |
| 20 agents | 96 GB | 48 cores |

These are rough estimates assuming 4GB RAM and 2 CPU cores per agent container plus overhead for the orchestrator and OS.
