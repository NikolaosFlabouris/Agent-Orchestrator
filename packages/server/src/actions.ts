import fs from 'node:fs';
import type { Task } from '@orchestrator/shared';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { getRepo, getTask, updateTask, getDb } from './db.js';
import { updateTaskWithSync, recordTaskEvent } from './state-sync.js';
import type { ForgejoClient } from './forgejo.js';
import {
  getContainer,
  stopContainer,
  removeContainer,
} from './docker.js';
import { getWorkdir } from './workspace.js';
import type { Scheduler } from './scheduler.js';
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
      await forgejo.commentOnPr(repo, task.pr_number, `Task cancelled: ${reason}`);
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
      await forgejo.commentOnPr(repo, task.pr_number, `Task reset: ${reason}`);
      await forgejo.closePullRequest(repo, task.pr_number);
    } catch {
      // Best effort
    }
  }

  // 4. Delete local workspace
  const workdir = getWorkdir(task);
  if (fs.existsSync(workdir)) {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { event: 'reset_workspace_delete_failed', task_id: task.id, err },
        'Failed to delete workspace'
      );
    }
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
