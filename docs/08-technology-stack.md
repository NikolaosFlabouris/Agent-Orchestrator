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

- Task, Attempt, Repo, Provider, Model, AgentProfile, Settings types
- `ProviderKind` and `HarnessId` string-literal unions plus the matching
  `PROVIDER_KINDS` / `HARNESS_IDS` const arrays for runtime validation
- Label constants (status/queued, status/merged, etc.)
- WebSocket event type definitions
- API request/response types

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
│   │       ├── workspace.ts     ← workspace preparation and cleanup
│   │       ├── credentials.ts   ← orchestrator-only env var inventory
│   │       ├── agents/
│   │       │   ├── develop.ts   ← dev agent orchestration flow
│   │       │   └── review.ts    ← review agent orchestration flow
│   │       ├── harnesses/       ← code-defined harness registry
│   │       │   ├── index.ts     ← REGISTRY of HarnessSpec by HarnessId
│   │       │   ├── types.ts     ← HarnessSpec / HarnessInputs / HarnessInvocation
│   │       │   ├── claude-sdk.ts
│   │       │   ├── claude-code.ts
│   │       │   ├── opencode.ts
│   │       │   └── pi.ts
│   │       ├── providers/
│   │       │   └── kinds.ts     ← per-kind metadata + container env-var resolution
│   │       ├── routes/
│   │       │   ├── tasks.ts            ← task management endpoints
│   │       │   ├── settings.ts         ← global settings endpoints
│   │       │   ├── repos.ts            ← repository management endpoints
│   │       │   ├── providers.ts        ← providers + nested models endpoints
│   │       │   ├── agent-profiles.ts   ← agent profiles + harness registry endpoints
│   │       │   └── status.ts           ← system status endpoints
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
│   └── agent/
│       └── Dockerfile           ← unified orchestrator-agent:latest (Node, Python, Go,
│                                  agent CLIs and SDK, both harnesses)
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
| `@anthropic-ai/claude-agent-sdk` | Claude Agent SDK (TypeScript), used by the `claude-sdk` harness |
| `@anthropic-ai/claude-code` | Claude Code CLI, used by the `claude-code` harness |
| `opencode-ai` | OpenCode CLI, used by the `opencode` harness |
| `@earendil-works/pi-coding-agent` | pi CLI, used by the `pi` harness |

**Total: 7 runtime dependencies for backend, 6 for frontend.**

No ORM, no state management framework, no API schema generator, no CSS-in-JS.

## Database Schema

The `tasks.status` column stores the label name without the `status/` prefix (e.g., `queued`, `preparing`, `in-progress`, `in-review`, `merged`). This matches the Forgejo label suffix exactly, so converting between DB status and Forgejo label is: `'status/' + task.status`.

The `tasks.repo_id` is a foreign key to the `repos` table. All repo-level fields (`owner`, `name`, `base_branch`, `agent_profile_id`, etc.) are accessed via: `repo = db.getRepo(task.repo_id)`. The pseudocode in other documents uses `repo.base_branch`, `repo.owner`, `repo.name` etc. — these always come from the joined `repos` row.

