import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '@orchestrator/shared';
import { getRepo, getTask, getSetting, updateTask } from '../db.js';
import { updateTaskWithSync, recordTaskEvent } from '../state-sync.js';
import type { ForgejoClient } from '../forgejo.js';
import { getOutputDir } from '../workspace.js';
import type { FastifyBaseLogger } from 'fastify';

const MAX_REVIEW_RETRIES = 2;

interface ReviewVerdict {
  verdict: 'approved' | 'changes_needed' | 'unclear';
  summary?: string;
  feedback?: Array<{ file: string; line: number; comment: string }> | string;
}

/**
 * Attempt to merge the PR. Handles conflicts by sending back for rework.
 */
export async function attemptMerge(
  task: Task,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger,
  launchDevContainer: (task: Task, feedback?: string | null) => Promise<void>
): Promise<void> {
  const repo = getRepo(task.repo_id);
  if (!repo) return;

  const freshTask = getTask(task.id)!;
  const mergeStrategy =
    (getSetting('merge_strategy') as 'squash' | 'merge' | 'rebase') ?? 'squash';

  // Pre-merge check: verify PR is still mergeable
  try {
    const pr = await forgejo.getPullRequest(repo, freshTask.pr_number!);
    if (pr.mergeable === false) {
      const newAttempt = freshTask.attempt + 1;
      if (newAttempt > freshTask.max_attempts) {
        updateTaskWithSync(task.id, {
          status: 'failed',
          attempt: newAttempt,
          completed_at: new Date().toISOString(),
        });
        try {
          await forgejo.commentOnIssue(
            repo,
            task.issue_id,
            `PR not mergeable after ${freshTask.max_attempts} attempts.`
          );
        } catch { /* best effort */ }
        log.error(
          { event: 'merge_not_mergeable_exhausted', task_id: task.id },
          'PR not mergeable — max attempts exhausted'
        );
        return;
      }
      // Rework in same slot — task needs to rebase
      updateTaskWithSync(task.id, {
        status: 'changes-needed',
        attempt: newAttempt,
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Base branch has moved. Sending back for rebase (attempt ${newAttempt}).`
        );
      } catch { /* best effort */ }
      log.warn(
        { event: 'merge_not_mergeable_rework', task_id: task.id, attempt: newAttempt },
        'PR not mergeable — sending back for rework'
      );
      const updatedTask = getTask(task.id)!;
      await launchDevContainer(updatedTask, `Rebase onto latest ${repo.base_branch}.`);
      return;
    }
  } catch {
    // Can't check mergeability — proceed with merge attempt
  }

  try {
    await forgejo.mergePullRequest(repo, freshTask.pr_number!, mergeStrategy);

    // Merge succeeded
    recordTaskEvent(task.id, 'pr_merged', `PR #${freshTask.pr_number} merged via ${mergeStrategy}`);
    updateTaskWithSync(task.id, {
      status: 'merged',
      completed_at: new Date().toISOString(),
    });

    try {
      await forgejo.closeIssue(repo, task.issue_id);
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Merged via PR #${freshTask.pr_number}.`
      );
    } catch { /* best effort */ }

    log.info(
      { event: 'task_merged', task_id: task.id, pr_number: freshTask.pr_number },
      'PR merged successfully'
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isConflict =
      errorMsg.includes('conflict') || errorMsg.includes('409');

    if (isConflict) {
      // Merge conflict — rework
      const newAttempt = freshTask.attempt + 1;

      if (newAttempt > freshTask.max_attempts) {
        updateTaskWithSync(task.id, {
          status: 'failed',
          attempt: newAttempt,
          completed_at: new Date().toISOString(),
        });
        try {
          await forgejo.commentOnIssue(
            repo,
            task.issue_id,
            `Merge conflict after ${freshTask.max_attempts} attempts.`
          );
        } catch { /* best effort */ }
        log.error(
          { event: 'merge_conflict_exhausted', task_id: task.id },
          'Merge conflict — max attempts exhausted'
        );
        return;
      }

      // Rework in same slot
      updateTaskWithSync(task.id, {
        status: 'changes-needed',
        attempt: newAttempt,
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Merge conflict against ${repo.base_branch}. Sending back for resolution (attempt ${newAttempt}).`
        );
      } catch { /* best effort */ }
      log.warn(
        { event: 'merge_conflict_rework', task_id: task.id, attempt: newAttempt },
        'Merge conflict — sending back for rework'
      );

      const updatedTask = getTask(task.id)!;
      await launchDevContainer(
        updatedTask,
        `Resolve conflicts with ${repo.base_branch}.`
      );
    } else {
      // Unexpected merge error
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Merge failed unexpectedly: ${errorMsg}. PR #${freshTask.pr_number} may need manual attention.`
        );
      } catch { /* best effort */ }
      log.error(
        { event: 'merge_failed', task_id: task.id, err },
        'Unexpected merge failure'
      );
    }
  }
}

/**
 * Process the review verdict after a successful review agent run.
 */
export async function processReviewVerdict(
  task: Task,
  review: ReviewVerdict,
  preReviewSha: string | undefined,
  reviewRetryCount: number,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger,
  launchDevContainer: (task: Task, feedback?: string | null) => Promise<void>,
  launchReviewContainer: (task: Task) => Promise<void>
): Promise<void> {
  const repo = getRepo(task.repo_id);
  if (!repo) return;

  const freshTask = getTask(task.id)!;

  // Verify the review agent didn't modify the branch
  if (preReviewSha) {
    try {
      const branch = await forgejo.getBranch(repo, task.branch_name!);
      if (branch.commit.id !== preReviewSha) {
        log.warn(
          {
            event: 'review_modified_branch',
            task_id: task.id,
            pre: preReviewSha,
            post: branch.commit.id,
          },
          'Review agent modified the branch'
        );
      }
    } catch {
      // Best effort
    }
  }

  recordTaskEvent(task.id, 'review_verdict', `Review verdict: ${review.verdict}${review.summary ? ' — ' + review.summary : ''}`);

  if (review.verdict === 'approved') {
    // Check for human-merge label
    let hasHumanMerge = false;
    try {
      const issue = await forgejo.getIssue(repo, task.issue_id);
      hasHumanMerge = issue.labels.some(
        (l) => l.name === 'human-merge'
      );
    } catch {
      // Best effort
    }

    if (hasHumanMerge) {
      updateTaskWithSync(task.id, {
        status: 'awaiting-human-merge',
        completed_at: new Date().toISOString(),
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Review approved. PR #${freshTask.pr_number} ready for manual merge.`
        );
      } catch { /* best effort */ }
      log.info(
        { event: 'awaiting_human_merge', task_id: task.id },
        'Review approved — awaiting human merge'
      );
    } else {
      await attemptMerge(task, forgejo, log, launchDevContainer);
    }
  } else if (review.verdict === 'changes_needed') {
    const newAttempt = freshTask.attempt + 1;
    const feedbackStr =
      typeof review.feedback === 'string'
        ? review.feedback
        : JSON.stringify(review.feedback, null, 2);

    // Post feedback as PR comment and issue comment
    try {
      if (freshTask.pr_number) {
        await forgejo.commentOnPr(
          repo,
          freshTask.pr_number,
          `Review found issues (attempt ${freshTask.attempt}):\n\n${review.summary ?? ''}\n\n${feedbackStr}`
        );
      }
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Review found issues (attempt ${freshTask.attempt}). Sending back for rework.\n\n${review.summary ?? ''}`
      );
    } catch { /* best effort */ }

    if (newAttempt > freshTask.max_attempts) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        attempt: newAttempt,
        completed_at: new Date().toISOString(),
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Failed after ${freshTask.max_attempts} attempts.`
        );
      } catch { /* best effort */ }
      log.error(
        { event: 'review_exhausted', task_id: task.id },
        'Changes needed but max attempts exhausted'
      );
    } else {
      // Rework in same slot
      updateTaskWithSync(task.id, {
        status: 'changes-needed',
        attempt: newAttempt,
      });
      log.info(
        { event: 'rework_cycle', task_id: task.id, attempt: newAttempt },
        'Review rejected — starting rework'
      );

      const updatedTask = getTask(task.id)!;
      await launchDevContainer(updatedTask, feedbackStr);
    }
  } else if (review.verdict === 'unclear') {
    updateTaskWithSync(task.id, {
      status: 'needs-human-review',
      completed_at: new Date().toISOString(),
    });
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Review agent produced unclear verdict. Human review required for PR #${freshTask.pr_number}.`
      );
    } catch { /* best effort */ }
    log.info(
      { event: 'needs_human_review', task_id: task.id },
      'Unclear review verdict — needs human review'
    );
  }
}

/**
 * Handle review agent failure — retry or escalate.
 */
export async function handleReviewFailure(
  task: Task,
  reviewRetryCount: number,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger,
  launchReviewContainer: (task: Task) => Promise<void>
): Promise<{ shouldRetry: boolean; newRetryCount: number }> {
  const repo = getRepo(task.repo_id);
  const newRetryCount = reviewRetryCount + 1;

  if (newRetryCount <= MAX_REVIEW_RETRIES) {
    log.warn(
      { event: 'review_failed_retry', task_id: task.id, retry: newRetryCount },
      'Review agent failed, retrying'
    );
    await launchReviewContainer(task);
    return { shouldRetry: true, newRetryCount };
  }

  // Exceeded retries — escalate to human
  updateTaskWithSync(task.id, {
    status: 'needs-human-review',
    completed_at: new Date().toISOString(),
  });
  try {
    if (repo) {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Review agent failed ${MAX_REVIEW_RETRIES + 1} times. Human review required.`
      );
    }
  } catch { /* best effort */ }
  log.error(
    { event: 'review_retries_exhausted', task_id: task.id },
    'Review agent failed — escalating to human review'
  );
  return { shouldRetry: false, newRetryCount };
}
