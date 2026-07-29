import fsp from 'node:fs/promises';
import type { Task } from '@orchestrator/shared';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { getRepo, getTask, getDb } from './db.js';
import { updateTaskWithSync, recordTaskEvent } from './state-sync.js';
import type { ForgejoClient } from './forgejo.js';
import {
  getContainer,
  stopContainer,
  removeContainer,
} from './docker.js';
import { getWorkdir } from './workspace.js';
import { deleteStepsForTask } from './checkpoints.js';
import type { Scheduler } from './scheduler.js';
import { DEFAULT_MAX_ATTEMPTS } from './constants.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Cancel a task — stop container, delete remote branch, close PR, update labels.
 */
export async function cancelTask(
  task: Task,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger,
  reason: string = 'Cancelled by user'
): Promise<void> {
  const repo = getRepo(task.repo_id);

  // 1. Stop running container
  if (task.container_id) {
    try {
      const container = getContainer(task.container_id);
      await stopContainer(container);
      await removeContainer(container);
    } catch {
      // Container may already be gone
    }
  }

  // 2. Delete remote branch
  if (task.branch_name && repo) {
    try {
      await forgejo.deleteBranch(repo, task.branch_name);
    } catch {
      // Branch may not exist on remote
    }
  }

  // 3. Close PR if opened
  if (task.pr_number && repo) {
    try {
      await forgejo.closePullRequest(repo, task.pr_number);
    } catch {
      // Best effort
    }
  }

  // 4. Update issue
  if (repo) {
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Task cancelled: ${reason}. Branch and PR cleaned up.`
      );
    } catch { /* best effort */ }

    try {
      await forgejo.replaceLabelByNames(repo, task.issue_id, [
        'status/cancelled',
      ]);
    } catch { /* best effort */ }
  }

  // 5. Update DB
  recordTaskEvent(task.id, 'task_cancelled', `Cancelled: ${reason}`);
  updateTaskWithSync(task.id, {
    status: 'cancelled',
    container_id: null,
    completed_at: new Date().toISOString(),
  });

  log.info(
    { event: 'task_cancelled', task_id: task.id, reason },
    'Task cancelled'
  );

  // 6. Trigger fill to use freed slot
  scheduler.triggerTick();
}

/**
 * Close a task — resolve a task that needs no further orchestration (e.g. one
 * that `failed` with "no changes produced" because the work was already done).
 *
 * Shares cancelTask's cleanup (stop container, delete branch, close PR) but
 * ALSO closes the Forgejo issue, and — unlike cancel — works on terminal
 * statuses such as `failed`. The orchestrator task lands in the existing
 * `cancelled` terminal status: here "cancelled" means orchestration was
 * stopped because there is no work to perform. No new TaskStatus is introduced.
 *
 * Idempotent/best-effort against Forgejo: closing an already-closed issue or a
 * missing branch/PR is swallowed.
 */
export async function closeTask(
  task: Task,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger,
  reason: string = 'Closed by human'
): Promise<void> {
  const repo = getRepo(task.repo_id);

  // 1. Stop running container
  if (task.container_id) {
    try {
      const container = getContainer(task.container_id);
      await stopContainer(container);
      await removeContainer(container);
    } catch {
      // Container may already be gone
    }
  }

  // 2. Delete remote branch
  if (task.branch_name && repo) {
    try {
      await forgejo.deleteBranch(repo, task.branch_name);
    } catch {
      // Branch may not exist on remote
    }
  }

  // 3. Close PR if opened
  if (task.pr_number && repo) {
    try {
      await forgejo.closePullRequest(repo, task.pr_number);
    } catch {
      // Best effort
    }
  }

  // 4. Update + close the Forgejo issue. Closing the issue is the new
  //    behaviour vs cancelTask — a closed task is fully resolved, not just
  //    unqueued. Each step is best-effort so a Forgejo hiccup (or an
  //    already-closed issue) doesn't block the local status transition.
  if (repo) {
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Task closed by human: ${reason}. Branch and PR cleaned up; issue closed.`
      );
    } catch { /* best effort */ }

    try {
      await forgejo.replaceLabelByNames(repo, task.issue_id, [
        'status/cancelled',
      ]);
    } catch { /* best effort */ }

    try {
      await forgejo.closeIssue(repo, task.issue_id);
    } catch { /* best effort — issue may already be closed */ }
  }

  // 5. Update DB
  recordTaskEvent(task.id, 'task_closed', `Closed: ${reason}`);
  updateTaskWithSync(task.id, {
    status: 'cancelled',
    container_id: null,
    completed_at: new Date().toISOString(),
  });

  log.info(
    { event: 'task_closed', task_id: task.id, reason },
    'Task closed'
  );

  // 6. Trigger fill to use freed slot
  scheduler.triggerTick();
}