The agent-launch configuration is composed from three first-class tables —
`providers` (connection identity), `models` (provider-scoped model_ids), and
`agent_profiles` (the operator-composed `(harness_id, model_pk, config_json,
timeout_minutes)` row that tasks reference). Each workflow stage resolves
its own profile chain at launch. Implementation (develop):
`tasks.agent_profile_id → repos.agent_profile_id →
settings.default_agent_profile_id → agent_profiles → models → providers`.
Review: `tasks.review_agent_profile_id → repos.review_agent_profile_id →
settings.default_review_agent_profile_id → <the implementation chain>` —
when no review profile is configured anywhere, review runs with the same
profile that implemented. Harnesses themselves are code-defined (no
DB-side registration); a profile just names which one of the four shipped
harness ids it uses.

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
  max_attempts INTEGER DEFAULT 7,
  prep_failure_count INTEGER DEFAULT 0,
  -- Per-task implementation-stage profile override. NULL inherits from
  -- repos.agent_profile_id, which inherits from
  -- settings.default_agent_profile_id. RESTRICT on delete: operator must
  -- reassign or unset before deleting the profile.
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  -- Per-task review-stage profile override (schema v25). NULL inherits
  -- from repos.review_agent_profile_id → settings.default_review_agent_
  -- profile_id → the task's effective implementation profile.
  review_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
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
  -- Snapshot of the model_id and harness_id resolved at attempt-launch time.
  -- Stored on the attempt so audit records survive subsequent edits to the
  -- agent profile, model row, or any of the upstream FK targets.
  model_id TEXT,
  harness_id TEXT,
  -- Snapshot of profile.timeout_minutes at attempt-launch time (added in
  -- schema v22). Lets the stuck-task alert and the orchestrator-side
  -- timeout kill use the threshold in effect at launch rather than a live
  -- profile read; consumers fall back to a live read when this is NULL.
  timeout_minutes_snapshot INTEGER
  -- Historical note: schema v14 dropped cost / token tracking
  -- (input_tokens, output_tokens, cost_usd columns plus the model_pricing
  -- setting and dashboard daily-cost tile). The harness layer recorded the
  -- user's intended model alias rather than the actual stream-reported
  -- model id, so the pricing lookup always missed and cost was always 0.
  -- Rather than fix the bug + maintain a hand-curated pricing table, the
  -- feature was removed; use the provider's own console for spend.
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
  -- Per-repo default implementation-stage profile. NULL falls back to
  -- settings.default_agent_profile_id at task-launch time.
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  -- Per-repo default review-stage profile (schema v25). NULL falls back
  -- to settings.default_review_agent_profile_id, then the implementation
  -- profile.
  review_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  install_steps TEXT NOT NULL DEFAULT '[]',   -- JSON array of typed { kind, cwd?, path? } entries; see InstallStep
  allow_script_steps INTEGER NOT NULL DEFAULT 0,  -- 1 = repo opted in to the `script` install-step kind
  container_memory_mb INTEGER,   -- per-repo override; NULL = use DEFAULT_CONTAINER_MEMORY_MB constant (4096)
  container_cpu_cores INTEGER,   -- per-repo override; NULL = use DEFAULT_CONTAINER_CPU_CORES constant (2)
  merge_strategy TEXT NOT NULL DEFAULT 'squash',  -- 'squash' | 'merge' | 'rebase'
  UNIQUE(owner, name)     -- one config per repo
);

