/**
 * Pure derivation of a task's runtime health from its row, its attempts,
 * and (optionally) the set of container ids Docker currently reports.
 *
 * A LEAF module — imports only shared types. `orphan-recovery.ts` owns the
 * recovery behaviour and re-exports `computeTaskHealth`; the task serializer
 * (`task-view.ts`) needs the same computation without inheriting
 * orphan-recovery's imports of `state-sync.ts` / `actions.ts`, which would
 * close an import cycle through `ws/dashboard.ts`.
 */

import type { Task, Attempt, TaskHealth } from '@orchestrator/shared';

/** Statuses during which a task is expected to own a container. */
export const HEALTH_ACTIVE_STATUSES = new Set<Task['status']>([
  'in-progress',
  'in-review',
  'changes-needed',
]);

/**
 * Health with full Docker knowledge: `managedContainerIds` is the set of
 * container ids the daemon reports, so a container that vanished out from
 * under an active task is detectable.
 */
export function computeTaskHealth(
  task: Task,
  managedContainerIds: Set<string>,
  runningAttempt: Attempt | undefined
): TaskHealth {
  if (!HEALTH_ACTIVE_STATUSES.has(task.status)) return 'idle';

  const hasRunningAttempt = runningAttempt !== undefined;
  if (!hasRunningAttempt) return 'healthy'; // between roles — not orphaned.

  if (task.container_id === null) return 'orphaned';
  if (!managedContainerIds.has(task.container_id)) return 'orphaned';
  return 'healthy';
}

/**
 * Health without Docker. Used by callers for which listing containers is
 * either too expensive or outright forbidden (POST handlers, and the
 * synchronous WebSocket broadcast path). Only catches the "container_id is
 * null with a running attempt" orphan shape — `missing_container` requires
 * Docker state we don't have here.
 */
export function deriveHealthWithoutDocker(
  task: Task,
  runningAttempt: Attempt | undefined
): TaskHealth {
  if (!HEALTH_ACTIVE_STATUSES.has(task.status)) return 'idle';
  if (!runningAttempt) return 'healthy';
  if (task.container_id === null) return 'orphaned';
  return 'healthy';
}
