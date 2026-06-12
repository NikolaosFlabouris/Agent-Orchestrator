import type { Task } from '@orchestrator/shared';
import { getTasks, getQueuedTasks, getRepo, getSettingInt } from './db.js';
import {
  DEFAULT_CONTAINER_MEMORY_MB,
  DEFAULT_CONTAINER_CPU_CORES,
} from './constants.js';

/**
 * Determines the candidates for slot filling, in priority order:
 *   1. Tasks in 'in-review' with no container (recovery — need review container started)
 *   2. Orphaned rework (status/changes-needed with no active container)
 *   3. FIFO queue (status/queued by queue_position)
 */
export function getCandidates(): Task[] {
  const candidates: Task[] = [];

  // Priority 1: in-review without container (recovery)
  const inReview = getTasks({ status: 'in-review' });
  for (const task of inReview) {
    if (!task.container_id) {
      candidates.push(task);
    }
  }

  // Priority 2: orphaned rework (changes-needed without container)
  const changesNeeded = getTasks({ status: 'changes-needed' });
  for (const task of changesNeeded) {
    if (!task.container_id) {
      candidates.push(task);
    }
  }

  // Priority 3: FIFO queued (already ordered by queue_position ASC)
  const queued = getQueuedTasks();
  candidates.push(...queued);

  return candidates;
}

/** Per-task host-resource footprint. */
export interface TaskResources {
  memoryMb: number;
  cpuCores: number;
}

/** Compute a task's claim on the host resource pool from its repo's
 *  container size overrides (or the constants when null). */
export function getTaskResources(task: Task): TaskResources {
  const repo = getRepo(task.repo_id);
  return {
    memoryMb: repo?.container_memory_mb ?? DEFAULT_CONTAINER_MEMORY_MB,
    cpuCores: repo?.container_cpu_cores ?? DEFAULT_CONTAINER_CPU_CORES,
  };
}

/** Aggregate resource use of all currently-active (container_id non-null)
 *  agent tasks. Pure read of DB state — no side effects. */
export function getActiveResources(): TaskResources {
  const active = [
    ...getTasks({ status: 'preparing' }),
    ...getTasks({ status: 'in-progress' }),
    ...getTasks({ status: 'in-review' }),
  ].filter((t) => t.container_id !== null);

  let memoryMb = 0;
  let cpuCores = 0;
  for (const task of active) {
    const r = getTaskResources(task);
    memoryMb += r.memoryMb;
    cpuCores += r.cpuCores;
  }
  return { memoryMb, cpuCores };
}

/** Headroom in the host resource pool. Used by the scheduler to gate
 *  candidate launches; values can be 0 or negative if a config change
 *  shrinks the pool below current usage (existing containers keep
 *  running; just no new launches until usage drops). */
export function getAvailableResources(): TaskResources {
  const used = getActiveResources();
  return {
    memoryMb: Math.max(
      0,
      getSettingInt('max_agent_memory_mb') - used.memoryMb
    ),
    cpuCores: Math.max(
      0,
      getSettingInt('max_agent_cpu_cores') - used.cpuCores
    ),
  };
}

/** Whether a candidate task fits in the remaining host pool. */
export function fitsInPool(
  need: TaskResources,
  available: TaskResources
): boolean {
  return need.memoryMb <= available.memoryMb && need.cpuCores <= available.cpuCores;
}
