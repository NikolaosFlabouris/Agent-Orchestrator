# Deployment & Operations

## Overview

The entire system runs as three types of containers: Forgejo (persistent), the orchestrator (persistent), and agent containers (ephemeral). Deployment is via Docker Compose with minimal configuration.

## System Components

```
Containers running:
  1. Forgejo            (Machine A, persistent)
  2. Orchestrator       (Machine B, persistent)
  3. Agent containers   (Machine B, ephemeral, 0 to N)

Persistent storage:
  1. Forgejo data volume       (git repos, issues, database)
  2. Orchestrator data volume  (SQLite file, ~1MB)
  3. Workspaces volume         (git working directories, cleaned after merge)
  4. Dependency cache volume   (node_modules, pip cache, per-repo)

External dependencies:
  1. Anthropic API              (for Claude Agent SDK / Claude Code)
  2. Package registries         (npm, pypi — for agent dependency installs)
  3. Local LLM server           (optional, for OpenCode with local models)

Configuration:
  1. Concurrency and timeout settings (stored in SQLite, editable via UI)
  2. Repository and agent tool settings (stored in SQLite, editable via UI)

Secrets (loaded from .env, never stored in DB):
  1. Forgejo URL + API tokens (orchestrator and agent)
  2. Anthropic API key (or other agent tool credentials)
  3. OAuth2 client credentials (for UI authentication)
```

## Forgejo Deployment (Machine A)

```yaml
# docker-compose.yml (Machine A)
networks:
  forgejo:
    external: false

services:
  server:
    image: codeberg.org/forgejo/forgejo:16
    container_name: forgejo
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - TZ=Australia/Adelaide
    restart: always
    networks:
      - forgejo
    volumes:
      - ./forgejo:/data
    ports:
      - '3000:3000'
      - '222:22'
```

## Orchestrator Deployment (Machine B)

### Dockerfile

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/ui/package.json ./packages/ui/
RUN npm ci

# Build shared types
COPY packages/shared ./packages/shared
RUN npm run build -w packages/shared

# Build UI
COPY packages/ui ./packages/ui
RUN npm run build -w packages/ui

# Build server
COPY packages/server ./packages/server
RUN npm run build -w packages/server

EXPOSE 8080

CMD ["node", "packages/server/dist/index.js"]
```

### Docker Compose

```yaml
# docker-compose.yml (Machine B)
services:
  orchestrator:
    build: .
    container_name: orchestrator
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - orchestrator-data:/data
      - orchestrator-workspaces:/workspaces
      - orchestrator-caches:/caches
    env_file:
      - .env

volumes:
  orchestrator-data:          # SQLite DB + config (no secrets — only task state and settings)
  orchestrator-workspaces:    # Git working directories (agents mount per-task subpaths)
  orchestrator-caches:        # Dependency caches per repo (agents mount per-repo subpaths)
```

Workspaces and caches are named volumes; agent containers mount per-task /
per-repo subdirectories of the same volumes via volume-subpath mounts
(Docker Engine 26+ / API 1.45, verified by the orchestrator at boot). Named
volumes live on the Docker VM's native filesystem, so agent I/O is full
speed on every host OS — a host-folder bind mount on Docker Desktop
(Windows/macOS) goes through a 9P/gRPC-FUSE share that is pathologically
slow for dependency-heavy workloads. Swapping the two lines back to
`./workspaces:/workspaces` + `./caches:/caches` still works (the
orchestrator auto-detects bind mounts and reverts to host-path
translation), at the cost of that penalty.

### Environment File

All secrets are stored in a `.env` file alongside the docker-compose file. This file must not be committed to version control.

```bash
# .env (Machine B) — do not commit
FORGEJO_URL=http://forgejo-host:3000
FORGEJO_ORCHESTRATOR_TOKEN=tok_orchestrator_xxx
FORGEJO_AGENT_TOKEN=tok_agent_xxx
FORGEJO_WEBHOOK_SECRET=whsec_xxx
ANTHROPIC_API_KEY=sk-ant-xxx
FORGEJO_OAUTH_CLIENT_ID=xxx
FORGEJO_OAUTH_CLIENT_SECRET=xxx

