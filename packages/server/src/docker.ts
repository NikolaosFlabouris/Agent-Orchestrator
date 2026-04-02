import Docker from 'dockerode';
import type { Task, Repo, AgentTool } from '@orchestrator/shared';
import { getSetting, getSettingInt } from './db.js';

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
  tool: AgentTool;
  workdir: string;
  taskDir: string;
  outputDir: string;
  cacheDir: string;
  env: string[];
}

export async function createAgentContainer(
  opts: CreateContainerOptions
): Promise<Docker.Container> {
  const { task, repo, tool, workdir, taskDir, outputDir, cacheDir, env } = opts;

  const mounts = [
    `${workdir}:/repo`,
    `${taskDir}:/task`,
    `${outputDir}:/output`,
    `${cacheDir}:/cache`,
  ];

  // Language-specific cache mounts
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

  // Entrypoint determined by tool type
  const entrypoint =
    tool.type === 'sdk'
      ? ['npx', 'tsx', '/usr/local/bin/harness-sdk.ts']
      : ['/usr/local/bin/harness-cli'];

  // Resource limits — task/repo overrides or global defaults
  const memoryMb =
    repo.container_memory_mb ?? getSettingInt('default_container_memory_mb');
  const cpuCores =
    repo.container_cpu_cores ?? getSettingInt('default_container_cpu_cores');

  const container = await getDocker().createContainer({
    Image: `orchestrator-agent-${repo.image_type}:latest`,
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

export async function waitForContainer(
  container: Docker.Container
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
