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
// Mount translation for sibling containers
// ---------------------------------------------------------------------------
//
// The orchestrator runs inside a container. When it asks the Docker daemon to
// create a sibling agent container, mount sources are interpreted from the
// DAEMON's point of view — never relative to the orchestrator's own
// filesystem. An in-container path like /workspaces/issue-N therefore has to
// be translated before it can back an agent mount. Two cases, decided by how
// the orchestrator's own /workspaces and /caches are provided (inspected from
// its container config at boot):
//
//   * named volume (the compose default) — there is no host path at all; the
//     agent container mounts the SAME volume with a `Subpath` pointing at the
//     issue-N subdirectory (Docker Engine 26+ / API 1.45+). This keeps all
//     workspace I/O on the daemon's native filesystem, which on Docker
//     Desktop (Windows/macOS) is orders of magnitude faster than the 9P /
//     gRPC-FUSE host share that a host-folder bind goes through (observed:
//     vitest coverage runs that never completed over 9P).
//
//   * bind mount (the pre-volume layout, still supported) — the daemon wants
//     the HOST path, so we prefix-swap the in-container path with the bind's
//     host Source. On Docker Desktop the Source is the Windows/macOS folder;
//     on plain Linux the two paths typically agree.
//
// Fallback: when inspection fails or a path matches no mount, the
// in-container path is passed through as a bind source unchanged — correct
// on a native-Linux host whose bind layout mirrors the container's.

export type MountBacking =
  | { kind: 'bind'; source: string }
  | { kind: 'volume'; name: string };

export type ResolvedMountSource =
  | { kind: 'bind'; hostPath: string }
  | { kind: 'volume'; name: string; subpath: string }; // '' = volume root

let _mountMap: Map<string, MountBacking> | null = null;

