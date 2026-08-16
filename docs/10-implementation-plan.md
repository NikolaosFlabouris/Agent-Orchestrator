# Implementation Plan

## Overview

The implementation is broken into 8 vertical slices. Each slice delivers a working piece end-to-end and can be validated independently. Slices build on each other — each assumes the previous slice is complete.

The mock agent image (from the testing strategy) is used throughout slices 2–4 to validate the orchestrator without LLM API costs.

## Slice 1: Foundation

**Goal:** The building blocks that everything else depends on — database, Forgejo client, Docker manager.

**Design docs:** 08 (schema, settings), 01 (Forgejo API), 03 (Docker container creation)

**Deliverables:**

1. **Project scaffolding**
   - npm workspace monorepo: `packages/shared`, `packages/server`, `packages/ui`
   - TypeScript configuration (`tsconfig.base.json`, per-package configs)
   - Install backend dependencies: `fastify`, `@fastify/websocket`, `@fastify/static`, `@fastify/cookie`, `@fastify/oauth2`, `dockerode`, `better-sqlite3`
   - Install frontend dependencies: `react`, `react-dom`, `react-router-dom`, `react-markdown`, `zustand`, `@dnd-kit/core`, `tailwindcss`
   - Install dev dependencies: `typescript`, `vite`, `tsx`, `vitest`
   - `packages/shared/src/types.ts` — Task, Attempt, Repo, Provider, Model, AgentProfile, Settings types matching the DB schema, plus the `ProviderKind` / `HarnessId` unions and their `PROVIDER_KINDS` / `HARNESS_IDS` const arrays
   - `packages/shared/src/labels.ts` — status label constants
   - `packages/shared/src/events.ts` — WebSocket event types
   - Configure Pino logger via Fastify's built-in integration (JSON-line structured logging to stdout)

2. **SQLite database layer** (`packages/server/src/db.ts`)
   - Schema creation (`CREATE TABLE IF NOT EXISTS` for `settings`, `repos`,
     `tasks`, `attempts`, `providers`, `models`, `agent_profiles`,
     `task_events`, `task_steps`)
   - Schema versioning (`runMigrations` with `schema_version` check; current
     target is `21`)
   - Settings seeding (`seedDefaultSettings` for the host pool keys; v21
     bootstrap seeds providers + models + a default Claude SDK profile and
     points `default_agent_profile_id` at it)
   - WAL mode and busy_timeout pragmas
   - Query helpers: `getTask`, `getTasks`, `getRepo`, `getProvider`,
     `getModel`, `getAgentProfile`, `getSetting`, `updateTaskRaw`,
     `insertAttempt`, `updateAttempt`

3. **Forgejo API client** (`packages/server/src/forgejo.ts`)
   - HTTP client using native `fetch` with the orchestrator token from `process.env`
   - All methods accept a `repo` object, extract `owner`/`name` internally
   - Methods: `getCurrentUser`, `getIssue`, `createIssue`, `commentOnIssue`, `closeIssue`, `replaceLabel`, `removeLabels`, `getBranch`, `listBranches`, `deleteBranch`, `createPullRequest`, `getPullRequest`, `mergePullRequest`, `commentOnPr`, `closePullRequest`
   - Error handling: throw typed errors with HTTP status and response body
   - Connection health check: `getCurrentUser` called at startup

4. **Docker manager** (`packages/server/src/docker.ts`)
   - dockerode client connected to `/var/run/docker.sock`
   - Methods: `createAgentContainer` (with image selection, entrypoint, mounts, env, resource limits, labels, user), `startContainer`, `stopContainer`, `removeContainer`, `waitForContainer`, `listContainers` (by label filter), `inspectContainer`
   - Container label convention: `managed-by=orchestrator`, `task-id={id}`

**Validation:** Database initialises with all tables and settings. Forgejo client can connect and call `getCurrentUser`. Docker manager can list containers.

---

## Slice 2: Core Loop (Headless)

**Goal:** The orchestrator can pick up tasks from the database, prepare workspaces, start containers, detect completion, and free slots. No UI, no webhooks — tasks inserted directly into the DB for testing.

**Design docs:** 05 (main loop, queue model, slot lifecycle, workspace preparation), 02 (state machine transitions)

**Deliverables:**