-- Provider: concrete connection identity for an LLM endpoint. Cloud kinds
-- (anthropic, openai, gemini, …) are typically singletons; self-hosted
-- kinds (openai-compatible) can have multiple instances (one row per server).
CREATE TABLE providers (
  id TEXT PRIMARY KEY,                -- operator-authored stable id
  display_name TEXT NOT NULL,
  -- One of: anthropic | claude-subscription | openai | gemini | mistral |
  -- deepseek | openrouter | openai-compatible. Determines credential shape, the
  -- container env var name (see providers/kinds.ts), default endpoint,
  -- and which harnesses can target this provider.
  kind TEXT NOT NULL,
  -- Per-provider concurrency cap (an upstream LLM constraint, e.g. an API
  -- rate-limit bucket or a single self-hosted GPU box). 0 means "paused" (no
  -- task using this provider launches). Independent from the host
  -- resource pool which gates hardware capacity.
  concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
  -- Connection URL. NULL for cloud kinds (uses kind's default endpoint).
  -- REQUIRED for self-hosted kinds (openai-compatible).
  base_url TEXT,
  -- Inline secret (bearer/basic auth token for a self-hosted endpoint, or a cloud API key when
  -- the operator is multi-instancing a kind without env-var indirection).
  -- NULL when api_key_env_var is used or no auth needed. Stored as plaintext.
  auth_token TEXT,
  -- Name of the orchestrator-side env var holding this provider's API key
  -- (e.g. 'ANTHROPIC_API_KEY'). At launch the orchestrator reads from its
  -- own env and exports the value into the agent container under the
  -- kind's standard name (e.g. ANTHROPIC_API_KEY for kind=anthropic).
  api_key_env_var TEXT,
  notes TEXT
);

-- Models: provider-scoped model identifiers. Composite uniqueness on
-- (provider_id, model_id); agent_profiles reference the surrogate PK.
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  -- Bare model identifier as the inference endpoint expects, without any
  -- provider prefix (e.g. 'claude-sonnet-4-6', 'qwen2.5-coder:14b').
  -- Harnesses that need '<provider>/<model>' form prefix at launch time.
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- Context window (tokens) to drive this model with. NULL = unset, i.e.
  -- the harness applies its own default (pi's is 128,000). Operator-
  -- supplied because only they know a self-hosted server's --ctx-size.
  context_window INTEGER,
  UNIQUE(provider_id, model_id)
);

CREATE INDEX idx_models_provider_id ON models(provider_id);

-- Agent profiles: the operator-composed pairing that tasks reference.
-- Pairs a code-defined harness with a (provider, model) and any
-- harness-specific knobs.
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,                  -- operator-authored stable id
  display_name TEXT NOT NULL,
  -- One of the code-defined harness ids: claude-sdk | claude-code |
  -- opencode | pi. Adding a harness is a code change — see
  -- packages/server/src/harnesses/.
  harness_id TEXT NOT NULL,
  -- FK to the model surrogate PK. The provider is reachable via the model.
  model_pk INTEGER NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  -- Harness-specific config (typed knobs the harness understands). The
  -- harness module owns its schema and validates on save via
  -- HarnessSpec.validateConfig.
  config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)),
  -- Wall-clock timeout (minutes) for any agent run using this profile.
  timeout_minutes INTEGER NOT NULL DEFAULT 2880
);

