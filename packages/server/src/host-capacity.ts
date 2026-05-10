import os from 'node:os';
import { getDocker } from './docker.js';

export interface HostCapacity {
  /** 'docker' when the values come from `docker info` (the true container-side
   *  ceiling, including Docker Desktop's VM allocation on macOS/Windows).
   *  'os' when Docker is unreachable and we fall back to the orchestrator
   *  process's view of the host. */
  source: 'docker' | 'os';
  memory_total_mb: number;
  cpu_cores: number;
}

/** Detect the resource ceiling available to agent containers.
 *
 *  Tries `docker info` first — that's the value Docker will actually honour
 *  when scheduling sibling containers. Falls back to Node's `os` module if
 *  the daemon isn't reachable (e.g. local dev without Docker, or boot-time
 *  probe before Docker init has succeeded). */
export async function detectHostCapacity(): Promise<HostCapacity> {
  try {
    const docker = getDocker();
    const info = (await docker.info()) as { MemTotal?: number; NCPU?: number };
    if (
      typeof info.MemTotal === 'number' &&
      info.MemTotal > 0 &&
      typeof info.NCPU === 'number' &&
      info.NCPU > 0
    ) {
      return {
        source: 'docker',
        memory_total_mb: Math.floor(info.MemTotal / (1024 * 1024)),
        cpu_cores: info.NCPU,
      };
    }
  } catch {
    // Docker not initialised, daemon unreachable, or info() failed —
    // fall through to the os-based estimate.
  }
  return {
    source: 'os',
    memory_total_mb: Math.floor(os.totalmem() / (1024 * 1024)),
    cpu_cores: os.cpus().length,
  };
}
