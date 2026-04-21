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

A small set of **language-runtime images** rather than per-repo images. This balances specificity with maintainability.

### Image Hierarchy

```
orchestrator-agent-base
├── orchestrator-agent-node
├── orchestrator-agent-python
└── orchestrator-agent-go
```

### Base Image

All runtime images extend from a common base that includes the agent harness and tooling:

```dockerfile
# images/base/Dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git \
    jq \
    curl \
    ca-certificates \
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Node.js is required for Claude Agent SDK regardless of project language
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install agent tools (as root, before switching user)
RUN npm install -g @anthropic-ai/claude-code
# OpenCode (Go binary)
RUN curl -fsSL https://get.opencode.ai | bash

# Install Claude Agent SDK for TypeScript harness
RUN npm install -g @anthropic-ai/claude-agent-sdk

COPY harness/harness-sdk.ts /usr/local/bin/harness-sdk.ts
COPY harness/harness-cli.sh /usr/local/bin/harness-cli
RUN chmod +x /usr/local/bin/harness-cli

# Create non-root agent user
# UID/GID 1000 aligns with the default first user on most Linux systems,
# which simplifies file ownership on bind-mounted volumes.
RUN groupadd -g 1000 agent && \
    useradd -u 1000 -g agent -m -s /bin/bash agent

USER agent
WORKDIR /repo
# No ENTRYPOINT — the orchestrator sets the entrypoint at container creation
# based on the resolved agent tool type (sdk → harness-sdk.ts, cli → harness-cli)
```

### Agent User Permissions

Agents run as a non-root user (`agent`, UID 1000) inside the container. This reduces the blast radius of any container escape exploit — the process has no elevated privileges on the host even if Docker isolation fails.

The agent user needs write access to the following paths:

| Path | Purpose | How access is granted |
|---|---|---|
| `/repo` | Git workspace — read code, write changes, run git | Bind mount. Orchestrator creates the workspace as UID 1000, or the mount is chowned at container creation. |
| `/repo/node_modules` | npm dependencies (cache mount) | Bind mount from shared cache volume. Directory created with UID 1000 by orchestrator. |
| `/task` | Read task prompt and metadata | Bind mount (read-only is sufficient). |
| `/output` | Write result.json, progress.log, review.json | Bind mount. Directory created with UID 1000 by orchestrator. |
| `/cache` | Shared cache root (lock file) | Bind mount. Directory created with UID 1000 by orchestrator. |
| `/home/agent/.npm` | npm download cache | Bind mount from shared cache volume. |
| `/home/agent/.cache/pip` | pip download cache | Bind mount from shared cache volume. |
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

### Language Runtime Images

```dockerfile
# images/node/Dockerfile
FROM orchestrator-agent-base:latest
# Node.js already present from base (required for Agent SDK)
# This image exists for clarity and future Node-specific tooling
```

```dockerfile
# images/python/Dockerfile
FROM orchestrator-agent-base:latest

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*
```

```dockerfile
# images/go/Dockerfile
FROM orchestrator-agent-base:latest

RUN curl -fsSL https://go.dev/dl/go1.24.4.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/agent/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"
```

### Repository Configuration

Each repository is configured with an image type, default agent tool, and pre-agent script via the Settings UI. The `image_type` determines the Docker image (language runtime) and is always repo-level. The `agent_tool` determines the LLM tool and harness type and can be overridden per task. See [04 - Agent Harness](./04-agent-harness.md) for tool configuration and the resolution order.

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

The orchestrator mounts language-specific cache directories based on the repo's `image_type`:

| Image Type | Cache Mounts |
|-----------|--------------|
| `node` | `node_modules → /repo/node_modules`, `npm-cache → /home/agent/.npm` |
| `python` | `venv → /repo/.venv`, `pip-cache → /home/agent/.cache/pip` |
| `go` | `go-mod-cache → /home/agent/go/pkg/mod`, `go-build-cache → /home/agent/.cache/go-build` |

### Concurrent Cache Safety

Two agents working on the same repo in parallel could corrupt shared caches. The harness uses file locking via the shared `/cache` volume (not `/tmp`, which is container-local). See the CLI harness in [04 - Agent Harness](./04-agent-harness.md) for the locking implementation.

## Container Creation

The orchestrator creates agent containers via the Docker API (dockerode). The `createAgentContainer` function receives a pre-assembled options object — tool resolution, path computation, environment variable assembly, and directory creation are handled by the caller (the launch helpers in `packages/server/src/agents/`). This keeps the Docker manager focused on container lifecycle and avoids coupling it to the database or workspace logic.

```typescript
interface CreateContainerOptions {
  task: Task;
  repo: Repo;
  tool: AgentTool;
  workdir: string;    // e.g. /workspaces/issue-42
  taskDir: string;    // e.g. /workspaces/issue-42/.task
  outputDir: string;  // e.g. /workspaces/issue-42/.output
  cacheDir: string;   // e.g. /caches/org-reponame
  env: string[];      // pre-assembled environment variables
}

async function createAgentContainer(opts: CreateContainerOptions) {
  const { task, repo, tool, workdir, taskDir, outputDir, cacheDir, env } = opts;

  const mounts = [
    `${workdir}:/repo`,
    `${taskDir}:/task`,
    `${outputDir}:/output`,
    `${cacheDir}:/cache`,             // shared cache root (lock file lives here)
  ];

  // Language-specific cache mounts (paths match non-root agent user home)
  if (repo.image_type === 'node') {
    mounts.push(`${cacheDir}/node_modules:/repo/node_modules`);
    mounts.push(`${cacheDir}/npm-cache:/home/agent/.npm`);
  } else if (repo.image_type === 'python') {
    mounts.push(`${cacheDir}/venv:/repo/.venv`);
    mounts.push(`${cacheDir}/pip-cache:/home/agent/.cache/pip`);
  } else if (repo.image_type === 'go') {
    mounts.push(`${cacheDir}/go-mod-cache:/home/agent/go/pkg/mod`);
    mounts.push(`${cacheDir}/go-build-cache:/home/agent/.cache/go-build`);
  }

  // Entrypoint determined by tool type (sdk → TypeScript harness, cli → bash harness)
  const entrypoint = tool.type === 'sdk'
    ? ['npx', 'tsx', '/usr/local/bin/harness-sdk.ts']
    : ['/usr/local/bin/harness-cli'];

  // Resource limits — per-repo override or global default from settings
  const memoryMb = repo.container_memory_mb ?? getSettingInt('default_container_memory_mb');
  const cpuCores = repo.container_cpu_cores ?? getSettingInt('default_container_cpu_cores');

  return docker.createContainer({
    Image: `orchestrator-agent-${repo.image_type}:latest`,  // image from repo (language runtime)
    Entrypoint: entrypoint,                                  // harness from tool type (sdk vs cli)
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
| Memory | 4 GB | Sufficient for most build/test workloads |
| CPU | 2 cores | Prevents single agent from starving others |
| Disk | Inherited from host | Workspace + cache volume |
| Time | Configurable (default 30 min) | Enforced by harness timeout |

These are defaults configurable via the orchestrator settings.