export interface ResetOptions {
  /** Human-readable reason, surfaced in the task timeline and the Forgejo
   *  issue comment. Defaults to "Reset by user". */
  reason?: string;
  /** When true, set `tasks.attempt = task.attempt + 1` instead of resetting
   *  to 1. Used by orphan recovery so that a task which has been salvaged
   *  three times shows attempt=4, and a genuine user-driven reset still
   *  returns the counter to 1. */
  incrementAttempt?: boolean;
  /** When true, leave the task in `queued` (at the back of the FIFO queue)
   *  instead of the terminal `reset` state. Used by orphan recovery to
   *  auto-rerun the task without human intervention; user-driven resets
   *  deliberately go to `reset` so the operator decides whether to re-queue. */
  requeue?: boolean;
}

/**
 * Reset a task — stop container, delete branch, close PR, delete workspace,
 * remove labels, reset counters. Destructive operation.
 *
 * The `options` parameter lets orphan recovery share the cleanup flow while
 * keeping its own post-state (attempt bumped, auto-requeued). User-driven
 * resets use the defaults: attempt back to 1, status goes to `reset`.
 */
export async function resetTask(
  task: Task,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger,
  options: ResetOptions = {}
): Promise<void> {
  const reason = options.reason ?? 'Reset by user';
  const incrementAttempt = options.incrementAttempt ?? false;
  const requeue = options.requeue ?? false;
  const repo = getRepo(task.repo_id);

  // 1. Stop running container
  if (task.container_id) {
    try {
      const container = getContainer(task.container_id);
      await stopContainer(container);
      await removeContainer(container);
    } catch {
      // Container may already be gone
    }
  }

  // 2. Delete remote branch
  if (task.branch_name && repo) {
    try {
      await forgejo.deleteBranch(repo, task.branch_name);
    } catch {
      // Branch may not exist
    }
  }

  // 3. Close PR if opened
  if (task.pr_number && repo) {
    try {
      await forgejo.closePullRequest(repo, task.pr_number);
    } catch {
      // Best effort
    }
  }

  // 4. Delete local workspace. fsp.rm with force:true swallows ENOENT, so the
  // existsSync pre-check is unnecessary and would block the event loop on a
  // multi-GB workspace if we kept the sync rmSync. Async rm yields to libuv
  // between syscalls.
  const workdir = getWorkdir(task);
  try {
    await fsp.rm(workdir, { recursive: true, force: true });
  } catch (err) {
    log.warn(
      { event: 'reset_workspace_delete_failed', task_id: task.id, err },
      'Failed to delete workspace'
    );
  }

  // 5. Remove status/* labels only (preserve human-merge, human-review, repo/* labels)
  if (repo) {
    try {
      const issue = await forgejo.getIssue(repo, task.issue_id);
      const nonStatusLabels = issue.labels.filter(
        (l) => !l.name.startsWith('status/')
      );
      if (nonStatusLabels.length !== issue.labels.length) {
        // There were status labels to remove — replace with only the non-status ones
        await forgejo.replaceLabel(
          repo,
          task.issue_id,
          nonStatusLabels.map((l) => l.id)
        );
      }
    } catch { /* best effort */ }

    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Task reset: ${reason}. Branch, PR, and workspace deleted. Issue is unqueued.`
      );
    } catch { /* best effort */ }
  }

  // 6. Clean up internal state
  // Drop step checkpoints from the pre-reset run. The attempt counter is
  // recycled below (back to 1 on a user reset), and checkpoints are keyed
  // only on (task_id, attempt_number, step_name) — leaving them would let a
  // requeued attempt replay a stale `verify-push`/`create-pr` and try to
  // merge the PR that this reset just closed (Forgejo 404 → task failed).
  deleteStepsForTask(task.id);
  recordTaskEvent(task.id, 'task_reset', `Reset: ${reason}`);
  const nextStatus = requeue ? 'queued' : 'reset';
  const nextAttempt = incrementAttempt ? task.attempt + 1 : 1;
  // When requeuing, place the task at the back of the FIFO queue. Mirrors
  // insertTask's default behaviour so we don't accidentally jump the line.
  const queuePosition = requeue
    ? ((
        getDb()
          .prepare('SELECT MAX(queue_position) as max_pos FROM tasks')
          .get() as { max_pos: number | null }
      ).max_pos ?? 0) + 1
    : null;
  updateTaskWithSync(task.id, {
    status: nextStatus,
    branch_name: null,
    pr_number: null,
    container_id: null,
    attempt: nextAttempt,
    prep_failure_count: 0,
    // Clear the git-outage backoff state too: a reset wipes the workspace,
    // so any pending prep backoff or deferred salvage refers to work that
    // no longer exists. Leaving `prep_next_attempt_at` set would park the
    // freshly-requeued task for up to 30 minutes for no reason.
    prep_backoff_level: 0,
    prep_next_attempt_at: null,
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
    started_at: null,
    completed_at: null,
    queue_position: queuePosition,
  });

  log.info(
    { event: 'task_reset', task_id: task.id, reason },
    'Task reset'
  );

// 7. Trigger fill to use freed slot
  scheduler.triggerTick();
}

/**
 * Extend a task — bump max_attempts by additionalAttempts, transition the task
 * back to a runnable state, and let the existing rework path pick it up.
 *
 * - If the task has a PR, status → 'changes-needed' (rework path).
 * - If no PR, status → 'queued' (placed at back of FIFO queue).
 * - attempt counter is left unchanged.
 * - completed_at is cleared.
 */
export async function extendTask(
  task: Task,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger,
  additionalAttempts: number,
): Promise<void> {
  const repo = getRepo(task.repo_id);
  const oldMaxAttempts = task.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  const newMaxAttempts = oldMaxAttempts + additionalAttempts;

  // 1. Record event
  recordTaskEvent(
    task.id,
    'task_extended',
    `Extended by ${additionalAttempts} (max_attempts ${oldMaxAttempts} → ${newMaxAttempts})`
  );

  // 2. Determine new status and queue placement
  const hasPr = task.pr_number != null;
  const nextStatus = hasPr ? 'changes-needed' : 'queued';

  let queuePosition: number | null = null;
  if (!hasPr) {
    queuePosition =
      ((
        getDb()
          .prepare('SELECT MAX(queue_position) as max_pos FROM tasks')
          .get() as { max_pos: number | null }
      ).max_pos ?? 0) + 1;
  }

  // 3. Update DB with sync (handles label swap)
  updateTaskWithSync(task.id, {
    status: nextStatus,
    max_attempts: newMaxAttempts,
    completed_at: null,
    queue_position: queuePosition,
  });

  // 4. Best-effort Forgejo issue comment
  if (repo) {
    try {
      const prClause = hasPr ? ` Resuming from existing PR #${task.pr_number}.` : '';
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Task extended: granted ${additionalAttempts} more attempt${additionalAttempts === 1 ? '' : 's'} (max_attempts is now ${newMaxAttempts}).${prClause}`
      );
    } catch {
      // Best effort
    }
  }

  log.info(
    { event: 'task_extended', task_id: task.id, additionalAttempts, newMaxAttempts },
    'Task extended'
  );

  // 5. Trigger scheduler so the task is picked up promptly
  scheduler.triggerTick();
}

/**
 * Requeue a task — set status to queued, assign next queue position,
 * clear timing, post comment and record event.
 */
export async function requeueTask(
  task: Task,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger,
): Promise<void> {
  const repo = getRepo(task.repo_id);

  // 1. Record event
  recordTaskEvent(task.id, 'task_requeued', 'Task requeued by user');

  // 2. Update Forgejo issue
  if (repo) {
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        'Task has been requeued and is waiting for a slot.'
      );
    } catch {
      // Best effort
    }
  }

  // 3. Calculate next queue position
  const queuePosition =
    ((
      getDb()
        .prepare('SELECT MAX(queue_position) as max_pos FROM tasks')
        .get() as { max_pos: number | null }
    ).max_pos ?? 0) + 1;

  // 4. Update DB with sync (handles label sync)
  updateTaskWithSync(task.id, {
    status: 'queued',
    queue_position: queuePosition,
    started_at: null,
    completed_at: null,
  });

  log.info(
    { event: 'task_requeued', task_id: task.id },
    'Task requeued'
  );

  // 5. Trigger scheduler
  scheduler.triggerTick();
}