1. **Queue manager** (`packages/server/src/queue.ts`)
   - `fillSlots`: priority ordering (in-review without container → orphaned rework → FIFO queued)
   - Dependency gating: parse checklist items from issue body, check if referenced issues are closed via Forgejo API
   - Queue position management: sparse integer ordering, `MAX(queue_position) + 1` for new tasks
   - Concurrency limiter: per-task resources fit in remaining host pool (memory + CPU); per-tool provider concurrency limit also respected

2. **Workspace manager** (`packages/server/src/workspace.ts`)
   - `prepareWorkspace`: clone if new, `set-url` if existing (token rotation), checkout branch (new or rework), `verify_workspace_state`
   - Workspace state verification: abort stale rebase/merge, restore expected branch
   - Prep failure handling: `prep_failure_count`, transient → re-queue, permanent → fail
   - Git operations via `child_process.execFileSync`
   - Branch name generation: `agent/issue-{id}-{sanitized_title}`

3. **Scheduler** (`packages/server/src/scheduler.ts`)
   - Main tick loop: check completed containers → fill slots
   - Per-task profile resolution: walks `task → repo → settings.default_agent_profile_id → agent_profile → model → provider`, fetches the harness module from the code-defined registry, and calls `harness.buildInvocation` to produce the launch shape (agent_command, config_files, extra_env, resolved_model)
   - Container completion detection via `container.wait()` callbacks
   - 60-second fallback poll timer
   - Pause/resume control
   - Dispatch to `onDevAgentComplete` or `onReviewAgentComplete` based on role from `/task/meta.json`

4. **Mock agent image** (`images/test-mock/`)
   - Standalone Dockerfile (ubuntu:24.04 + git + jq — does not extend the agent base image, which is a Slice 3 deliverable)
   - `mock-harness.sh`: reads `meta.json`, creates a test file, commits, pushes, writes `result.json`
   - Supports develop and review roles, failure and timeout modes via meta.json flags (`mock_mode`, `mock_verdict`)

**Validation:** Insert a task row with `status: 'queued'` directly in the DB. The scheduler picks it up, prepares the workspace, starts a mock agent container, detects completion, reads result.json. Task transitions through `queued → preparing → in-progress`. Container is cleaned up. Slot is freed.

---

## Slice 3: Git Flow + Harness

**Goal:** Full task lifecycle — implementation, review, merge — works end-to-end with the mock agent.

**Design docs:** 04 (harness contract, harness code, prompt templates), 05 (post-agent verification, launch helpers, attempt tracking, cost tracking, merge flow)

**Deliverables:**

1. **In-container harness scripts** (`harness/`)
   - `harness-sdk.ts` (entrypoint for `runtime: 'sdk'` harnesses): read prompt, flock-protected install steps, invoke Agent SDK `query()` with `meta.model`, write result.json
   - `harness-cli.sh` (entrypoint for `runtime: 'cli'` harnesses): read prompt, flock-protected install steps, `bash -c "$AGENT_COMMAND"` against the literal `meta.agent_command` produced by the harness module, parse usage from stream-json (where present), write result.json
   - Both: handle timeout, failure, review.json verification for review role

2. **Code-defined harness registry** (`packages/server/src/harnesses/`)
   - `types.ts`: `HarnessSpec`, `HarnessInputs`, `HarnessInvocation`, `HarnessConfigFile`
   - `index.ts`: registry mapping each `HarnessId` to its `HarnessSpec`; `getHarness(id)` and `listHarnesses()`
   - One module per harness: `claude-sdk.ts`, `claude-code.ts`, `opencode.ts`, `pi.ts`. Each exports a `HarnessSpec` whose `buildInvocation` takes the resolved `(profile, model, provider)` tuple and returns `{ agent_command, config_files, extra_env, resolved_model }`. Adding a harness is a code change — there is no DB-side authoring surface.

3. **Provider-kind metadata** (`packages/server/src/providers/kinds.ts`)
   - `ProviderKindSpec` table: per-kind `display_name`, `requires_base_url`, `container_env_name` (the standard env var the agent CLI/SDK reads for this kind), `auth_optional`
   - `resolveProviderCredential(provider)` and `buildProviderEnv(provider)` helpers used by the scheduler at launch

