# Agent Container Environment

## Overview

Each agent task runs in its own isolated Docker container. Containers are ephemeral — they start, the agent works, and they are destroyed. The orchestrator manages the full container lifecycle via the Docker API.

## Design Decision: Container Per Agent

A single container per agent (rather than multiple agents sharing a container) was chosen for:

- **Full isolation.** One rogue agent cannot affect others. Memory and CPU limits are enforced per container via Docker's native resource constraints.
- **Clean lifecycle.** Container starts, agent works, container dies. No shared state, no environment pollution.
- **Simple scaling.** More parallelism = more containers. The limit is host resources, controlled by the orchestrator's concurrency pool.
- **Reproducibility.** Every agent starts from the same known-good image state.
- **Low complexity.** No in-container supervisor, no worktree management, no process isolation hacks.

The alternative — a shared dev container per repo using git worktrees — was rejected because autonomous agents can install packages globally, modify shared config, consume all resources, or corrupt shared caches. The isolation burden would effectively mean rebuilding container semantics inside a container.

## Dev Image Strategy

A **single agent image** — `orchestrator-agent:latest` — ships all three language toolchains (Node, Python, Go) plus the harnesses and agent CLIs. Every repo runs in the same image; polyglot repos work without configuration. Earlier versions of the orchestrator built a four-image hierarchy (`base`, `node`, `python`, `go`) and selected per-repo via `repos.image_type`; that column was removed in schema v8 because the per-language partitioning added a forced choice without buying meaningful isolation.

### Single Image

```dockerfile
# images/agent/Dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    jq \
    curl \
    ca-certificates \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Node.js (required by the Agent SDK harness, also serves as the Node toolchain)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python toolchain
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Go toolchain (keep >= the highest Go version any registered repo requires).
# GOPATH is /home/agent/go; GOMODCACHE stays at its default ($GOPATH/pkg/mod),
# which is the persistent bind-mounted module cache.
RUN curl -fsSL https://go.dev/dl/go1.26.5.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/agent/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"

# GitHub CLI + shellcheck (repo setup scripts gate on these as required tooling)
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh shellcheck \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs and SDK (npm-distributed)
RUN npm install -g @anthropic-ai/claude-code \
    && npm install -g opencode-ai \
    && npm install -g @mariozechner/pi-coding-agent \
    && npm install -g @anthropic-ai/claude-agent-sdk

COPY harness/harness-sdk.ts /usr/local/bin/harness-sdk.ts
COPY harness/harness-cli.sh /usr/local/bin/harness-cli
RUN chmod +x /usr/local/bin/harness-cli

# Non-root agent user (UID/GID 1000)
RUN groupadd -g 1000 agent && \
    useradd -u 1000 -g agent -m -s /bin/bash agent
# Pre-create the Go tree and cache root, agent-owned. Otherwise Docker
# auto-creates the missing parents of the bind-mounted caches
# (/home/agent/go, /home/agent/go/pkg, /home/agent/.cache) as root:root,
# and uid 1000 can't create siblings like Go's pkg/sumdb checksum-db dir.
RUN mkdir -p /home/agent/go/pkg/mod /home/agent/go/bin /home/agent/.cache/go-build \
    && chown -R agent:agent /home/agent/go /home/agent/.cache
USER agent
WORKDIR /repo
# No ENTRYPOINT — the orchestrator sets the entrypoint at container creation
# based on the resolved harness's runtime (sdk → harness-sdk.ts, cli → harness-cli)
```

### Agent User Permissions

Agents run as a non-root user (`agent`, UID 1000) inside the container. This reduces the blast radius of any container escape exploit — the process has no elevated privileges on the host even if Docker isolation fails.

The agent user needs write access to the following paths:

| Path | Purpose | How access is granted |
|---|---|---|
| `/repo` | Git workspace — read code, write changes, run git | Bind mount. Orchestrator creates the workspace as UID 1000, or the mount is chowned at container creation. |
| `/repo/node_modules` | npm dependencies (cache mount) | Bind mount from shared cache volume. Directory created with UID 1000 by orchestrator. |
| `/task` | Read task prompt and metadata; append usage-limit interruption note to `prompt.md` | Bind mount (read-write). Orchestrator chowns `prompt.md`/`meta.json` to UID 1000 so the agent can append the interruption note on a usage-limit retry. |
| `/output` | Write result.json, progress.log, review.json | Bind mount. Directory created with UID 1000 by orchestrator. |
| `/cache` | Shared cache root (lock file) | Bind mount. Directory created with UID 1000 by orchestrator. |
| `/home/agent/.npm` | npm download cache | Bind mount from shared cache volume. Parent `/home/agent` is agent-owned via `useradd -m`. |
| `/home/agent/.cache/pip` | pip download cache | Bind mount from shared cache volume. Parent `/home/agent/.cache` is pre-created agent-owned in the image. |
| `/home/agent/go/pkg/mod` | Go module cache | Bind mount from shared cache volume. Parents `/home/agent/go` and `/home/agent/go/pkg` are pre-created agent-owned so Go can create siblings like `pkg/sumdb`. |
| `/home/agent/.cache/go-build` | Go build cache | Bind mount from shared cache volume. Parent `/home/agent/.cache` is pre-created agent-owned in the image. |
| `/tmp` | Temporary files during builds/tests | Container-local tmpfs, writable by default. |
| Global tool binaries | `claude`, `opencode`, `node`, `git`, etc. | Installed as root during image build, readable + executable by all users. |