CREATE INDEX idx_agent_profiles_model_pk ON agent_profiles(model_pk);
```

The embedded MCP Authorization Server adds three further tables —
`mcp_oauth_clients` (DCR registrations), `mcp_oauth_codes` (PKCE-bound
authorization codes), and `mcp_oauth_refresh` (rotating refresh-token
families) — introduced in schema v24. Their full DDL and token model live
in [13 - MCP Endpoint](./13-mcp-endpoint.md); they are independent of the
task-orchestration tables above.

### Schema Versioning

The `settings` table contains a `schema_version` row that the orchestrator
bumps as it applies migrations. On startup it checks the current version
and runs any pending migrations sequentially. The current version is
**`24`**.

A fresh install does **not** replay the historical migration chain. The
original 21-step chain was collapsed into a single `createTables` block
(commit `7e5fe33`), so a new database is created directly at the current
shape and stamped with `CURRENT_SCHEMA_VERSION`. v21 is therefore the
baseline (`MIN_MIGRATABLE_VERSION`); only forward migrations from v21 live
as `if (version < N)` blocks. The orchestrator refuses to boot against a DB
whose `schema_version` is **newer** than it supports (binary was
downgraded) or **older** than `MIN_MIGRATABLE_VERSION` (no migration code
present — reset the DB or restore a newer backup).

The v21 baseline replaced the legacy `agent_tools` row with the three-layer
`providers` / `models` / `agent_profiles` composition, swapped
`tasks.agent_tool` + `tasks.model` for `tasks.agent_profile_id`, swapped
`repos.agent_tool` for `repos.agent_profile_id`, renamed `attempts.model`
to `attempts.model_id`, added `attempts.harness_id`, dropped
`settings.default_model` in favour of `settings.default_agent_profile_id`,
and seeded a bootstrap Claude SDK profile so a fresh install with
`ANTHROPIC_API_KEY` set in `.env` boots into a usable state.

Forward migrations since the baseline:

| Version | Change |
|---|---|
| `22` | Add `attempts.timeout_minutes_snapshot` — snapshots `profile.timeout_minutes` onto the attempt row so the stuck-task alert (and the orchestrator-side timeout kill) uses the threshold in effect at launch, not the live profile value. Nullable; consumers fall back to a live read when absent. |
| `23` | Seed the **Claude Subscription** provider (kind `claude-subscription`), three Claude models, and a ready-to-use `default-claude-code-subscription` profile pairing the `claude-code` harness with Sonnet. Operators with an Anthropic Pro/Max subscription set `CLAUDE_CODE_OAUTH_TOKEN` and switch to it — no manual provider authoring needed. Idempotent (`INSERT OR IGNORE`). |
| `24` | Add the three **MCP OAuth** tables (`mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_refresh`) backing the embedded Authorization Server at `/mcp/oauth/*`. Idempotent `CREATE TABLE IF NOT EXISTS` DDL for existing installs (fresh installs get them via `createTables`). |
| `25` | Add `review_agent_profile_id` to **tasks** and **repos** (per-stage agent profiles). Nullable; existing rows stay NULL so review keeps inheriting the implementation profile. Idempotent via a `pragma_table_info` column-existence guard. The matching `default_review_agent_profile_id` settings key needs no migration (key/value table; absent = unset). |

```typescript
const CURRENT_SCHEMA_VERSION = 25;
const MIN_MIGRATABLE_VERSION = 21;

function runMigrations(db: Database) {
  const version = readSchemaVersion(db); // 0 if no row → fresh install

  if (version === 0) {
    // Fresh install: createTables already produced the current shape.
    // Seed settings + bootstrap providers/models/profile, then stamp the
    // current version — all in one transaction (rolls back on any throw).
    seedDefaultSettings(db);
    seedBootstrapProfile(db);
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    return;
  }

  if (version > CURRENT_SCHEMA_VERSION) throw new Error("DB newer than binary — downgraded?");
  if (version < MIN_MIGRATABLE_VERSION) throw new Error("DB predates lowest migratable version");

  // Forward migrations. Each `if (version < N)` block is a single ALTER (or
  // idempotent DDL/seed) wrapped in one transaction together with the final
  // schema_version write, so a partial apply rolls back and retries cleanly
  // on the next boot.
  if (version < CURRENT_SCHEMA_VERSION) {
    db.transaction(() => {
      if (version < 22) { /* ALTER TABLE attempts ADD COLUMN timeout_minutes_snapshot */ }
      if (version < 23) { /* seedClaudeSubscription(db) */ }
      if (version < 24) { /* CREATE TABLE IF NOT EXISTS mcp_oauth_* */ }
      if (version < 25) { /* ALTER TABLE tasks/repos ADD COLUMN review_agent_profile_id (guarded) */ }
      setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    })();
  }
}
```

### Settings Inventory

All settings keys, their types, and defaults. Seeded on first run by `seedDefaultSettings()` and the v21 bootstrap. Editable via the Settings UI.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `schema_version` | integer | `25` | Schema migration version |
| `max_agent_memory_mb` | integer | `20480` | Host memory pool (MB) — sum of per-repo `container_memory_mb` across active tasks may not exceed this |
| `max_agent_cpu_cores` | integer | `10` | Host CPU pool (cores) — sum of per-repo `container_cpu_cores` across active tasks may not exceed this |
| `default_agent_profile_id` | string | `default-claude-sdk` | Fallback implementation-stage profile when neither task nor repo specifies one. The v21 bootstrap seeds a Claude SDK + Sonnet profile under this id. |
| `default_review_agent_profile_id` | string | *(unset)* | Fallback review-stage profile. Absent by default — review then falls back to the effective implementation profile. |
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

## Infrastructure Sizing

The orchestrator and agent containers run on a single machine. Resource requirements scale with max concurrency:

| Concurrency | RAM (est.) | CPU (est.) |
|------------|-----------|-----------|
| 5 agents | 24 GB | 12 cores |
| 10 agents | 48 GB | 24 cores |
| 20 agents | 96 GB | 48 cores |

These are rough estimates assuming 4GB RAM and 2 CPU cores per agent container plus overhead for the orchestrator and OS.

API spend (for paid providers like Anthropic, OpenAI, etc.) is not tracked by the orchestrator — use the provider's own console. See the historical note in the `attempts` schema above for the design rationale.
