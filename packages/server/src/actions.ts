import fs from 'node:fs';
import type { Task } from '@orchestrator/shared';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { getRepo, getTask, updateTask } from './db.js';
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

/**
 * Reset a task — stop container, delete branch, close PR, delete workspace,
 * remove labels, reset counters. Destructive operation.
 */
export async function resetTask(
  task: Task,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger,
  reason: string = 'Reset by user'
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
  updateTaskWithSync(task.id, {
    status: 'reset',
    branch_name: null,
    pr_number: null,
    container_id: null,
    attempt: 1,
    prep_failure_count: 0,
    started_at: null,
    completed_at: null,
  });

  log.info(
    { event: 'task_reset', task_id: task.id, reason },
    'Task reset'
  );

  // 7. Trigger fill to use freed slot
  scheduler.triggerTick();
}
