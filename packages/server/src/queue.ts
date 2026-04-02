import type { Task } from '@orchestrator/shared';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import {
  getTasks,
  getQueuedTasks,
  getActiveTaskCount,
  getRepo,
  getSettingInt,
  updateTask,
} from './db.js';
import type { ForgejoClient } from './forgejo.js';
import type { FastifyBaseLogger } from 'fastify';

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

/**
 * Parse dependency issue numbers from checklist items in the issue body.
 * Matches lines like: - [ ] #38
 */
export function parseDependencies(issueBody: string): number[] {
  const deps: number[] = [];
  const regex = /^-\s*\[\s*\]\s*#(\d+)/gm;
  let match;
  while ((match = regex.exec(issueBody)) !== null) {
    deps.push(parseInt(match[1], 10));
  }
  return deps;
}

/**
 * Check if all dependency issues are closed via Forgejo API.
 */
export async function checkDependenciesMet(
  forgejo: ForgejoClient,
  task: Task,
  log: FastifyBaseLogger
): Promise<boolean> {
  const repo = getRepo(task.repo_id);
  if (!repo) return false;

  let issueBody: string;
  try {
    const issue = await forgejo.getIssue(repo, task.issue_id);
    issueBody = issue.body;
  } catch {
    log.warn(
      { event: 'dependency_check_failed', task_id: task.id },
      'Could not fetch issue to check dependencies'
    );
    return false;
  }

  const deps = parseDependencies(issueBody);
  if (deps.length === 0) return true;

  for (const depIssueId of deps) {
    try {
      const depIssue = await forgejo.getIssue(repo, depIssueId);
      if (depIssue.state !== 'closed') {
        log.debug(
          { event: 'dependency_not_met', task_id: task.id, dep_issue: depIssueId },
          'Dependency issue not closed'
        );
        return false;
      }
    } catch {
      log.warn(
        { event: 'dependency_check_error', task_id: task.id, dep_issue: depIssueId },
        'Could not check dependency issue status'
      );
      return false;
    }
  }

  return true;
}

/**
 * Get the number of available slots.
 */
export function getAvailableSlots(): number {
  const maxConcurrency = getSettingInt('max_concurrency');
  const activeCount = getActiveTaskCount();
  return Math.max(0, maxConcurrency - activeCount);
}
