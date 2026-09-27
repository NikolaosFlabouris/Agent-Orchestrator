import type Docker from 'dockerode';
import {
  AGENT_NETWORK,
  createAgentContainer,
  getDocker,
  removeContainer,
  resolveMountSource,
  startContainer,
} from '../docker.js';
import type { AgentHandle, AgentLaunchOptions, RunInImageOptions, SmokeDriver } from './runner.js';

// ---------------------------------------------------------------------------
// Real SmokeDriver: agent launches go through createAgentContainer (same
// network, user, mounts and entrypoint as real tasks); helper containers
// (static checks, preflight, fix verification) are plain short-lived
// containers of the image under test.
// ---------------------------------------------------------------------------

export function createDockerSmokeDriver(): SmokeDriver {
  return {
    async runInImage(opts: RunInImageOptions) {
      const binds: string[] = [];
      const mounts: unknown[] = [];
      if (opts.repoDir) {
        const src = resolveMountSource(opts.repoDir);
        if (src.kind === 'bind') {
          binds.push(`${src.hostPath}:/repo:ro`);
        } else {
          mounts.push({
            Type: 'volume',
            Source: src.name,
            Target: '/repo',
            ReadOnly: true,
            ...(src.subpath ? { VolumeOptions: { Subpath: src.subpath } } : {}),
          });
        }
      }
      const container = await getDocker().createContainer({
        Image: opts.image,
        Entrypoint: ['bash', '-c'],
        Cmd: [opts.script],
        User: '1000:1000',
        WorkingDir: '/repo',
        Env: opts.env ?? [],
        Labels: opts.labels,
        // A TTY merges stdout/stderr into one raw (non-multiplexed) stream.
        Tty: true,
        HostConfig: {
          NetworkMode: opts.network ? AGENT_NETWORK : 'none',
          ...(binds.length ? { Binds: binds } : {}),
          ...(mounts.length ? { Mounts: mounts as unknown as Docker.MountConfig } : {}),
        },
      });
      try {
        await container.start();
        const exit = await Promise.race([
          container.wait().then((r: { StatusCode: number }) => r.StatusCode),
          new Promise<null>((r) => setTimeout(() => r(null), opts.timeoutMs)),
        ]);
        const logs = await container.logs({ stdout: true, stderr: true, follow: false });
        return { exitCode: exit, output: Buffer.from(logs).toString('utf-8') };
      } finally {
        await removeContainer(container).catch(() => undefined);
      }
    },

    async launchAgent(opts: AgentLaunchOptions): Promise<AgentHandle> {
      const container = await createAgentContainer({
        // No task row: the id is unused because `labels` replaces the
        // task-id label, and the repo carries no resource overrides.
        task: { id: 0 },
        repo: { container_memory_mb: null, container_cpu_cores: null },
        harnessRuntime: opts.harnessRuntime,
        workdir: opts.workdir,
        taskDir: opts.taskDir,
        outputDir: opts.outputDir,
        cacheDir: opts.cacheDir,
        env: opts.env,
        image: opts.image,
        labels: opts.labels,
      });
      try {
        await startContainer(container);
      } catch (err) {
        await removeContainer(container).catch(() => undefined);
        throw err;
      }
      return {
        wait: () => container.wait().then((r: { StatusCode: number }) => r.StatusCode),
        dispose: () => removeContainer(container).catch(() => undefined),
      };
    },
  };
}

/** Throws when the image isn't present locally. */
export async function assertImageExists(image: string): Promise<void> {
  await getDocker().getImage(image).inspect();
}
