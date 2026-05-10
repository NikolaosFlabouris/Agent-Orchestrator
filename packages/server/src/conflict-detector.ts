import type { Task } from '@orchestrator/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getRepo, getTask, getTasks } from './db.js';
import type { ForgejoClient } from './forgejo.js';
import { updateTaskWithSync, recordTaskEvent } from './state-sync.js';
import { DEFAULT_MAX_ATTEMPTS } from './constants.js';

/** The three outcomes the detector decides between. Extracted so the decision
 *  is a pure function that can be unit-tested without mocking the DB/API.
 *  - `none`   → PR is still mergeable (or mergeability not yet determined);
 *               leave the task where it is.
 *  - `rebase` → promote the task to `changes-needed` so an agent rebases.
 *  - `fail`   → budget exhausted; mark the task failed and comment. */
export type ConflictAction = 'none' | 'rebase' | 'fail';

export function decideConflictAction(
  prMergeable: boolean | null | undefined,
  currentAttempt: number,
  maxAttempts: number
): ConflictAction {
  // Forgejo returns `null` while mergeability is still being computed; treat
  // that as "don't know, don't touch". Only act on an explicit `false`.
  if (prMergeable !== false) return 'none';
  if (currentAttempt + 1 > maxAttempts) return 'fail';
  return 'rebase';
}

/**
 * Check whether a task's PR has become unmergeable (typically because another
 * sibling task merged and moved the base branch forward), and if so kick the
 * task back into the rework flow so an agent can rebase it.
 *
 * Intended for tasks sitting in `awaiting-human-merge` — they have an approved
 * review, a `human-merge` label telling the orchestrator to step aside, and an
 * open PR. When a sibling merges, one of those open PRs may go stale; this
 * function promotes it from terminal (`awaiting-human-merge`) back into the
 * active pipeline (`changes-needed`) so the scheduler's `fillSlots` picks it
 * up on the next tick.
 *
 * The `human-merge` label on the Forgejo issue is preserved through the status
 * transition by `state-sync.ts`'s label sync (which only touches `status/*`
 * labels). Once the rebase + re-review completes, the review agent sees the
 * surviving `human-merge` label and routes the task back to
 * `awaiting-human-merge` automatically.
 *
 * Respects `max_attempts`: if the task has already exhausted its budget, the
 * conflicted PR is flagged `failed` with an explanatory comment rather than
 * spinning an attempt it can't complete.
 *
 * Returns true when the task was transitioned (rebase queued); false
 * otherwise (PR still mergeable, PR missing, or API error — best effort).
 */
export async function checkHumanMergeConflict(
  task: Task,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<boolean> {
  if (task.status !== 'awaiting-human-merge') return false;
  if (!task.pr_number) return false;

  const repo = getRepo(task.repo_id);
  if (!repo) return false;

  let mergeable: boolean | undefined;
  try {
    const pr = await forgejo.getPullRequest(repo, task.pr_number);
    // If PR was merged or closed, leave it alone.
    if (pr.merged || pr.state === 'closed') return false;
    mergeable = pr.mergeable;
  } catch (err) {
    log.warn(
      { event: 'conflict_check_api_error', task_id: task.id, err },
      'Could not fetch PR to check mergeability'
    );
    return false;
  }

  const fresh = getTask(task.id);
  if (!fresh || fresh.status !== 'awaiting-human-merge') {
    // Raced with another detector; skip.
    return false;
  }

  const maxAttempts = fresh.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  const action = decideConflictAction(mergeable, fresh.attempt, maxAttempts);
  if (action === 'none') return false;

  const newAttempt = fresh.attempt + 1;

  if (action === 'fail') {
    updateTaskWithSync(task.id, {
      status: 'failed',
      attempt: newAttempt,
      completed_at: new Date().toISOString(),
    });
    recordTaskEvent(
      task.id,
      'merge_conflict_exhausted',
      `PR #${task.pr_number} became unmergeable after a sibling merge. Max attempts reached.`
    );
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `PR #${task.pr_number} is no longer mergeable after a sibling task's merge, and this task has already used its ${maxAttempts} attempts. Rebase manually or Reset the task to try again.`
      );
    } catch {
      /* best effort */
    }
    log.warn(
      {
        event: 'human_merge_conflict_exhausted',
        task_id: task.id,
        pr_number: task.pr_number,
      },
      'Awaiting-human-merge task conflicted but attempt budget exhausted'
    );
    return false;
  }

  // Promote back into the active pipeline as a rework. The scheduler's
  // fillSlots treats `changes-needed` without a container as orphaned rework
  // and launches a dev container on the next tick. completed_at is cleared
  // so the task no longer looks terminal in the UI.
  updateTaskWithSync(task.id, {
    status: 'changes-needed',
    attempt: newAttempt,
    completed_at: null,
  });
  recordTaskEvent(
    task.id,
    'auto_rebase_queued',
    `Sibling merge moved ${repo.base_branch} forward. Queued agent to rebase (attempt ${newAttempt}).`
  );

  try {
    await forgejo.commentOnIssue(
      repo,
      task.issue_id,
      `A sibling task's merge created conflicts with this PR. Queuing an agent to rebase onto the latest \`${repo.base_branch}\` (attempt ${newAttempt}). The task will return to **awaiting-human-merge** once the rebase is clean.`
    );
  } catch {
    /* best effort */
  }

  log.info(
    {
      event: 'human_merge_conflict_rebase_queued',
      task_id: task.id,
      pr_number: task.pr_number,
      attempt: newAttempt,
    },
    `Task #${task.id} promoted to changes-needed for automated rebase`
  );
  return true;
}

/**
 * Scan every `awaiting-human-merge` task in a repo and, for each whose PR has
 * gone stale, promote it back into the active pipeline for auto-rebase.
 *
 * Called from two places:
 *   - The webhook handler after another PR in the same repo merges (immediate).
 *   - The fallback poller (60s interval) as a safety net for missed webhooks.
 */
export async function scanForHumanMergeConflicts(
  repoId: number,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger,
  triggerTick: () => void
): Promise<number> {
  const awaiting = getTasks({ repo_id: repoId }).filter(
    (t) => t.status === 'awaiting-human-merge' && t.pr_number !== null
  );
  if (awaiting.length === 0) return 0;

  let promoted = 0;
  for (const task of awaiting) {
    try {
      if (await checkHumanMergeConflict(task, forgejo, log)) {
        promoted += 1;
      }
    } catch (err) {
      log.warn(
        { event: 'conflict_scan_task_error', task_id: task.id, err },
        'Error while checking conflict state for awaiting-human-merge task'
      );
    }
  }

  if (promoted > 0) {
    triggerTick();
  }
  return promoted;
}
