import Docker from 'dockerode';
import os from 'node:os';
import fs from 'node:fs';
import type { Task, Repo } from '@orchestrator/shared';
import {
  DEFAULT_CONTAINER_MEMORY_MB,
  DEFAULT_CONTAINER_CPU_CORES,
} from './constants.js';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let _docker: Docker;

export function initDocker(): Docker {
  _docker = new Docker({ socketPath: '/var/run/docker.sock' });
  return _docker;
}

export function getDocker(): Docker {
  if (!_docker) {
    throw new Error('Docker not initialized. Call initDocker() first.');
  }
  return _docker;
}

// ---------------------------------------------------------------------------
// Host-path translation for sibling containers
// ---------------------------------------------------------------------------
//
// The orchestrator runs inside a container. When it asks the Docker daemon to
// create a sibling agent container with a bind mount, the daemon interprets the
// bind source as a HOST path — NOT a path inside the orchestrator. On plain
// Linux with matching host bind mounts (e.g. `./workspaces:/workspaces`) these
// two paths happen to agree, so passing `/workspaces/issue-N` works. On Docker
// Desktop (Windows/macOS), the host path is something like
// `C:\Users\...\workspaces` and the daemon has no idea what `/workspaces` means
// — it silently creates an empty directory (or maps into its own rootfs
// overlay) and the agent sees nothing.
//
// To be portable, we inspect the orchestrator's own container at boot, read
// the host `Source` for each of its mounts, and translate in-container paths
// to host paths when constructing agent bind-mount specs.

let _hostPathMap: Map<string, string> | null = null;

async function loadHostPathMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const id = (process.env.HOSTNAME ?? os.hostname()).trim();
    if (!id) return map;
    const self = await _docker.getContainer(id).inspect();
    for (const m of self.Mounts ?? []) {
      if (m.Destination && m.Source) {
        map.set(m.Destination.replace(/\/+$/, ''), m.Source.replace(/\/+$/, ''));
      }
    }
  } catch {
    // Best effort — on plain Linux or if inspect fails, in-container paths
    // happen to equal host paths for bind-mounted working directories, so
    // falling through with an empty map is a safe default.
  }
  return map;
}

export async function initHostPathMap(): Promise<void> {
  _hostPathMap = await loadHostPathMap();
}

/** Translate an in-container absolute path (e.g. /workspaces/issue-1) to the
 *  corresponding HOST path the Docker daemon can resolve. Falls back to the
 *  input if no mapping is known. */
export function toHostPath(inContainerPath: string): string {
  if (!_hostPathMap) return inContainerPath;
  const normalized = inContainerPath.replace(/\/+$/, '');
  // Find the longest matching destination prefix.
  let best: { dest: string; source: string } | null = null;
  for (const [dest, source] of _hostPathMap.entries()) {
    if (normalized === dest || normalized.startsWith(dest + '/')) {
      if (!best || dest.length > best.dest.length) {
        best = { dest, source };
      }
    }
  }
  if (!best) return inContainerPath;
  const suffix = normalized.slice(best.dest.length);
  return best.source + suffix;
}

// ---------------------------------------------------------------------------
// Container labels
// ---------------------------------------------------------------------------

const LABEL_MANAGED_BY = 'managed-by';
const LABEL_MANAGED_BY_VALUE = 'orchestrator';
const LABEL_TASK_ID = 'task-id';

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

export interface CreateContainerOptions {
  task: Task;
  repo: Repo;
  /** Whether the harness runs the SDK script or the CLI script inside
   *  the container. Determines the entrypoint binary. */
  harnessRuntime: 'sdk' | 'cli';
  workdir: string;
  taskDir: string;
  outputDir: string;
  cacheDir: string;
  env: string[];
}