async function loadMountMap(): Promise<Map<string, MountBacking>> {
  const map = new Map<string, MountBacking>();
  try {
    const id = (process.env.HOSTNAME ?? os.hostname()).trim();
    if (!id) return map;
    const self = await _docker.getContainer(id).inspect();
    for (const m of self.Mounts ?? []) {
      if (!m.Destination) continue;
      const dest = m.Destination.replace(/\/+$/, '');
      // dockerode's inspect type carries Type/Name but older versions leave
      // them optional — read defensively.
      const type = (m as { Type?: string }).Type;
      const name = (m as { Name?: string }).Name;
      if (type === 'volume' && name) {
        map.set(dest, { kind: 'volume', name });
      } else if (m.Source) {
        map.set(dest, { kind: 'bind', source: m.Source.replace(/\/+$/, '') });
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
  _mountMap = await loadMountMap();
  await assertVolumeSubpathSupport(_mountMap);
}

/** Volume-backed workspaces need Docker Engine 26+ (API 1.45) for
 *  VolumeOptions.Subpath on agent mounts. Fail at boot with an actionable
 *  message rather than at first task launch with a cryptic daemon error. */
async function assertVolumeSubpathSupport(
  map: Map<string, MountBacking>
): Promise<void> {
  const usesVolumes = [...map.values()].some((b) => b.kind === 'volume');
  if (!usesVolumes) return;
  const version = await _docker.version();
  const [maj = 0, min = 0] = (version.ApiVersion ?? '0.0')
    .split('.')
    .map(Number);
  if (maj > 1 || (maj === 1 && min >= 45)) return;
  throw new Error(
    `/workspaces or /caches is a named volume, which requires Docker Engine 26+ ` +
      `(API 1.45) for volume-subpath agent mounts — this daemon reports API ` +
      `${version.ApiVersion} (Engine ${version.Version}). Upgrade Docker, or ` +
      `switch the compose volumes back to host bind mounts.`
  );
}

/** Resolve an in-container absolute path (e.g. /workspaces/issue-1) to the
 *  daemon-visible mount source backing it: a host path (bind) or a named
 *  volume plus subpath. Exported with an injectable map for unit tests. */
export function resolveMountSource(
  inContainerPath: string,
  map: Map<string, MountBacking> | null = _mountMap
): ResolvedMountSource {
  const normalized = inContainerPath.replace(/\/+$/, '');
  // Find the longest matching destination prefix.
  let best: { dest: string; backing: MountBacking } | null = null;
  if (map) {
    for (const [dest, backing] of map.entries()) {
      if (normalized === dest || normalized.startsWith(dest + '/')) {
        if (!best || dest.length > best.dest.length) {
          best = { dest, backing };
        }
      }
    }
  }
  if (!best) return { kind: 'bind', hostPath: normalized };
  const suffix = normalized.slice(best.dest.length);
  if (best.backing.kind === 'bind') {
    return { kind: 'bind', hostPath: best.backing.source + suffix };
  }
  return {
    kind: 'volume',
    name: best.backing.name,
    subpath: suffix.replace(/^\//, ''),
  };
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

/** Volume mount spec for agent containers. Mirrors the Docker API shape;
 *  declared locally because VolumeOptions.Subpath (Engine 26+ / API 1.45)
 *  is not in @types/dockerode yet. */
interface AgentVolumeMount {
  Type: 'volume';
  Source: string;
  Target: string;
  VolumeOptions?: { Subpath?: string };
}

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

  // The orchestrator passes in paths as they appear INSIDE its own container;
  // resolveMountSource translates each one to a daemon-visible source (host
  // path or volume subpath). Ensure cache subdirectories exist and are
  // writable by the agent user before Docker auto-creates them as root-owned.
  ensureCacheSubdirs(cacheDir);
  // Bind mounts auto-create a missing source directory; volume Subpath
  // mounts refuse to start instead. Workspace prep guarantees all three in
  // the normal flow — this is cheap insurance so a missing dir surfaces as
  // an empty mount, not a container-start error.
  ensureAgentDirs([workdir, taskDir, outputDir]);

  // All language cache buckets are always mounted. The unified
  // orchestrator-agent image ships Node, Python, and Go toolchains together,
  // so a repo can be polyglot. Empty buckets cost ~0 bytes until something
  // writes to them.
  const mountSpecs: Array<{ path: string; target: string }> = [
    { path: workdir, target: '/repo' },
    { path: taskDir, target: '/task' },
    { path: outputDir, target: '/output' },
    { path: cacheDir, target: '/cache' },
    { path: `${cacheDir}/node_modules`, target: '/repo/node_modules' },
    { path: `${cacheDir}/npm-cache`, target: '/home/agent/.npm' },
    { path: `${cacheDir}/venv`, target: '/repo/.venv' },
    { path: `${cacheDir}/pip-cache`, target: '/home/agent/.cache/pip' },
    { path: `${cacheDir}/go-mod-cache`, target: '/home/agent/go/pkg/mod' },
    { path: `${cacheDir}/go-build-cache`, target: '/home/agent/.cache/go-build' },
  ];

  const binds: string[] = [];
  const volumeMounts: AgentVolumeMount[] = [];
  for (const spec of mountSpecs) {
    const src = resolveMountSource(spec.path);
    if (src.kind === 'bind') {
      binds.push(`${src.hostPath}:${spec.target}`);
    } else {
      volumeMounts.push({
        Type: 'volume',
        Source: src.name,
        Target: spec.target,
        // Subpath is omitted when the path IS the volume root.
        ...(src.subpath ? { VolumeOptions: { Subpath: src.subpath } } : {}),
      });
    }
  }

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
      ...(binds.length ? { Binds: binds } : {}),
      // Cast: VolumeOptions.Subpath (Engine 26+ / API 1.45) is not in
      // @types/dockerode yet; the daemon accepts it as-is.
      ...(volumeMounts.length
        ? { Mounts: volumeMounts as unknown as Docker.MountConfig }
        : {}),
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

/** Pre-create agent mount source directories. Volume Subpath mounts (unlike
 *  binds) require the subdirectory to exist at container start. mkdir is
 *  idempotent; the non-recursive chown only affects the dir itself, so an
 *  already-prepared workspace tree keeps the ownership workspace prep gave
 *  it. */
function ensureAgentDirs(dirs: string[]): void {
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
      try {
        fs.chownSync(d, 1000, 1000);
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