The orchestrator ensures correct ownership when creating workspace and output directories:

```typescript
// In workspace preparation, ensure the agent user can write
await fs.mkdir(task.workdir, { recursive: true });
await fs.chown(task.workdir, 1000, 1000);
await fs.mkdir(task.outputDir, { recursive: true });
await fs.chown(task.outputDir, 1000, 1000);
```

For shared cache directories, ownership is set once at creation and persists across container runs since the volume is long-lived.

### Repository Configuration

Each repository is configured with default agent profiles (one per
workflow stage) and an ordered list of typed install steps via the
Settings UI. The `agent_profile_id` selects the harness, model, and
provider for the implementation stage; `review_agent_profile_id` does
the same for the review stage. Both can be overridden per task. NULL
falls back to the corresponding global default — and the review chain
ultimately falls back to the implementation profile. See [04 - Agent
Harness, Profiles, Providers & Models](./04-agent-harness.md) for the
profile model and the resolution chains.

## Dependency Caching

Since dependencies are installed at container startup (not baked into the image), a persistent cache per repo is mounted to avoid repeated full installs:

```
/caches/
  org-frontend/
    node_modules/          ← persisted between agent runs
    npm-cache/             ← npm download cache
  org-backend/
    venv/                  ← persisted virtualenv
    pip-cache/             ← pip download cache
```

### Cache Mount Strategy

All three language cache buckets are mounted on every container — empty buckets cost ~0 bytes, and the polyglot agent image makes per-language gating pointless:

| Bucket | Mounts |
|---|---|
| Node | `node_modules → /repo/node_modules`, `npm-cache → /home/agent/.npm` |
| Python | `venv → /repo/.venv`, `pip-cache → /home/agent/.cache/pip` |
| Go | `go-mod-cache → /home/agent/go/pkg/mod`, `go-build-cache → /home/agent/.cache/go-build` |

### Concurrent Cache Safety

Two agents working on the same repo in parallel could corrupt shared caches. The harness uses file locking via the shared `/cache` volume (not `/tmp`, which is container-local). See the CLI harness in [04 - Agent Harness](./04-agent-harness.md) for the locking implementation.

## Container Creation

The orchestrator creates agent containers via the Docker API (dockerode). The `createAgentContainer` function receives a pre-assembled options object — profile resolution, harness invocation, path computation, environment variable assembly, and directory creation are handled by the caller (the scheduler / launch helpers in `packages/server/src/`). This keeps the Docker manager focused on container lifecycle and avoids coupling it to the database, harness registry, or workspace logic.

