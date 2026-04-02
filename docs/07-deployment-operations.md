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
    image: codeberg.org/forgejo/forgejo:14
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

ENV UI_STATIC_PATH=/app/packages/ui/dist
ENV DATA_DIR=/data

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
      - workspaces:/workspaces
      - caches:/caches
    env_file:
      - .env

volumes:
  orchestrator-data:    # SQLite DB + config (no secrets — only task state and settings)
  workspaces:           # Git working directories
  caches:               # Dependency caches per repo
```

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

## Agent Base Images

Build agent base images on Machine B:

```bash
# Build base image
docker build -t orchestrator-agent-base:latest -f images/base/Dockerfile .

# Build runtime images
docker build -t orchestrator-agent-node:latest -f images/node/Dockerfile .
docker build -t orchestrator-agent-python:latest -f images/python/Dockerfile .
docker build -t orchestrator-agent-go:latest -f images/go/Dockerfile .
```

Images can also be pushed to Forgejo's built-in container registry for versioning.

## Backup Strategy

### Forgejo (Machine A)

The `./forgejo` directory contains everything: git repos, SQLite database, configuration. Back up this directory regularly. Forgejo also supports `gitea dump` for structured backups.

### Orchestrator (Machine B)

The `orchestrator-data` volume contains a single SQLite file. Copy it for backup:

```bash
docker cp orchestrator:/data/orchestrator.db ./backup/
```

The workspaces and caches volumes are transient and do not need backup.

## Disk Management

### Workspace Cleanup Policy

Workspaces (`/workspaces/issue-{id}/`) accumulate as tasks are processed. The orchestrator cleans them up based on task state:

| Task state | Cleanup action |
|---|---|
| `merged` | Workspace deleted immediately after merge |
| `failed` | Workspace retained for `workspace_retention_days` (default: 7), then deleted |
| `cancelled` | Workspace deleted immediately on cancellation |
| `awaiting-human-merge` | Workspace retained until the human merges or the task is cancelled |
| `awaiting-human-review` | Workspace retained until review completes |

A background cleanup job runs on the scheduler tick:

```
cleanup_workspaces():
  for dir in /workspaces/issue-*/:
    issue_id = extract from dir name
    task = db.get_task_by_issue(issue_id)

    if task is null:
      # Orphaned workspace (task deleted or unknown) — remove
      rm -rf dir

    if task.status == 'failed' AND task.completed_at < now - workspace_retention_days:
      rm -rf dir
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
    "total_human": "7.0 GB",
    "threshold_bytes": 53687091200,
    "threshold_human": "50 GB"
  }
}
```

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

### CLI harness prompt injection (Issue 11)

The CLI harness substitutes the task prompt (which includes the Forgejo issue body — user-provided text) into the command template via `envsubst`, then executes it via `bash -c`. If the issue body contains shell metacharacters (backticks, `$()`, semicolons), they could be interpreted as shell commands within the agent container.

This is mitigated by: (1) issue bodies are written by trusted users with Forgejo access, not external attackers; (2) the agent container already has access to the same API keys via environment variables; (3) the container is ephemeral with limited privileges (non-root user). However, for defense in depth, CLI tools that support file-based prompt input (e.g., `--prompt-file /task/prompt.md`) should use that instead of inline substitution. The SDK harness is not affected — it passes the prompt as a function argument, not a shell string.

### Docker Compose stop_grace_period coupling (Issue 12)

The `stop_grace_period` in docker-compose.yml is a static value (e.g., `35m`). The orchestrator's graceful shutdown drain timeout is dynamic: `agent_timeout_minutes + 5 minutes`, read from the settings table. If the admin increases `agent_timeout_minutes` via the UI without updating `stop_grace_period`, Docker Compose will SIGKILL the orchestrator before the drain completes, killing running agents.

**Action required:** when changing `agent_timeout_minutes`, also update `stop_grace_period` in docker-compose.yml to `(new timeout + 5)m` and run `docker compose up -d` to apply.

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
| `warn` | `disk_threshold` | Disk usage approaching or exceeding configured threshold (includes `usage_bytes`, `threshold_bytes`) |
| `warn` | `pre_agent_script_unusual` | Pre-agent script doesn't match known safe patterns |
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