export async function createAgentContainer(
  opts: CreateContainerOptions
): Promise<Docker.Container> {
  const { task, repo, harnessRuntime, workdir, taskDir, outputDir, cacheDir, env } = opts;

  // The orchestrator passes in paths as they appear INSIDE its own container.
  // The Docker daemon interprets bind-mount sources as HOST paths, so translate
  // before constructing the Binds array. No-op on plain Linux where the two
  // agree. Also ensure cache subdirectories exist and are writable by the
  // agent user before Docker auto-creates them as root-owned.
  ensureCacheSubdirs(cacheDir);

  const workdirHost = toHostPath(workdir);
  const taskDirHost = toHostPath(taskDir);
  const outputDirHost = toHostPath(outputDir);
  const cacheDirHost = toHostPath(cacheDir);

  // All language cache buckets are always mounted. The unified
  // orchestrator-agent image ships Node, Python, and Go toolchains together,
  // so a repo can be polyglot. Empty buckets cost ~0 bytes until something
  // writes to them.
  const mounts = [
    `${workdirHost}:/repo`,
    `${taskDirHost}:/task`,
    `${outputDirHost}:/output`,
    `${cacheDirHost}:/cache`,
    `${cacheDirHost}/node_modules:/repo/node_modules`,
    `${cacheDirHost}/npm-cache:/home/agent/.npm`,
    `${cacheDirHost}/venv:/repo/.venv`,
    `${cacheDirHost}/pip-cache:/home/agent/.cache/pip`,
    `${cacheDirHost}/go-mod-cache:/home/agent/go/pkg/mod`,
    `${cacheDirHost}/go-build-cache:/home/agent/.cache/go-build`,
  ];

  // Entrypoint determined by harness runtime
  const entrypoint =
    harnessRuntime === 'sdk'
      ? ['npx', 'tsx', '/usr/local/bin/harness-sdk.ts']
      : ['/usr/local/bin/harness-cli'];

  // Resource limits — per-repo override or compile-time default. Heavy
  // workloads (Rust, large Next.js, Bazel) need the per-repo override; the
  // default covers small-to-medium projects. See constants.ts.
  const memoryMb = repo.container_memory_mb ?? DEFAULT_CONTAINER_MEMORY_MB;
  const cpuCores = repo.container_cpu_cores ?? DEFAULT_CONTAINER_CPU_CORES;

  const container = await getDocker().createContainer({
    Image: 'orchestrator-agent:latest',
    Entrypoint: entrypoint,
    Labels: {
      [LABEL_MANAGED_BY]: LABEL_MANAGED_BY_VALUE,
      [LABEL_TASK_ID]: String(task.id),
    },
    User: '1000:1000',
    Env: env,
    HostConfig: {
      Binds: mounts,
      Memory: memoryMb * 1024 * 1024,
      CpuPeriod: 100000,
      CpuQuota: cpuCores * 100000,
      NetworkMode: 'agent-network',
    },
  });

  return container;
}

export async function startContainer(
  container: Docker.Container
): Promise<void> {
  await container.start();
}

export async function stopContainer(
  container: Docker.Container
): Promise<void> {
  try {
    await container.stop({ t: 10 });
  } catch (err: unknown) {
    // Container may already be stopped
    if (isDockerError(err) && err.statusCode === 304) {
      return;
    }
    throw err;
  }
}

export async function removeContainer(
  container: Docker.Container
): Promise<void> {
  try {
    await container.remove({ force: true });
  } catch (err: unknown) {
    // Container may already be removed
    if (isDockerError(err) && err.statusCode === 404) {
      return;
    }
    throw err;
  }
}

/** Minimal duck-typed container interface for `wait()`. The scheduler
 *  hands us either a full Docker.Container or a lightweight stub from
 *  the recovery path; both expose `id` and `wait()`. Accepting the
 *  narrower shape lets callsites drop the `as any` cast. */
export interface WaitableContainer {
  id: string;
  wait(): Promise<{ StatusCode: number }>;
}

export async function waitForContainer(
  container: WaitableContainer
): Promise<{ StatusCode: number }> {
  return container.wait();
}

export async function inspectContainer(
  container: Docker.Container
): Promise<Docker.ContainerInspectInfo> {
  return container.inspect();
}

/**
 * List containers managed by the orchestrator.
 * Optionally filter by task ID.
 */
export async function listContainers(
  taskId?: number
): Promise<Docker.ContainerInfo[]> {
  const filters: Record<string, string[]> = {
    label: [`${LABEL_MANAGED_BY}=${LABEL_MANAGED_BY_VALUE}`],
  };

  if (taskId !== undefined) {
    filters.label.push(`${LABEL_TASK_ID}=${taskId}`);
  }

  return getDocker().listContainers({
    all: true,
    filters,
  });
}

