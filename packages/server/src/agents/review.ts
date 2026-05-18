import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '@orchestrator/shared';
import { getRepo, getTask, updateTask } from '../db.js';
import { updateTaskWithSync, recordTaskEvent } from '../state-sync.js';
import type { ForgejoClient } from '../forgejo.js';
import { getOutputDir } from '../workspace.js';
import { DEFAULT_MAX_ATTEMPTS } from '../constants.js';
import {
  resolveMergeStrategy,
  type ForgejoMergeStrategy,
  type PreferredMergeStrategy,
} from '../merge-strategy.js';
import type { FastifyBaseLogger } from 'fastify';

const MAX_REVIEW_RETRIES = 2;

const RUBRIC_DIMENSIONS = [
  'requirements',
  'correctness',
  'tests',
  'security',
  'quality',
] as const;

type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

interface RubricEntry {
  status: 'pass' | 'concern' | 'fail' | string;
  note?: string;
}

interface FeedbackItem {
  file: string;
  line: number;
  category?: RubricDimension | string;
  severity?: 'blocker' | 'major' | 'minor' | string;
  comment: string;
  suggestion?: string;
}

interface ReviewVerdict {
  verdict: 'approved' | 'changes_needed' | 'unclear';
  summary?: string;
  rubric?: Partial<Record<RubricDimension, RubricEntry>> &
    Record<string, RubricEntry>;
  // New shape carries category/severity/suggestion. The legacy
  // {file,line,comment} object shape and a bare string are still accepted
  // because review.json is LLM-produced and must degrade gracefully.
  feedback?:
    | FeedbackItem[]
    | Array<{ file: string; line: number; comment: string }>
    | string;
}

const SEVERITY_ORDER = ['blocker', 'major', 'minor'] as const;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Render the rubric object as a short markdown summary. Tolerates a missing,
 * partial, or extra-keyed rubric without throwing.
 */
export function formatRubricMarkdown(
  rubric: ReviewVerdict['rubric']
): string {
  if (!rubric || typeof rubric !== 'object') return '';
  const keys = Object.keys(rubric);
  const ordered = [
    ...RUBRIC_DIMENSIONS.filter((k) => k in rubric),
    ...keys.filter((k) => !(RUBRIC_DIMENSIONS as readonly string[]).includes(k)),
  ];
  const lines: string[] = [];
  for (const key of ordered) {
    const entry = (rubric as Record<string, RubricEntry>)[key];
    if (!entry || typeof entry !== 'object') continue;
    const status = asString(entry.status) ?? 'unknown';
    const note = asString(entry.note);
    lines.push(
      `- **${key}**: ${status.toUpperCase()}${note ? ` — ${note}` : ''}`
    );
  }
  if (lines.length === 0) return '';
  return `### Rubric\n\n${lines.join('\n')}`;
}

/**
 * Render review feedback as a readable, grouped markdown list (by severity,
 * then file). Handles the new shape, the legacy {file,line,comment} shape,
 * and a bare string. Never throws on malformed input.
 */