```typescript
interface CreateContainerOptions {
  task: Task;
  repo: Repo;
  harness: HarnessSpec;   // resolved from the task's agent profile
  workdir: string;        // e.g. /workspaces/issue-42
  taskDir: string;        // e.g. /workspaces/issue-42/.task
  outputDir: string;      // e.g. /workspaces/issue-42/.output
  cacheDir: string;       // e.g. /caches/org-reponame
  env: string[];          // pre-assembled: provider credential + harness extras
}

async function createAgentContainer(opts: CreateContainerOptions) {
  const { task, repo, harness, workdir, taskDir, outputDir, cacheDir, env } = opts;

  const mounts = [
    `${workdir}:/repo`,
    `${taskDir}:/task`,
    `${outputDir}:/output`,
    `${cacheDir}:/cache`,             // shared cache root (lock file lives here)
    // All three language cache buckets — the unified agent image runs any
    // language, so we don't gate cache mounts on the repo's language. Empty
    // buckets cost ~0 bytes until something writes to them.
    `${cacheDir}/node_modules:/repo/node_modules`,
    `${cacheDir}/npm-cache:/home/agent/.npm`,
    `${cacheDir}/venv:/repo/.venv`,
    `${cacheDir}/pip-cache:/home/agent/.cache/pip`,
    `${cacheDir}/go-mod-cache:/home/agent/go/pkg/mod`,
    `${cacheDir}/go-build-cache:/home/agent/.cache/go-build`,
  ];

  // Entrypoint determined by the harness's runtime
  // (sdk → TypeScript harness, cli → bash harness).
  const entrypoint = harness.runtime === 'sdk'
    ? ['npx', 'tsx', '/usr/local/bin/harness-sdk.ts']
    : ['/usr/local/bin/harness-cli'];

  // Per-repo override or compile-time default (constants.ts:
  // DEFAULT_CONTAINER_MEMORY_MB / DEFAULT_CONTAINER_CPU_CORES, 4096/2).
  const memoryMb = repo.container_memory_mb ?? DEFAULT_CONTAINER_MEMORY_MB;
  const cpuCores = repo.container_cpu_cores ?? DEFAULT_CONTAINER_CPU_CORES;

  return docker.createContainer({
    Image: 'orchestrator-agent:latest',                      // single image for all repos
    Entrypoint: entrypoint,                                  // harness runtime (sdk vs cli)
    Labels: {
      'managed-by': 'orchestrator',
      'task-id': String(task.id)
    },
    User: '1000:1000',   // run as non-root agent user
    HostConfig: {
      Binds: mounts,
      Memory: memoryMb * 1024 * 1024,
      CpuPeriod: 100000,
      CpuQuota: cpuCores * 100000,
      NetworkMode: 'agent-network',
    },
    Env: env,
  });
}
```

## Network Access

Agent containers run on a standard Docker bridge network. They require outbound access to:

- **Forgejo** (git fetch/push via the agent credential)
- **LLM APIs** (Anthropic API at api.anthropic.com, or local LLM servers on the LAN)
- **Package registries** (npm, pypi, crates.io, etc.)

```bash
docker network create agent-network
```

Network isolation is not practical given these requirements. Security is enforced through credential scoping and Forgejo branch protection — see [01 - Forgejo Setup](./01-forgejo-setup.md) for the full token scope and branch protection configuration.

## Git Credential in Workspaces

The workspace git remote is configured with the agent credential:

```
http://agent:<agent_token>@forgejo-host:3000/org/repo.git
```

This credential allows `git fetch` (all branches) and `git push` (to `agent/*` branches, enforced by branch protection). The remote stays configured throughout the container lifecycle — there is no credential swapping.

The orchestrator uses its own API token for all Forgejo REST API operations (PR creation, merge, labels, comments). This token is never written to the workspace filesystem.

## Workspace Mounting

The workspace flow:

```
Orchestrator:
  1. Clone/fetch repo to /workspaces/issue-42/ (agent credential in remote URL)
  2. Create or checkout branch
  3. Write /workspaces/issue-42/.task/prompt.md (includes review feedback on rework cycles)
  4. Write /workspaces/issue-42/.task/meta.json
  5. Create container with volume mounts:
     - /workspaces/issue-42 → /repo
     - /workspaces/issue-42/.task → /task
     - /workspaces/issue-42/.output → /output

Agent container:
  7. Harness reads /task
  8. Agent fetches latest base, rebases if needed, implements changes
  9. Agent commits and pushes to the task branch
  10. Harness writes /output/result.json
  11. Container exits

Orchestrator:
  12. Read /workspaces/issue-42/.output/result.json
  13. Verify branch was pushed (salvage local work if not)
  14. Create or update PR via Forgejo API
  15. Clean up or preserve for rework
```

## Resource Limits

Default resource limits per agent container:

| Resource | Limit | Rationale |
|----------|-------|-----------|
| Memory | 4 GB | Sufficient for most build/test workloads. Per-repo override via `repos.container_memory_mb`. |
| CPU | 2 cores | Prevents single agent from starving others. Per-repo override via `repos.container_cpu_cores`. |
| Disk | Inherited from host | Workspace + cache volume |
| Time | `agent_profiles.timeout_minutes` (form pre-fill 2880 / 48 h; bootstrap profile 120 / 2 h) | Wall-clock, enforced by the in-container harness; SIGKILLs the container at the deadline regardless of turn count. |

Memory and CPU defaults live in `packages/server/src/constants.ts` (`DEFAULT_CONTAINER_MEMORY_MB`, `DEFAULT_CONTAINER_CPU_CORES`) — operators tune per-repo via Settings → Repositories. The host pool (`settings.max_agent_memory_mb` / `max_agent_cpu_cores`) caps the sum of running containers.