# Optional: additional agent tool API keys
# OPENCODE_API_KEY=xxx
```

No secrets are persisted in SQLite. The database stores task state, queue ordering, repository configuration, and agent tool metadata (env var names, not values). Database backups contain no credentials.

### Docker Socket Access

The orchestrator mounts `/var/run/docker.sock` to create and manage agent containers as siblings on the same Docker daemon. This is the simplest model and avoids Docker TCP/TLS configuration.

The orchestrator container needs to run with a user that has access to the Docker socket (typically the `docker` group, GID 999 or similar depending on host configuration).

## Agent Network Configuration

```bash
docker network create agent-network
```

Agent containers use a standard Docker bridge network with full outbound access. Agents require connectivity to:

- **Forgejo** — git fetch/push using the agent credential
- **LLM APIs** — Anthropic API (api.anthropic.com) or local LLM servers on the LAN
- **Package registries** — npm, pypi, crates.io, etc.

Network isolation is not practical given these requirements. An `--internal` Docker network would block all of the above, and maintaining firewall allowlists for API endpoints and CDN-backed registries is fragile.

Security is enforced through credential scoping and Forgejo branch protection instead (see [01 - Forgejo Setup](./01-forgejo-setup.md) for details on token scopes and branch protection configuration).

## Agent Image

Build the unified agent image on Machine B:

```bash
docker build -t orchestrator-agent:latest -f images/agent/Dockerfile .
```

Or use the wrapper script (also creates the `agent-network` bridge):

```bash
./scripts/build-agent-images.sh
```

The image ships Node, Python, and Go toolchains together so a repo doesn't have to pick a language. Earlier orchestrator versions built a four-image hierarchy (`base`, `node`, `python`, `go`); a single image is simpler to maintain and supports polyglot repos. Images can be pushed to Forgejo's built-in container registry for versioning.

## Backup Strategy

### Forgejo (Machine A)

The `./forgejo` directory contains everything: git repos, SQLite database, configuration. Back up this directory regularly. Forgejo also supports `gitea dump` for structured backups.

### Orchestrator (Machine B)

The `orchestrator-data` volume contains a single SQLite file. Copy it for backup:

```bash
docker cp orchestrator:/data/orchestrator.db ./backup/
```

The same volume also holds `/data/archive` (run artifacts of completed
tasks — see [Run Artifact Archive](#run-artifact-archive)). Back it up with
the database if you care about historical agent logs:

```bash
docker cp orchestrator:/data/archive ./backup/
```

The workspaces and caches volumes are transient and do not need backup.
Because they are named volumes (not host folders), browse their contents
through the orchestrator container when debugging, e.g.
`docker exec orchestrator ls /workspaces` or
`docker cp orchestrator:/workspaces/4-issue-371/.output/progress.log .`.

**Upgrading a pre-volume install** (compose file with bind-mounted
`./workspaces` + `./caches`): no data migration is needed. Pick a moment
with no attempts running, then `docker compose down`, pull the new code,
`docker compose up -d --build`. The new volumes start empty — queued and
reworked tasks re-clone their workspaces automatically, and caches
re-download on each repo's next task (a one-time warm-up). Un-pushed
in-flight work in the old workspaces is not carried over. The old
`./workspaces` and `./caches` host folders are no longer referenced and can
be deleted. Beware that `docker compose down -v` now deletes the task
database volume along with the (re-creatable) workspaces and caches — use
plain `down`.

## Disk Management

### Workspace Cleanup Policy

Workspaces (`/workspaces/issue-{id}/`) accumulate as tasks are processed. The orchestrator runs a two-pass cleanup on every poll cycle, governed by the `WORKSPACE_RETENTION_DAYS` constant in `packages/server/src/constants.ts` (default: 7 days).

**Pass 1 — task-driven sweep:** for any task in a terminal state (`merged`, `failed`, `cancelled`, `reset`, `awaiting-human-*`, `needs-human-review`) whose `completed_at` is older than the retention window, the task's run artifacts are archived to `/data/archive/` and the corresponding `/workspaces/issue-N/` directory is then deleted. Same window applies uniformly to all terminal states — there is no "keep merged forever" carve-out. **Archiving vetoes deletion:** if the archive step fails the workspace is left in place (logged as `artifacts_archive_failed`) and the whole thing is retried on the next poll cycle — an undeleted workspace costs disk, a lost log is unrecoverable.

**Pass 2 — orphan sweep:** lists `/workspaces/` for `issue-N` directories whose N has no matching task row. If the directory's mtime is older than the retention window, it is deleted. Catches stranded workspaces from manual DB intervention, restored backups, or test runs. The mtime + retention buffer guarantees a freshly-launched workspace can't be swept (workspaces are mkdir'd after the task row is inserted).

```
cleanup_workspaces():
  cutoff = now - WORKSPACE_RETENTION_DAYS

  # Pass 1: task-driven
  for task in db.tasks where task.status in TERMINAL_STATUSES:
    if task.completed_at < cutoff:
      try archive_artifacts(task)      # → /data/archive/{repo_id}/issue-{n}/
      except: warn and skip this task  # retried next cycle; do NOT delete
      rm -rf /workspaces/issue-{task.issue_id}/

  # Pass 2: orphan sweep
  for dir in /workspaces/issue-*/:
    issue_id = extract from dir name
    if no task in db with that issue_id AND dir.mtime < cutoff:
      rm -rf dir