/**
 * Get a container by its ID string.
 */
export function getContainer(containerId: string): Docker.Container {
  return getDocker().getContainer(containerId);
}

// ---------------------------------------------------------------------------
// Cache-dir pre-creation (so Docker does not auto-create as root)
// ---------------------------------------------------------------------------
//
// The unified agent image carries all three language toolchains, so we always
// pre-create all cache buckets. Empty buckets cost ~0 bytes until something
// writes to them; the orchestrator's WORKSPACE_RETENTION_DAYS cleanup
// handles aging out anything that grows.

const CACHE_SUBDIRS = [
  'node_modules',
  'npm-cache',
  'venv',
  'pip-cache',
  'go-mod-cache',
  'go-build-cache',
  // General-purpose bucket for repo install scripts to cache downloaded
  // tooling (e.g. pinned static binaries) across containers. Pre-created and
  // chowned here because on Linux hosts the /cache root itself is root-owned
  // — without this, a script's writability probe fails and its caching
  // silently degrades to a per-container temp dir.
  'agent-tools',
];

function ensureCacheSubdirs(cacheDir: string): void {
  for (const sub of CACHE_SUBDIRS) {
    const p = `${cacheDir}/${sub}`;
    try {
      fs.mkdirSync(p, { recursive: true });
      try {
        fs.chownSync(p, 1000, 1000);
      } catch {
        /* non-Linux host or no permission — best effort */
      }
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const AGENT_NETWORK = 'agent-network';

/**
 * Ensure the agent-network Docker network exists.
 * Creates it idempotently — safe to call on every startup.
 */
export async function ensureAgentNetwork(): Promise<void> {
  const docker = getDocker();

  try {
    const network = docker.getNetwork(AGENT_NETWORK);
    await network.inspect();
    // Network already exists
  } catch (err: unknown) {
    if (isDockerError(err) && err.statusCode === 404) {
      // Network doesn't exist — create it
      await docker.createNetwork({
        Name: AGENT_NETWORK,
        Driver: 'bridge',
      });
    } else {
      throw err;
    }
  }
}

/** Service name (and default DNS alias) of the bundled Forgejo container
 *  in docker-compose.yml. */
const BUNDLED_FORGEJO_CONTAINER = 'forgejo';

/**
 * Attach the bundled `forgejo` container to the agent-network so that
 * disposable agent containers — which run ONLY on agent-network — can
 * reach it by service name for git over `FORGEJO_URL` (http://forgejo:3000).
 *
 * The orchestrator itself reaches Forgejo over compose's default project
 * network; this connect is purely for the agent containers' git traffic.
 *
 * Best-effort and idempotent — safe to call on every startup:
 *   - 'absent'            → no `forgejo` container (external-Forgejo deploy);
 *                           reachability is the operator's responsibility.
 *   - 'already-connected' → endpoint already exists on the network.
 *   - 'connected'         → freshly attached.
 */
export async function connectBundledForgejoToAgentNetwork(
  // Injectable for tests; defaults to the initialized singleton.
  docker: Pick<Docker, 'getNetwork'> = getDocker(),
): Promise<'connected' | 'already-connected' | 'absent'> {
  try {
    const network = docker.getNetwork(AGENT_NETWORK);
    // Pin the `forgejo` DNS alias explicitly so agent containers resolve
    // FORGEJO_URL=http://forgejo:3000 regardless of the container's name.
    await network.connect({
      Container: BUNDLED_FORGEJO_CONTAINER,
      EndpointConfig: { Aliases: [BUNDLED_FORGEJO_CONTAINER] },
    });
    return 'connected';
  } catch (err: unknown) {
    if (isDockerError(err)) {
      // 404: no such container (external Forgejo) — nothing to do.
      if (err.statusCode === 404) return 'absent';
      // 403: endpoint with that name already exists — already attached.
      if (err.statusCode === 403) return 'already-connected';
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDockerError(err: unknown): err is { statusCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number'
  );
}