export function formatReviewFeedback(
  feedback: ReviewVerdict['feedback']
): string {
  if (feedback == null) return '';
  if (typeof feedback === 'string') return feedback.trim();
  if (!Array.isArray(feedback)) {
    try {
      return JSON.stringify(feedback, null, 2);
    } catch {
      return String(feedback);
    }
  }
  if (feedback.length === 0) return '';

  const items = feedback.map((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const lineRaw = f.line;
    const line =
      typeof lineRaw === 'number'
        ? String(lineRaw)
        : typeof lineRaw === 'string' && lineRaw.trim() !== ''
          ? lineRaw.trim()
          : null;
    return {
      file: asString(f.file) ?? 'unknown',
      line,
      category: asString(f.category),
      severity: asString(f.severity)?.toLowerCase() ?? null,
      comment: asString(f.comment) ?? '',
      suggestion: asString(f.suggestion),
    };
  });

  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const sev =
      item.severity &&
      (SEVERITY_ORDER as readonly string[]).includes(item.severity)
        ? item.severity
        : 'other';
    const bucket = groups.get(sev);
    if (bucket) bucket.push(item);
    else groups.set(sev, [item]);
  }

  const severityKeys = [
    ...SEVERITY_ORDER.filter((s) => groups.has(s)),
    ...[...groups.keys()].filter(
      (s) => !(SEVERITY_ORDER as readonly string[]).includes(s)
    ),
  ];

  const sections: string[] = [];
  for (const sev of severityKeys) {
    const groupItems = [...groups.get(sev)!].sort((a, b) =>
      a.file.localeCompare(b.file)
    );
    const heading =
      sev === 'other' ? 'Other' : sev.charAt(0).toUpperCase() + sev.slice(1);
    const lines: string[] = [`#### ${heading}`];
    for (const item of groupItems) {
      const loc = item.line != null ? `${item.file}:${item.line}` : item.file;
      const cat = item.category ? ` _(${item.category})_` : '';
      lines.push(`- **${loc}**${cat}: ${item.comment}`.trimEnd());
      if (item.suggestion) {
        lines.push(`  - Suggested change: ${item.suggestion}`);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * Build the full markdown body (rubric summary + grouped feedback) used for
 * the PR comment, the issue comment, and the rework prompt handed back to the
 * dev agent. Always returns a string; degrades gracefully on legacy/malformed
 * review.json.
 */
export function formatReviewForRework(review: ReviewVerdict): string {
  const parts: string[] = [];
  const rubricMd = formatRubricMarkdown(review.rubric);
  if (rubricMd) parts.push(rubricMd);
  const feedbackMd = formatReviewFeedback(review.feedback);
  if (feedbackMd) parts.push(`### Feedback\n\n${feedbackMd}`);
  return parts.join('\n\n');
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

  // Resolve merge strategy: ask Forgejo which styles the repo permits, then
  // pick one. Rules (see merge-strategy.ts):
  //   1. exactly one allowed → use it (operator preference is moot)
  //   2. multiple allowed AND operator's preferred is in the set → use preferred
  //   3. multiple allowed but preferred not in set → first from PRIORITY_ORDER
  // Falls back to the operator's preference verbatim if Forgejo is unreachable
  // or the API call fails (preserves prior behaviour on transient failures).
  const preferred = (repo.merge_strategy ?? 'squash') as PreferredMergeStrategy;
  let mergeStrategy: ForgejoMergeStrategy = preferred;
  let mergeReason: string = 'preferred (no Forgejo check)';
  try {
    const allowed = await forgejo.getRepoMergeOptions(repo);
    const resolved = resolveMergeStrategy(allowed, preferred);
    mergeStrategy = resolved.strategy;
    mergeReason = resolved.reason;
    if (resolved.reason === 'fallback') {
      log.warn(
        {
          event: 'merge_strategy_fallback',
          task_id: task.id,
          preferred,
          chosen: resolved.strategy,
          allowed,
        },
        `Repo doesn't allow preferred merge strategy '${preferred}'; falling back to '${resolved.strategy}'`
      );
    }
  } catch (err) {
    log.warn(
      { event: 'merge_options_fetch_failed', task_id: task.id, err },
      'Could not fetch repo merge options; using preferred strategy verbatim'
    );
  }

  // Pre-merge check: verify PR is still mergeable
  try {
    const pr = await forgejo.getPullRequest(repo, freshTask.pr_number!);

    // Empty-diff guard: Forgejo's merge endpoint returns 405 (not a clean
    // error) when the PR has no changes against base. Fail with a clear
    // message before that happens. postDevAgent has its own empty-diff guard
    // at PR creation; this is the backstop for any path that bypasses it.
    if (pr.changed_files === 0) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `PR #${freshTask.pr_number} has no changes against ${repo.base_branch} — nothing to merge. PR left open for inspection; use Reset to retry.`
        );
      } catch { /* best effort */ }
      log.error(
        {
          event: 'merge_empty_diff',
          task_id: task.id,
          pr_number: freshTask.pr_number,
        },
        'PR has no changes against base — refusing to attempt merge'
      );
      return;
    }

    if (pr.mergeable === false) {
      const newAttempt = freshTask.attempt + 1;
      const maxAttempts = freshTask.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
      if (newAttempt > maxAttempts) {
        updateTaskWithSync(task.id, {
          status: 'failed',
          attempt: newAttempt,
          completed_at: new Date().toISOString(),
        });
        try {
          await forgejo.commentOnIssue(
            repo,
            task.issue_id,
            `PR not mergeable after ${maxAttempts} attempts.`
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
    recordTaskEvent(
      task.id,
      'pr_merged',
      `PR #${freshTask.pr_number} merged via ${mergeStrategy} (${mergeReason})`
    );
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

    // Recover from "merge actually succeeded but the client couldn't see it".
    // Known case: POST /pulls/:id/merge returned 200 with an empty body, and
    // the Forgejo client previously crashed trying to JSON.parse(""). A
    // subsequent retry then hits 405 because the PR is already merged.
    // Either way, the PR is merged on the server — honour that rather than
    // marking the task failed. We re-fetch the PR and trust its `merged`
    // field as the source of truth.
    try {
      const pr = await forgejo.getPullRequest(repo, freshTask.pr_number!);
      if (pr.merged) {
        recordTaskEvent(
          task.id,
          'pr_merged',
          `PR #${freshTask.pr_number} merged via ${mergeStrategy} (detected after post-merge client error: ${errorMsg})`
        );
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
          {
            event: 'task_merged_after_client_error',
            task_id: task.id,
            pr_number: freshTask.pr_number,
            original_error: errorMsg,
          },
          'PR was already merged — recovering from client-side error'
        );
        return;
      }
    } catch {
      // PR lookup itself failed — fall through to original error handling.
    }

    const isConflict =
      errorMsg.includes('conflict') || errorMsg.includes('409');

    if (isConflict) {
      // Merge conflict — rework
      const newAttempt = freshTask.attempt + 1;
      const maxAttempts = freshTask.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

      if (newAttempt > maxAttempts) {
        updateTaskWithSync(task.id, {
          status: 'failed',
          attempt: newAttempt,
          completed_at: new Date().toISOString(),
        });
        try {
          await forgejo.commentOnIssue(
            repo,
            task.issue_id,
            `Merge conflict after ${maxAttempts} attempts.`
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

  // Fetch PR diff stats for the verdict event and the empty-diff guard below.
  // Best effort: if this fails the verdict still gets recorded (without
  // stats) and the empty-diff guard is skipped — attemptMerge has its own
  // empty-diff guard as a backstop.
  let prStats: { changed_files: number; additions: number; deletions: number } | null = null;
  if (freshTask.pr_number) {
    try {
      const pr = await forgejo.getPullRequest(repo, freshTask.pr_number);
      prStats = {
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
      };
    } catch {
      // Best effort
    }
  }

  const statsSuffix = prStats
    ? ` (changed_files=${prStats.changed_files}, additions=${prStats.additions}, deletions=${prStats.deletions})`
    : '';
  recordTaskEvent(
    task.id,
    'review_verdict',
    `Review verdict: ${review.verdict}${statsSuffix}${review.summary ? ' — ' + review.summary : ''}`
  );

  // Guard: an "approved" verdict on a zero-diff PR is a model hallucination.
  // postDevAgent's PR-create check should have prevented us from ever
  // reaching review with an empty PR, but if state changed since (or this
  // function is called via a future code path that bypasses postDevAgent),
  // refuse to act on the verdict and fail the task.
  if (
    review.verdict === 'approved' &&
    prStats !== null &&
    prStats.changed_files === 0
  ) {
    updateTaskWithSync(task.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    });
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Review approved but PR #${freshTask.pr_number} has no changes against ${repo.base_branch}. Rejecting verdict and failing task. PR left open for inspection; use Reset to retry.`
      );
    } catch { /* best effort */ }
    log.error(
      {
        event: 'review_approved_empty_diff',
        task_id: task.id,
        pr_number: freshTask.pr_number,
      },
      'Review approved an empty PR — refusing verdict and failing task'
    );
    return;
  }

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
    const maxAttempts = freshTask.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
    const feedbackStr = formatReviewForRework(review);
    const summary = review.summary ?? '';

    // Post feedback as PR comment and issue comment, rendered as readable
    // markdown (rubric summary + grouped feedback) rather than raw JSON.
    try {
      if (freshTask.pr_number) {
        await forgejo.commentOnPr(
          repo,
          freshTask.pr_number,
          `Review found issues (attempt ${freshTask.attempt}):\n\n${summary}\n\n${feedbackStr}`
        );
      }
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Review found issues (attempt ${freshTask.attempt}). Sending back for rework.\n\n${summary}\n\n${feedbackStr}`
      );
    } catch { /* best effort */ }

    if (newAttempt > maxAttempts) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        attempt: newAttempt,
        completed_at: new Date().toISOString(),
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Failed after ${maxAttempts} attempts.`
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