```

Pass 2 does not archive — an orphan directory has no task row to attribute artifacts to.

Resumption cost on a deleted workspace is one fresh `git clone` (~30s for a typical repo, plus a warm-cache dependency install since the per-repo `/caches/...` directory is shared and persists). No state is lost: the branch and PR live on Forgejo; the task row in the DB carries everything else, and the agent's own logs survive in the archive below.

### Run Artifact Archive

Attempt rows live in the database forever, but the files an agent produces live in the task workspace, which the sweep above deletes. Before that happens the four small text artifacts are copied onto the persistent `orchestrator-data` volume, so log-based analysis of historical runs ("why did model X fail on task Y three weeks ago?") keeps working.

**Location:** `/data/archive/{repo_id}/issue-{issue_id}/` — repo-scoped for the same reason workspaces are, since Forgejo issue numbers are per-repo. The root is the `ARCHIVE_ROOT` constant in `packages/server/src/constants.ts`, overridable via the `ARCHIVE_ROOT` env var (like `DB_PATH`) when running the server outside the container.

**Contents** — only these, copied out of the workspace's `.output/` (and `.task/` for `meta.json`); nothing else from the workspace is archived:

| File | Notes |
|---|---|
| `progress.log.gz` | The agent's progress log, gzipped — the only artifact that can reach megabytes. |
| `result.json` | Harness run result (status, usage, exit code). |
| `review.json` | Review verdict. Absent for attempts that never ran a review. |
| `meta.json` | Launch context snapshot (role, resolved harness/model). |

Files an attempt never produced are skipped (logged at debug level), so a missing `review.json` is normal rather than an error. Note that `progress.log` in the workspace holds the *latest* attempt only — the orchestrator rotates earlier attempts into `<workspace>/.output/archive/attempt-N-role/` at each launch, and those rotated copies are not archived.

**When it runs:** eagerly when a task reaches a terminal state (so a crash or volume loss between completion and the sweep can't lose the artifacts), and again immediately before the retention sweep deletes the workspace. Archiving is idempotent — the second pass overwrites each file with the current workspace copy, writing to a `.partial` file and renaming so an interrupted copy can never truncate an existing archive entry.

**Retention:** indefinite. There is no archive sweep. The size is bounded by (number of tasks × gzipped log), which is orders of magnitude below the workspaces it outlives; if it ever needs pruning, delete per-repo or per-issue directories by hand.

**Reading a log:** `GET /api/tasks/:id/log` (and the Download button in the UI) serves the workspace copy while it exists and transparently gunzips the archived copy once it doesn't — 404 only when the log is in neither place. `attempts.log_path` is re-pointed at the archived `progress.log.gz` when a task is archived, so the DB never references a deleted file. Directly:

```bash
docker exec orchestrator ls /data/archive/1/issue-371
docker exec orchestrator zcat /data/archive/1/issue-371/progress.log.gz | tail -50
```

### Dependency Cache Cleanup

Dependency caches (`/caches/{owner}-{repo}/`) persist indefinitely by design — they speed up every agent run. If disk space is constrained, caches for repos that haven't had a task in over 30 days can be removed manually or via the UI.

### Volume Usage Monitoring

The orchestrator tracks disk usage of the workspaces and caches volumes and exposes it via the `/api/status` endpoint:

```json
{
  "disk": {
    "workspaces_bytes": 5368709120,
    "workspaces_human": "5.0 GB",
    "caches_bytes": 2147483648,
    "caches_human": "2.0 GB",
    "total_bytes": 7516192768,
    "total_human": "7.0 GB"
  }
}
```

The orchestrator no longer raises an alert when these totals cross a threshold. Use OS-level disk monitoring (e.g. `df`, Prometheus node_exporter) for that — it measures actual filesystem free space, not just the orchestrator's two subdirectories.

The usage is checked on each scheduler tick by reading the volume mount sizes:

```typescript
const usage = execSync("du -sb /workspaces /caches 2>/dev/null || echo '0'");
```

When total disk usage exceeds the configured threshold (default: 50 GB), the orchestrator emits a warning alert to the UI.

## Resilience and Recovery

See [05 - Orchestrator Core](./05-orchestrator-core.md) for the full graceful shutdown, startup recovery, and Forgejo unavailability handling.

Key operational points:

- Docker Compose `stop_grace_period` should match `max_runtime_minutes + buffer` to allow graceful drain
- SQLite runs in WAL mode — crash-safe, auto-recovers on next open
- Restart never counts against a task's attempt budget

## Known Limitations

### CLI harness prompt injection (Issue 11 — resolved)

Early versions of the CLI harness inlined the task prompt (which includes the Forgejo issue body — user-provided text) into the command template via `envsubst` and then ran it through `bash -c`. Shell metacharacters in the prompt (backticks, `$()`, semicolons, unbalanced quotes) could be interpreted as shell commands inside the agent container, and in practice would cause the agent to never start when the issue body described code.

This is no longer possible. The harness now accepts only the `{{PROMPT_FILE}}` placeholder, which is substituted with the literal path `/task/prompt.md` before `bash -c`. The tool reads the file itself, so prompt content is never parsed as shell code. Existing tool definitions that used the legacy `${TASK_PROMPT}` placeholder are rewritten to the safe form by the schema v5 migration on startup. The SDK harness is unaffected — it passes the prompt as a function argument.

### Docker Compose stop_grace_period coupling (Issue 12)

The `stop_grace_period` in docker-compose.yml is a static value (e.g., `35m`). The orchestrator's graceful shutdown drain timeout is the `DRAIN_TIMEOUT_MINUTES` constant in `packages/server/src/constants.ts` (default 30 min). They must be aligned — `stop_grace_period` should be `(DRAIN_TIMEOUT_MINUTES + 5)m` to give the drain a small buffer before Docker SIGKILLs the orchestrator.

If you raise `DRAIN_TIMEOUT_MINUTES`, also raise `stop_grace_period` in docker-compose.yml and run `docker compose up -d` to apply. Per-tool `timeout_minutes` (which can go up to 48 h on free local servers) does NOT extend the drain — the drain is hard-capped at `DRAIN_TIMEOUT_MINUTES` and any agent still running at the cap gets SIGKILL'd. Startup recovery handles them on the next boot.

### Forgejo comment/label failure strategy (Issue 15)

Throughout the orchestrator, Forgejo API calls for posting comments (`forgejo.comment_on_issue`, `forgejo.comment_on_pr`) and updating labels (`forgejo.replace_label`) are non-critical — a failed comment doesn't affect the task's functional state. If Forgejo is briefly unreachable during these calls:

- **Label changes** (state transitions): these ARE critical. A failed label change means Forgejo's issue state doesn't match the DB. The orchestrator should retry label changes (up to 3 attempts with brief delay) before proceeding. If all retries fail, log an error — the DB is the source of truth and the fallback poll will eventually detect the mismatch.
- **Comments** (audit trail): these are informational. Log a warning on failure but don't block the flow. The comment is lost, but the state transition still completes. The DB and container state are the authoritative record.

### Image versioning (Issue 16)

Agent images are always tagged `:latest`. There is no version history or rollback mechanism. If a rebuilt image introduces a problem, the fix is to correct the Dockerfile and rebuild. For production stability, avoid frequent image rebuilds — only rebuild when adding new system-level dependencies or updating agent tools.

## Monitoring

### Health Indicators

The orchestrator exposes a `/api/status` endpoint with:

- Process uptime
- Forgejo connection status
- Active slot count / max concurrency
- Queue depth
- Last successful poll timestamp
- SQLite database size
- Disk usage: workspaces volume, caches volume, total, threshold
- Daily cost (sum of attempt costs today)

### Log Output

The orchestrator logs structured JSON to stdout (captured by Docker):

```bash
docker logs orchestrator --follow
```

Every log line is a single JSON object for machine parsing. Fields present on every line:

```json
{"ts": "2025-03-15T10:42:03.127Z", "level": "info", "event": "task_state_changed", "task_id": 42, "from": "preparing", "to": "in-progress", "attempt": 1}
```

| Field | Description |
|---|---|
| `ts` | ISO 8601 timestamp |
| `level` | `info`, `warn`, or `error` |
| `event` | Machine-readable event name (see table below) |
| `task_id` | Task ID (when applicable, omitted for system-level events) |
| Additional fields | Context-specific (e.g., `attempt`, `error`, `branch`, `container_id`) |

**Log events by level:**

| Level | Event | When |
|---|---|---|
| `info` | `task_state_changed` | Any state transition (includes `from`, `to`, `attempt`) |
| `info` | `container_started` | Agent container created and started (includes `container_id`, `image`) |
| `info` | `container_exited` | Agent container exited (includes `container_id`, `exit_code`, `duration_s`) |
| `info` | `pr_created` | PR created via Forgejo API (includes `pr_number`) |
| `info` | `pr_merged` | PR merged (includes `pr_number`) |
| `info` | `webhook_received` | Forgejo webhook processed (includes `event_type`, `action`, `issue_id`) |
| `info` | `scheduler_tick` | Scheduler tick completed (includes `active_slots`, `queue_depth`) |
| `info` | `startup_complete` | Orchestrator finished startup recovery |
| `info` | `shutdown_started` | Graceful shutdown initiated |
| `info` | `shutdown_complete` | Graceful shutdown finished |
| `warn` | `salvage_triggered` | Agent didn't push, orchestrator salvaging local work (includes `task_id`) |
| `warn` | `prep_failed_transient` | Workspace preparation failed, task re-queued (includes `error`, `retry_count`) |
| `warn` | `webhook_duplicate` | Duplicate webhook event skipped (includes `issue_id`, `existing_status`) |
| `warn` | `unexpected_branch` | Agent pushed to a branch name that doesn't match the expected name |
| `error` | `container_oom` | Agent container killed by OOM (includes `container_id`, `memory_limit`) |
| `error` | `forgejo_unreachable` | Forgejo API call failed (includes `endpoint`, `error`) |
| `error` | `push_failed` | Git push failed after retry (includes `branch`, `error`) |
| `error` | `result_missing` | result.json missing or corrupt after container exit |
| `error` | `prep_failed_permanent` | Workspace preparation failed 3 times, task marked as failed |
| `error` | `merge_failed` | PR merge failed unexpectedly (includes `pr_number`, `error`) |

### Alert Conditions

| Condition | Severity | Action |
|-----------|----------|--------|
| Task failed after max attempts | Error | Shown in UI, logged |
| Task stuck (running > 2x timeout) | Warning | Shown in UI |
| All slots full, queue growing | Info | Shown in UI |
| Forgejo connection lost | Error | Scheduler pauses, UI alert |
| Dev image build failed | Error | Shown in UI |
| Agent container OOM killed | Warning | Task retried, logged |
| Task awaiting human-merge/review > N hours | Warning | Shown in UI |
| Disk usage exceeds threshold | Warning | Shown in UI, logged |

## Operational Procedures

### Adding a New Repository

1. Create the repository in Forgejo
2. In the orchestrator UI Settings → Repositories → Add Repository
3. Set base branch, image type, agent tool, and pre-agent script
4. Create the appropriate labels in the Forgejo repo (or use org-wide labels)
5. First task for this repo will be slower (cold dependency cache)

### Changing Max Concurrency

Via UI Settings → Global → Max concurrent agents. Takes effect immediately. If reduced below current active count, no running tasks are stopped — the change takes effect as tasks complete.

### Updating Credentials

Edit the `.env` file on Machine B and restart the orchestrator (`docker compose restart orchestrator`). Credentials are loaded from environment variables at process startup — they are not stored in the database and cannot be changed via the UI. Running containers are not affected; the new credentials apply to containers created after the restart.

### Rebuilding Dev Images

Via UI Settings → Repositories → Rebuild Image. Triggers a `docker build` on Machine B. Running containers continue with the old image. New containers use the rebuilt image.
