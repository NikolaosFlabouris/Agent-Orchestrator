import type { Task } from '@orchestrator/shared';
import { getTasks } from './db.js';
import {
  listContainers,
  getContainer,
  stopContainer,
  removeContainer,
} from './docker.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Task statuses for which an orchestrator-managed agent container is
 * legitimately present (or is about to be, during a launch). A container
 * whose `task-id` label maps to a task NOT in one of these states — or to
 * no task row at all — has outlived its task and is a leak to be reaped.
 *
 * Mirrors the ACTIVE_STATUSES set in orphan-recovery.ts plus `preparing`,
 * because a task mid-launch (preparing → in-progress) may already have its
 * container created but not yet be in-progress; reaping it would kill a
 * live agent.
 */
const ACTIVE_STATUSES: Task['status'][] = [
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
];

/**
 * Runtime safety-net reaper for orchestrator-managed agent containers that
 * have outlived their task.
 *
 * Background: orphaned containers were previously pruned only at startup
 * (recovery.ts step 4) and shutdown. A long-running orchestrator therefore
 * accumulated stranded `Exited` containers — tasks finished and transitioned
 * to a terminal state, but the container was never removed (e.g. a removal
 * that threw, or a duplicate container from a now-fixed tick race). This
 * sweep removes them while the orchestrator runs.
 *
 * Conservative by construction:
 *  - Enumerates ONLY via `listContainers()`, which filters to
 *    `managed-by=orchestrator`. A container the orchestrator did not create
 *    is never even seen here, so it can never be removed.
 *  - Removes a managed container only when its `task-id` label maps to a
 *    task that is NOT active. If the task is active, EVERY container bearing
 *    its id is left alone — including a stale exited one — so a running
 *    agent is never killed.
 *
 * Best-effort and non-throwing per container: a Docker error on one removal
 * is logged and the sweep continues; the container is retried next cycle.
 */
export async function reapOrphanedContainers(
  log: FastifyBaseLogger
): Promise<void> {
  let containers: Awaited<ReturnType<typeof listContainers>>;
  try {
    containers = await listContainers();
  } catch (err) {
    log.warn(
      { event: 'container_reap_docker_unavailable', err },
      'Skipping container reap — Docker unreachable'
    );
    return;
  }

  // Build the set of currently-active task ids once. A container whose
  // task-id is in this set is left untouched.
  const activeTaskIds = new Set<string>();
  for (const status of ACTIVE_STATUSES) {
    for (const task of getTasks({ status })) {
      activeTaskIds.add(String(task.id));
    }
  }

  for (const c of containers) {
    const taskIdLabel = c.Labels?.['task-id'];
    // A managed container with no task-id label can't be mapped to a task;
    // leave it for a human rather than guess and risk removing something
    // legitimate.
    if (!taskIdLabel) continue;
    // Task is still active — keep all of its containers, including this one.
    if (activeTaskIds.has(taskIdLabel)) continue;

    // Orphan: a managed container whose task is no longer active. Reap it.
    try {
      const container = getContainer(c.Id);
      await stopContainer(container);
      await removeContainer(container);
      log.info(
        { event: 'container_reaped', container_id: c.Id, task_id: taskIdLabel },
        'Reaped orphaned agent container (task no longer active)'
      );
    } catch (err) {
      log.warn(
        {
          event: 'container_reap_failed',
          container_id: c.Id,
          task_id: taskIdLabel,
          err,
        },
        'Failed to reap orphaned container; will retry next cycle'
      );
    }
  }
}
