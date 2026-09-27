import type { Task } from '@orchestrator/shared';
import { getRepo } from '../db.js';
import { updateTaskWithSync, recordTaskEvent } from '../state-sync.js';
import type { ForgejoClient } from '../forgejo.js';
import {
  permanentFailureHint,
  type PermanentFailureCategory,
} from '../failure-classifier.js';
import type { FastifyBaseLogger } from 'fastify';

/** Operator-facing comment for a non-retryable failure. Exported so tests
 *  can pin the wording. */
export function formatPermanentFailureComment(
  stage: 'develop' | 'review',
  attempt: number,
  category: PermanentFailureCategory,
  errorDetail: string
): string {
  const agent = stage === 'develop' ? 'Dev' : 'Review';
  const quoted = errorDetail.trim().replace(/```/g, "'''");
  return [
    `${agent} agent failed with a non-retryable environment error (attempt ${attempt}); not retrying.`,
    '',
    '```',
    quoted,
    '```',
    '',
    `${permanentFailureHint(category)}, then use Extend to retry.`,
  ].join('\n');
}

/**
 * Stop a task after a permanent (non-retryable) agent failure: transition it
 * to `failed` without consuming further attempts, record an event, post a
 * Forgejo comment and log `permanent_failure`. The attempt counter advances
 * past the attempt that just ran, exactly as when attempts are exhausted, so
 * Extend starts a fresh attempt number (checkpoints are keyed by it) and
 * behaves as for any failed task.
 */
export async function failTaskPermanently(
  task: Task,
  stage: 'develop' | 'review',
  category: PermanentFailureCategory,
  errorDetail: string,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  const repo = getRepo(task.repo_id);
  updateTaskWithSync(task.id, {
    status: 'failed',
    attempt: task.attempt + 1,
    completed_at: new Date().toISOString(),
  });
  recordTaskEvent(
    task.id,
    'permanent_failure',
    `Non-retryable ${stage} agent error (${category}): ${errorDetail}`
  );
  try {
    if (repo) {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        formatPermanentFailureComment(stage, task.attempt, category, errorDetail)
      );
    }
  } catch { /* best effort */ }
  log.error(
    {
      event: 'permanent_failure',
      task_id: task.id,
      stage,
      category,
      attempt: task.attempt,
      error: errorDetail,
    },
    'Agent failed with a non-retryable error — task failed without retry'
  );
}