4. **Agent image** (`images/agent/Dockerfile`)
   - Ubuntu 24.04, git, jq, curl, Node.js 22, Python 3, Go 1.24, all four agent CLIs / SDK (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-code`, `opencode-ai`, `@earendil-works/pi-coding-agent`)
   - Both harness scripts copied in
   - Non-root `agent` user (UID 1000)
   - No ENTRYPOINT — set per-task to `harness-sdk` or `harness-cli`

5. **Launch helpers** (in `packages/server/src/scheduler.ts`)
   - `launchDevContainer`: archive previous output, verify workspace, prepare workspace, resolve `task → profile → model → provider`, call `harness.buildInvocation`, assemble prompt.md and meta.json, write any harness config files into `/repo/`, create and start container, record attempt with `harness_id` + `model_id` snapshots
   - `launchReviewContainer`: same flow with review prompt, SHA recording

6. **Post-agent flows** (`packages/server/src/agents/develop.ts`, `review.ts`)
   - `onDevAgentComplete`: complete_attempt, post_dev_agent verification (branch check, salvage, PR creation), continue_to_review or handle_dev_failure
   - `onReviewAgentComplete`: complete_attempt, SHA check, process verdict (merge, rework, human review), review retry logic
   - `postDevAgent`: branch verification, unexpected branch detection, salvage (uncommitted + untracked + local commits), push, PR creation with error handling
   - `attemptMerge`: freshness check, merge with error handling, conflict → rework

7. **Attempt tracking**
   - `startAttempt`, `completeAttempt`
   - Output archiving before each new container launch

**Validation:** Insert a queued task. Mock dev agent runs, commits, pushes. Orchestrator verifies push, creates PR. Mock review agent runs, writes approved verdict. Orchestrator merges PR, closes issue. Task reaches `status/merged`. Verify the rework cycle: mock review rejects → dev agent reruns → review approves → merge.

---

## Slice 4: Resilience

**Goal:** The orchestrator handles crashes, restarts, and edge cases without losing work or corrupting state.

**Design docs:** 05 (graceful shutdown, startup recovery, cancellation, reset task)

**Deliverables:**

1. **Graceful shutdown** (`packages/server/src/shutdown.ts`)
   - SIGTERM/SIGINT handler: pause scheduler, drain running containers, process completed results, kill stragglers at deadline
   - Docker Compose `stop_grace_period` alignment

2. **Startup recovery** (`packages/server/src/recovery.ts`)
   - `onStartup`: verify Forgejo connection, recover orphaned containers, recover in-flight tasks
   - `recoverTask`: check remote branch, check local workspace, salvage or re-queue
   - Recovery decision matrix implementation
   - Attempt row recovery (lookup by composite key or create new)

3. **Cancellation** (`cancel_task`)
   - Stop container, delete remote branch, close PR, update labels, free slot

4. **Reset** (`reset_task`)
   - Stop container, delete branch, close PR, delete workspace, remove labels, reset counters

**Validation:** Start a task with mock agent. Kill the orchestrator process mid-execution. Restart. Verify the task is recovered (branch found on remote → continues to review, or local work salvaged, or re-queued). Test graceful shutdown: start a task, send SIGTERM, verify the drain waits for the container to finish and processes results before exiting. Test cancel and reset from various states.

---

## Slice 5: Web UI (Read-Only)

**Goal:** The UI displays system state in real-time. No actions yet — just monitoring.

**Design docs:** 06 (views, API, WebSocket, authentication), 08 (frontend stack)

**Deliverables:**

1. **Fastify server setup** (`packages/server/src/index.ts`)
   - REST API routes (tasks, settings, repos, providers, agent-profiles, status) — response schemas defined in doc 06. Each lives under its own module in `packages/server/src/routes/`.
   - Static file serving for the UI build (`@fastify/static`)
   - Cookie-based sessions (`@fastify/cookie`)
   - WebSocket endpoints (`@fastify/websocket`)
   - Pino structured logging (already configured via Fastify — use child loggers for task context)

2. **OAuth2 authentication**
   - `@fastify/oauth2` plugin configured with Forgejo OAuth2 endpoints
   - Callback route exchanges code for token, stores in signed cookie (access token, refresh token, expiry)
   - Token refresh on expiry via the plugin's refresh mechanism
   - Auth middleware for all `/api/*` routes — returns 401 if no valid session

3. **Vite + React setup** (`packages/ui/`)
   - Vite config producing static build output
   - `react-router-dom` with routes: `/` (Dashboard), `/tasks/:id` (TaskDetail), `/tasks/new` (CreateTask), `/settings` (Settings)
   - Tailwind CSS configuration

4. **Dashboard view** (`packages/ui/src/views/Dashboard.tsx`)
   - Header bar: status, slots, queue depth
   - Active tasks section
   - Queue section (read-only for now)
   - Recent completions section
   - Alert banner

5. **Task detail view** (`packages/ui/src/views/TaskDetail.tsx`)
   - Task header with status, PR link, Forgejo link
   - Timeline (read-only)
   - Agent output panel with live WebSocket streaming
   - Attempt history

6. **WebSocket client** (`packages/ui/src/ws.ts`)
   - Dashboard connection: snapshot on connect, incremental events, exponential backoff reconnection
   - Agent output stream: replay + live, `stream_complete` handling

7. **State management** (`packages/ui/src/store.ts`)
   - zustand store: tasks, status, alerts
   - Updated from WebSocket events
   - Initial load from snapshot

**Validation:** Start the orchestrator with some tasks in various states. Open the UI. Verify the dashboard shows correct state. Start a mock agent task and verify the agent output streams live. Kill and reconnect the WebSocket — verify snapshot replaces stale state.

---

## Slice 6: Web UI (Interactive)

**Goal:** The UI can create tasks, manage the queue, and perform all actions.

**Design docs:** 06 (task creation, settings, actions, API schemas)

**Deliverables:**

1. **Task creation view** (`packages/ui/src/views/CreateTask.tsx`)
   - "Create and queue" mode: repo selector, title, description textarea with markdown preview (`react-markdown`), agent profile override, max attempts, human-merge/human-review toggles
   - "Queue existing" mode: repo selector, issue browser (via `/api/repos/:id/issues`), same overrides
   - Dependency checklist support in description (standard markdown `- [ ] #N` syntax, rendered in preview)

2. **Queue management**
   - Drag-and-drop reordering (`@dnd-kit/core`)
   - PATCH `/api/tasks/:id` with `action: reorder`

3. **Task actions**
   - Cancel, Force Approve, Force Fail, Reset buttons
   - Context-dependent visibility based on task state
   - Confirmation dialogs for destructive actions (cancel, reset, force-fail)
   - PATCH `/api/tasks/:id` with action payload

4. **Settings view** (`packages/ui/src/views/Settings.tsx`) — five tabs
   - **Global Settings**: host pool (`max_agent_memory_mb`, `max_agent_cpu_cores`) and `default_agent_profile_id` picker. Most defaults live in `packages/server/src/constants.ts` (poll interval, default max attempts, workspace retention, drain timeout, stuck-task multiplier, default container memory/CPU).
   - **Repositories**: list with add/edit/remove — `GET/POST/PATCH /api/repos` with full schema (doc 06). Per-repo config: base branch, default `agent_profile_id` (nullable), `install_steps` (typed-kind dropdown + cwd), `allow_script_steps` toggle, container memory / CPU (nullable = compile-time defaults), preferred merge strategy.
   - **Providers & Models**: nested layout — `GET/POST/PATCH/DELETE /api/providers` for the outer list, `GET/POST /api/providers/:id/models` and `PATCH/DELETE /api/models/:pk` for the inner one. Per-kind form components keyed off `GET /api/provider-kinds`.
   - **Agent Profiles**: list with add/edit/remove — `GET/POST/PATCH/DELETE /api/agent-profiles`, harness dropdown driven by `GET /api/harnesses`, model picker scoped to the harness's `supported_provider_kinds`. Per-harness `config_json` form (one React component per harness id).
   - **Credentials (read-only)**: orchestrator-only env vars from `ORCHESTRATOR_ENV_VARS`. Provider credentials are configured per-provider on the Providers & Models tab.
   - Forgejo connection status surfaced in the header (not a tab).
   - Image rebuild trigger per repo (`POST /api/repos/:id/rebuild`).

5. **Pause/resume**
   - Dashboard header button
   - POST `/api/status/pause` and `/api/status/resume`

**Validation:** Create a task via the UI. Verify it appears in the queue. Drag to reorder. Cancel a queued task. Create a task that runs to completion. Reset a failed task. Change settings and verify they take effect on the next task. Add a new repo configuration and queue a task for it.

---

## Slice 7: Forgejo Integration

**Goal:** The orchestrator automatically detects new tasks from Forgejo and stays in sync with external changes.

**Design docs:** 05 (webhooks, fallback polling, idempotency), 01 (webhook registration)

**Deliverables:**

1. **Webhook endpoint** (`packages/server/src/routes/webhooks.ts`)
   - `POST /webhooks/forgejo`
   - HMAC-SHA256 signature verification using Node.js built-in `crypto` module — `FORGEJO_WEBHOOK_SECRET` from `process.env`. Reject with 401 on failure, log `event=webhook_signature_invalid`
   - Event handlers: issue opened/labeled, issue closed, PR merged (see doc 05 event table)
   - Idempotency: check `db.getTaskByIssue` before inserting, validate state transitions, skip duplicates with warning log
   - Trigger immediate scheduler tick on relevant events

2. **Webhook registration**
   - On `POST /api/repos` (adding a new repo): auto-register webhook via Forgejo API
   - On repo removal: delete webhook
   - On startup: verify existing webhooks match the current orchestrator URL

3. **Fallback polling** (`packages/server/src/polling.ts`)
   - 60-second interval (`POLL_INTERVAL_SECONDS` constant in `packages/server/src/constants.ts`)
   - Query Forgejo for issues with `status/queued` label
   - Detect external state changes (manual label edits, issue closes, PR merges)
   - Same idempotency checks as webhook handlers

**Validation:** Create an issue in Forgejo directly (not via the orchestrator UI) with the `status/queued` label. Verify the orchestrator picks it up via webhook. Close an issue externally — verify the orchestrator detects it on the next poll. Merge a PR manually — verify the orchestrator marks the task as merged. Restart the orchestrator — verify the fallback poll catches any events missed during downtime.

---

## Slice 8: Testing

**Goal:** Automated test coverage for the core logic, integration boundaries, and end-to-end lifecycle.

**Design docs:** 09 (testing strategy, mock agent, test structure)

**Deliverables:**

1. **Unit tests** (`packages/server/src/__tests__/unit/`)
   - `state-machine.test.ts` — valid/invalid transitions, terminal states, override labels
   - `queue.test.ts` — priority ordering, FIFO, reordering, dependency gating
   - `change-detection.test.ts` — uncommitted, untracked, local commits, no work
   - `prompt-assembly.test.ts` — dev/review templates, variable substitution, feedback inclusion
   - `branch-naming.test.ts` — sanitization, git naming rules, truncation
   - `harnesses.test.ts` — each harness's `buildInvocation` against a representative provider+model+config tuple; `validateConfig` rejects malformed knobs; harness↔provider mismatch throws at launch with a clear message

2. **Integration tests** (`packages/server/src/__tests__/integration/`)
   - `forgejo-client.test.ts` — real Forgejo container, CRUD on repos/issues/labels/PRs, branch protection
   - `docker-lifecycle.test.ts` — real Docker socket, container create/start/wait/remove, label filters
   - `git-operations.test.ts` — clone, fetch, checkout, commit, push, branch protection enforcement
   - `harness-contract.test.ts` — build mock image, run container, verify result.json always written, verify review.json, verify timeout
   - Test Forgejo container via `test/docker-compose.test.yml`
   - Test fixture provisioning (`test/setup.ts`)

3. **End-to-end tests** (`packages/server/src/__tests__/e2e/`)
   - `task-lifecycle.test.ts` — full happy path with mock agent: queue → implement → review → merge
   - Rework variant: review rejects → rework → review approves → merge
   - Timeout variant: mock agent sleeps → salvage → review
   - Cancel variant: cancel mid-execution → verify cleanup
   - Recovery variant: kill orchestrator → restart → verify recovery
   - Dependency variant: two tasks with dependency → verify ordering

**Validation:** `npm test` passes. Unit tests run on every commit (fast, no dependencies). Integration tests run with Docker available. E2e tests run against a full test environment with Forgejo.

---

## Implementation Notes

**Each slice should be implemented sequentially** — slice N depends on slice N-1. However, the UI slices (5–6) and the Forgejo integration (7) are somewhat independent of each other and could be parallelised after slice 4.

**The mock agent image is the key enabler** — build it in slice 2 and use it for all validation through slice 7. Only connect real LLM agents (Claude, OpenCode) after the orchestrator is proven stable with mock agents.

**Testing (slice 8) can be built incrementally** — write unit tests for each slice's logic as you build it, rather than saving all testing for the end. The slice 8 deliverable is about filling gaps and running the full suite, not starting from zero.
