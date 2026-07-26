import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task, Repo } from '@orchestrator/shared';

const execFileP = promisify(execFile);
import { getRepo, getTask, updateTask } from '../db.js';
import { updateTaskWithSync, recordTaskEvent } from '../state-sync.js';
import { ForgejoApiError } from '../forgejo.js';
import type { ForgejoClient, ForgejoPullRequest } from '../forgejo.js';
import {
  buildPullRequestBody,
  ensureIssueLink,
  hasIssueLink,
} from '../forgejo-linking.js';
import {
  verifyWorkspaceState,
  getWorkdir,
  detectChanges,
} from '../workspace.js';
import { runStep, getStep } from '../checkpoints.js';
import {
  isInfraGitFailure,
  sanitizeGitError,
  describeGitExecFailure,
  computeBackoffMs,
  formatDelay,
} from '../git-outage.js';
import { DEFAULT_MAX_ATTEMPTS } from '../constants.js';
import type { FastifyBaseLogger } from 'fastify';

/** Timeout for the salvage force-push. Generous — a large branch over a slow
 *  link is not a failure — but bounded, because a git host that has stopped
 *  answering must be recognised as an outage rather than hang the sweep. */
const SALVAGE_PUSH_TIMEOUT_MS = 120_000;

/** Current salvage-backoff level, re-read from the DB so overlapping
 *  deferrals escalate off the persisted value rather than a stale in-memory
 *  task row. */
function freshSalvageLevel(task: Task): number {
  return getTask(task.id)?.salvage_backoff_level ?? task.salvage_backoff_level;
}

/** Clear a task's deferred-salvage state. No-op when nothing is deferred,
 *  so it's cheap to call on every successful salvage. */
function clearSalvageDeferral(task: Task): void {
  const fresh = getTask(task.id);
  if (!fresh) return;
  if (fresh.salvage_backoff_level === 0 && fresh.salvage_next_attempt_at === null) {
    return;
  }
  updateTask(task.id, {
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
  });
}

/**
 * Outcome of resolving the PR for a task's branch.
 *  - `created`   : no PR existed; the orchestrator opened one.
 *  - `adopted`   : a correctly-targeted PR already existed on the branch
 *                  (e.g. the agent opened it) and was taken over as-is.
 *  - `recreated` : a mis-targeted PR on the branch was closed and replaced
 *                  with one against the correct base.
 */
type PrResolution = {
  pr_number: number;
  action: 'created' | 'adopted' | 'recreated';
};

/**
 * Collect every OPEN pull request whose head is exactly `branch`. Forgejo's
 * list endpoint has no head filter, so we page through open PRs and match
 * client-side. Open PRs are bounded by in-flight work, so this stays cheap;
 * the page cap is a runaway guard, not an expected limit.
 */
async function findOpenPullRequestsForBranch(
  forgejo: ForgejoClient,
  repo: Repo,
  branch: string
): Promise<ForgejoPullRequest[]> {
  const LIMIT = 50;
  const MAX_PAGES = 20;
  const matches: ForgejoPullRequest[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await forgejo.listPullRequests(repo, {
      state: 'open',
      page,
      limit: LIMIT,
    });
    for (const pr of batch) {
      if (pr.head?.ref === branch) matches.push(pr);
    }
    if (batch.length < LIMIT) break;
  }
  return matches;
}

/**
 * Resolve the pull request for `task.branch_name`, reconciling against any PR
 * that already exists on that branch instead of blindly POSTing a second one.
 *
 * The dev agent runs with a tokenised git remote and can open its own PR; a
 * prior run can also leave a PR behind (e.g. it created the PR server-side but
 * died before recording it). Either way the branch — not the PR author — is
 * the unit of ownership: a PR whose head is the orchestrator-generated
 * `task.branch_name` is machine-owned, and authorship is not even a reliable
 * signal here (agent, orchestrator and human can share one Forgejo account).
 *
 * Decision table (only PRs on our head branch are ever considered):
 *  - one targeting the correct base                 → ADOPT
 *  - exactly one, mis-targeted base                 → RECREATE (close + open)
 *  - several, none correct                          → SURFACE (ambiguous)
 *  - none                                           → CREATE, with a 409
 *    fallback that re-reads and reconciles if someone opened one in the gap
 */
async function reconcilePullRequest(
  forgejo: ForgejoClient,
  repo: Repo,
  task: Task,
  issueTitle: string,
  log: FastifyBaseLogger
): Promise<PrResolution> {
  const head = task.branch_name!;
  const base = repo.base_branch;

  // Create the PR, adopting instead if a concurrent opener (the agent wrapping
  // up, or a retried prior run) wins the race. Forgejo only 409s a duplicate
  // when a PR for this exact head→base already exists, so on conflict the
  // existing PR necessarily targets `base` and is safe to adopt. Shared by the
  // plain-create and the post-close recreate paths so both get the fallback.
  // The body is built here, lazily, so the ADOPT path never computes it.
  const createOrAdoptOnConflict = async (
    successAction: 'created' | 'recreated'
  ): Promise<PrResolution> => {
    try {
      const pr = await forgejo.createPullRequest(repo, {
        title: issueTitle,
        body: buildPullRequestBody({
          issue_id: task.issue_id,
          attempt: task.attempt,
        }),
        head,
        base,
      });
      return { pr_number: pr.number, action: successAction };
    } catch (err) {
      if (err instanceof ForgejoApiError && err.status === 409) {
        const raced = await findOpenPullRequestsForBranch(forgejo, repo, head);
        const correct = raced.find((p) => p.base?.ref === base);
        if (correct) {
          log.info(
            { event: 'pr_adopt', task_id: task.id, pr_number: correct.number },
            'Adopting PR that won a concurrent-create race'
          );
          return { pr_number: correct.number, action: 'adopted' };
        }
      }
      throw err;
    }
  };

  const matches = await findOpenPullRequestsForBranch(forgejo, repo, head);

  // ADOPT: a PR already targets the correct base — take it over as-is.
  // If the branch ALSO carries a mis-targeted PR, we adopt the correct one and
  // intentionally leave the stray open: it self-resolves when the branch is
  // deleted on merge, and closing an extra PR here would be overreach. (The
  // RECREATE branch below only runs when NO correctly-based PR exists.)
  const correct = matches.find((p) => p.base?.ref === base);
  if (correct) {
    log.info(
      { event: 'pr_adopt', task_id: task.id, pr_number: correct.number },
      'Adopting pre-existing PR on the task branch'
    );
    return { pr_number: correct.number, action: 'adopted' };
  }

  // RECREATE: exactly one PR on our branch, mis-targeted. It lives in our own
  // branch namespace (the ownership signal, not the author), so replacing it is
  // safe — close it and open one against the correct base.
  if (matches.length === 1) {
    const wrong = matches[0];
    log.warn(
      {
        event: 'pr_recreate',
        task_id: task.id,
        pr_number: wrong.number,
        found_base: wrong.base?.ref,
        want_base: base,
      },
      'Closing mis-targeted PR and opening one against the correct base'
    );
    await forgejo.closePullRequest(repo, wrong.number);
    return createOrAdoptOnConflict('recreated');
  }

  // SURFACE: several PRs on the branch, none correct → ambiguous, don't guess.
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} open pull requests already exist on branch ${head}, none targeting ${base}; refusing to choose automatically`
    );
  }

  // CREATE: nothing on the branch yet.
  return createOrAdoptOnConflict('created');
}

/**
 * Post-dev-agent verification.
 * Verifies push, salvages if needed, creates/updates PR.
 * Returns true if a PR is ready for review, false if the task was marked as failed.
 */
export async function postDevAgent(
  task: Task,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<boolean> {
  const repo = getRepo(task.repo_id);
  if (!repo) {
    log.error({ event: 'repo_not_found', task_id: task.id }, 'Repo not found');
    return false;
  }

  let issueTitle: string;
  try {
    const issue = await forgejo.getIssue(repo, task.issue_id);
    issueTitle = issue.title;
  } catch {
    issueTitle = `Issue #${task.issue_id}`;
  }

  const workdir = getWorkdir(task);

  await verifyWorkspaceState(task, log);

  // ── Step 1: verify-push ──────────────────────────────────────────────────
  // Check whether the agent's branch exists on the remote and is ahead of
  // the base branch.  The result is idempotent so it is safe to replay.
  const verifyResult = await runStep<{
    branch_exists: boolean;
    branch_sha: string | null;
    base_sha: string;
  }>(task.id, task.attempt, 'verify-push', async () => {
    let branchExists = false;
    let branchSha: string | null = null;
    try {
      const branch = await forgejo.getBranch(repo, task.branch_name!);
      branchExists = true;
      branchSha = branch.commit.id;
    } catch {
      // 404 — branch doesn't exist on remote
    }

    let baseSha = '';
    try {
      const baseBranch = await forgejo.getBranch(repo, repo.base_branch);
      baseSha = baseBranch.commit.id;
    } catch {
      // Can't check base — leave empty
    }

    return { branch_exists: branchExists, branch_sha: branchSha, base_sha: baseSha };
  });

  const { branch_exists: branchExists, branch_sha: branchSha, base_sha: baseSha } = verifyResult;

  if (branchExists) {
    // The work is on the remote, so there is nothing left to salvage —
    // drop any deferral a previous outage left behind (e.g. the push
    // actually landed before the connection dropped).
    clearSalvageDeferral(task);

    // Verify the remote is ahead of base
    if (baseSha && branchSha === baseSha) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
      recordTaskEvent(
        task.id,
        'no_changes',
        "No changes produced — the agent's branch matches base; nothing to implement."
      );
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          'No changes produced — branch matches base.'
        );
      } catch { /* best effort */ }
      log.warn(
        { event: 'no_changes', task_id: task.id },
        'Branch matches base — no work produced'
      );
      return false;
    }
  } else {
    // Branch not pushed. Check for unexpected branch name.
    const expectedPrefix = `agent/issue-${task.issue_id}-`;
    try {
      const branches = await forgejo.listBranches(repo);
      const unexpected = branches.filter(
        (b) =>
          b.name.startsWith(expectedPrefix) && b.name !== task.branch_name
      );
      if (unexpected.length > 0) {
        log.warn(
          {
            event: 'unexpected_branch',
            task_id: task.id,
            expected: task.branch_name,
            found: unexpected[0].name,
          },
          'Agent may have pushed to unexpected branch'
        );
      }
    } catch {
      // Best effort
    }

    // Check for local work to salvage
    const changes = await detectChanges(task, repo.base_branch, log);

    if (
      !changes.hasUncommitted &&
      !changes.hasUntracked &&
      !changes.hasLocalCommits
    ) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
      recordTaskEvent(
        task.id,
        'no_changes',
        'No changes produced — the agent pushed no branch and left no local work to salvage.'
      );
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          'No changes produced by agent.'
        );
      } catch { /* best effort */ }
      log.warn(
        { event: 'no_changes', task_id: task.id },
        'No local work to salvage'
      );
      return false;
    }

    // ── Step 2: salvage-local ──────────────────────────────────────────────
    // Commit any uncommitted/untracked work and force-push.  Idempotent: if
    // the push already completed in a previous run the step is skipped via
    // the checkpoint cache.
    //
    // reason='salvaged' means a commit was actually needed; 'no_work' means
    // commits already existed locally and we just force-pushed them.
    let salvageResult: { pushed: boolean; reason: 'salvaged' | 'no_work' };
    const alreadySalvaged = getStep<{ pushed: boolean; reason: 'salvaged' | 'no_work' }>(
      task.id,
      task.attempt,
      'salvage-local'
    );
    try {
      salvageResult = await runStep<{ pushed: boolean; reason: 'salvaged' | 'no_work' }>(
        task.id,
        task.attempt,
        'salvage-local',
        async () => {
          // Re-check changes inside the step so a re-run after a partial commit
          // still does the right thing.
          const innerChanges = await detectChanges(task, repo.base_branch, log);

          let committedNewWork = false;
          if (innerChanges.hasUncommitted || innerChanges.hasUntracked) {
            committedNewWork = true;
            try {
              await execFileP('git', ['add', '-A'], {
                cwd: workdir,
                encoding: 'utf-8',
                timeout: 30_000,
              });
              await execFileP(
                'git',
                [
                  'commit',
                  '-m',
                  `feat: ${issueTitle}\n\nAutomated implementation for issue #${task.issue_id}\nAttempt: ${task.attempt}\n(Committed by orchestrator — agent did not push)`,
                ],
                {
                  cwd: workdir,
                  encoding: 'utf-8',
                  timeout: 30_000,
                }
              );
            } catch (err) {
              // Without a successful commit there is nothing new to push, so
              // proceeding would force-push the unchanged branch and falsely
              // report `work_salvaged`. Surface the failure to the outer catch
              // so the task is marked failed and the operator sees a real
              // diagnostic instead of an empty PR. Common cause: missing
              // `user.email`/`user.name` git config in the orchestrator image.
              const detail = err instanceof Error ? err.message : String(err);
              log.warn(
                { event: 'salvage_commit_failed', task_id: task.id, err },
                'Failed to commit salvaged work'
              );
              throw new Error(`Salvage commit failed: ${detail}`);
            }
          }

          // Push with retry
          let pushSucceeded = false;
          let lastPushError = '';
          for (let pushAttempt = 0; pushAttempt < 2; pushAttempt++) {
            try {
              await execFileP(
                'git',
                ['push', '-f', 'origin', task.branch_name!],
                {
                  cwd: workdir,
                  encoding: 'utf-8',
                  timeout: SALVAGE_PUSH_TIMEOUT_MS,
                }
              );
              pushSucceeded = true;
              break;
            } catch (err) {
              // Same rendering the workspace `git` helper applies: a host
              // that accepts the connection and then never answers gets
              // killed by the timeout above and would otherwise surface as a
              // bare `Command failed: git push …` with empty stderr —
              // outage-shaped in reality, structural to the classifier, and
              // therefore a terminal `salvage_failed` on finished work.
              lastPushError = describeGitExecFailure(
                err,
                'push',
                SALVAGE_PUSH_TIMEOUT_MS
              );
              log.warn(
                {
                  event: 'salvage_push_retry',
                  task_id: task.id,
                  attempt: pushAttempt + 1,
                  err,
                },
                'Salvage push failed, retrying'
              );
            }
          }

          if (!pushSucceeded) {
            // Carry the git stderr forward: the caller classifies it to
            // decide between deferring (host outage) and failing the task,
            // and records it on the timeline either way. Already redacted by
            // `describeGitExecFailure` (the remote URL carries the agent
            // token) but NOT truncated — the classifier must see the whole
            // message; truncation happens at the recording site.
            throw new Error(`Salvage push failed after retries: ${lastPushError}`);
          }

          return { pushed: true, reason: committedNewWork ? 'salvaged' as const : 'no_work' as const };
        }
      );
    } catch (err) {
      // Classify on the full message, record the truncated one — a long
      // stderr must not push the outage signature past the event limit and
      // turn a host outage into a terminal failure.
      const raw = err instanceof Error ? err.message : String(err);
      const detail = sanitizeGitError(raw);

      // Git-host outage: the agent's work is real and it is safe on disk.
      // Terminally failing the task here (the pre-#144 behaviour) stranded
      // finished implementation runs during the 2026-07-23 Forgejo outage.
      // Park the task instead — the scheduler's deferred-salvage sweep
      // re-runs postDevAgent once the backoff elapses, and the checkpointed
      // steps mean only the push is re-attempted.
      if (isInfraGitFailure(raw)) {
        const level = freshSalvageLevel(task) + 1;
        const delayMs = computeBackoffMs(level);
        const nextAt = new Date(Date.now() + delayMs).toISOString();
        updateTask(task.id, {
          salvage_backoff_level: level,
          salvage_next_attempt_at: nextAt,
        });
        recordTaskEvent(
          task.id,
          'salvage_deferred',
          `Salvage push deferred — git host unreachable: ${detail}. ` +
            `Retry ${level} in ${formatDelay(delayMs)} (at ${nextAt}). ` +
            `Local work preserved in workspace.`
        );
        // Comment once per outage, not once per retry — a multi-hour outage
        // would otherwise bury the issue under a wall of identical notes.
        if (level === 1) {
          try {
            await forgejo.commentOnIssue(
              repo,
              task.issue_id,
              `Could not push salvaged work — the git host is unreachable (${detail}). ` +
                `The work is preserved in the workspace and the push will be retried automatically.`
            );
          } catch { /* best effort */ }
        }
        log.warn(
          {
            event: 'salvage_deferred',
            task_id: task.id,
            backoff_level: level,
            delay_ms: delayMs,
            next_attempt_at: nextAt,
            err,
          },
          'Salvage push deferred — git host unreachable'
        );
        return false;
      }

      // Structural failure (bad credentials, protected branch, missing git
      // identity, …) — unchanged terminal behaviour. Clear any deferral
      // state so the retry sweep doesn't pick the failed task back up.
      updateTask(task.id, {
        salvage_backoff_level: 0,
        salvage_next_attempt_at: null,
      });
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
      recordTaskEvent(
        task.id,
        'salvage_failed',
        `Could not salvage local work: ${detail}. Local work preserved in workspace.`
      );
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Salvage failed: ${detail}. Local work preserved in workspace.`
        );
      } catch { /* best effort */ }
      log.error(
        { event: 'salvage_failed', task_id: task.id, err },
        'Salvage failed'
      );
      return false;
    }

    // The push went through — drop any deferral state left by an earlier
    // outage so the retry sweep stops considering this task.
    clearSalvageDeferral(task);

    // Record the side-effect event when this run freshly executed the salvage
    // step (not on replay of a cached checkpoint) AND the push succeeded.
    // Using pushed===true (rather than reason==='salvaged') matches the
    // original behaviour: we want observability for both the "new commit made"
    // case and the "local commits existed but were never pushed" case.
    if (!alreadySalvaged && salvageResult.pushed === true) {
      recordTaskEvent(task.id, 'work_salvaged', 'Local work salvaged and pushed to remote');
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Orchestrator salvaged uncommitted local work and pushed to branch \`${task.branch_name}\`.`
        );
      } catch {
        /* best effort */
      }
      log.info(
        { event: 'work_salvaged', task_id: task.id },
        'Local work salvaged and pushed'
      );
    }
  }

  // ── Step 3: create-pr ───────────────────────────────────────────────────
  // Resolve the PR for the branch when task.pr_number is null, otherwise handle
  // the rework path. Resolution (reconcilePullRequest) adopts/repairs/recreates
  // any PR already on the branch rather than blindly creating a duplicate, and
  // is wrapped in a checkpoint so a restart after push but before PR resolution
  // replays straight to it.
  try {
    if (task.pr_number === null || task.pr_number === undefined) {
      // Pre-check before runStep so we can skip side-effects on replay.
      const alreadyCreated = getStep<PrResolution>(
        task.id,
        task.attempt,
        'create-pr'
      );

      const createResult = await runStep<PrResolution>(
        task.id,
        task.attempt,
        'create-pr',
        async () => reconcilePullRequest(forgejo, repo, task, issueTitle, log)
      );

      // Always persist pr_number when the task row doesn't have it yet — this
      // covers the case where a previous run wrote the checkpoint but crashed
      // before updateTask completed.
      if (!task.pr_number) {
        updateTask(task.id, { pr_number: createResult.pr_number });
      }

      // Record side-effect events only when this run freshly executed the
      // create step (not on replay of a cached checkpoint).
      if (!alreadyCreated) {
        const action = createResult.action ?? 'created';
        const prNum = createResult.pr_number;
        const { eventType, summary } =
          action === 'adopted'
            ? {
                eventType: 'pr_adopted',
                summary: `Adopted existing pull request #${prNum} found on the task branch`,
              }
            : action === 'recreated'
              ? {
                  eventType: 'pr_recreated',
                  summary: `Replaced a mis-targeted pull request; opened #${prNum}`,
                }
              : {
                  eventType: 'pr_created',
                  summary: `Pull request #${prNum} created`,
                };
        recordTaskEvent(task.id, eventType, summary);
        try {
          await forgejo.commentOnIssue(repo, task.issue_id, `${summary}.`);
        } catch {
          /* best effort */
        }
        log.info(
          { event: eventType, task_id: task.id, pr_number: prNum },
          summary
        );

        // Fetch the PR once to drive both the empty-diff check and the link
        // repair. Failure to fetch is non-fatal for the link repair; the
        // empty-diff check just doesn't run (the merge step has its own
        // empty-diff guard as a backstop).
        let createdPr: Awaited<ReturnType<typeof forgejo.getPullRequest>> | null = null;
        try {
          createdPr = await forgejo.getPullRequest(repo, createResult.pr_number);
        } catch {
          // Best effort — link check / empty check skipped
        }

        // Empty-PR guard: Forgejo cheerfully accepts a PR whose head has no
        // net changes against base (e.g., an agent that pushes only reverts,
        // or a future code path that creates a PR before any work is pushed).
        // Such PRs report `mergeable: true` but `changed_files: 0`, so the
        // merge endpoint returns 405 and the operator sees a confusing
        // "Merge failed unexpectedly" message hours later. Fail here instead.
        // The empty PR is left open so a human can inspect what happened.
        if (createdPr && createdPr.changed_files === 0) {
          updateTaskWithSync(task.id, {
            status: 'failed',
            completed_at: new Date().toISOString(),
          });
          recordTaskEvent(
            task.id,
            'no_changes',
            `No changes produced — PR #${createResult.pr_number} has an empty diff against ${repo.base_branch}; nothing to review or merge.`
          );
          try {
            await forgejo.commentOnIssue(
              repo,
              task.issue_id,
              `PR #${createResult.pr_number} has no changes against ${repo.base_branch} — nothing to review or merge. The branch was pushed but its diff is empty. PR left open for inspection; use Reset to retry.`
            );
          } catch { /* best effort */ }
          log.error(
            {
              event: 'pr_empty_diff',
              task_id: task.id,
              pr_number: createResult.pr_number,
            },
            'Created PR has no changes against base — failing task'
          );
          return false;
        }

        // Verify the closing-keyword link made it into the PR body. A correctly
        // behaved Forgejo returns the body verbatim, so this should always be
        // true — but if a server-side filter or a future code path stripped it,
        // we repair before relying on the link downstream.
        // This check is only relevant immediately after creation (not on replay).
         if (createdPr && !hasIssueLink(createdPr.body, task.issue_id)) {
           const repaired = ensureIssueLink(createdPr.body, task.issue_id);
           try {
             await forgejo.updatePullRequest(repo, createdPr.number, { body: repaired });
             recordTaskEvent(
               task.id,
               'pr_issue_link_repaired',
               `Restored \`Closes #${task.issue_id}\` link on PR #${createdPr.number}`
             );
             try {
               await forgejo.commentOnIssue(
                 repo,
                 task.issue_id,
                 `Restored closing-keyword link to this issue on PR #${createdPr.number} (it was missing from the agent-authored PR body).`
               );
             } catch {
               /* best effort */
             }
             log.warn(
               { event: 'pr_issue_link_missing', task_id: task.id, pr_number: createdPr.number },
               'PR body missing issue link after create — repaired'
             );
           } catch (err) {
             log.error(
               { event: 'pr_issue_link_repair_failed', task_id: task.id, err },
               'Failed to repair missing PR↔issue link'
             );
           }
         }
      }
    } else {
      // Rework path: ensure the existing PR still links to the issue even if
      // a human (or future automation) edited the body. Read it back, and if
      // the link is missing, re-apply via PATCH; otherwise leave untouched.
       try {
         const existing = await forgejo.getPullRequest(repo, task.pr_number);
         if (!hasIssueLink(existing.body, task.issue_id)) {
           const repaired = ensureIssueLink(existing.body, task.issue_id);
           await forgejo.updatePullRequest(repo, task.pr_number, {
             body: repaired,
           });
           recordTaskEvent(
             task.id,
             'pr_issue_link_repaired',
             `Restored \`Closes #${task.issue_id}\` link on PR #${task.pr_number}`
           );
           try {
             await forgejo.commentOnIssue(
               repo,
               task.issue_id,
               `Restored closing-keyword link to this issue on PR #${task.pr_number} (it was missing from the agent-authored PR body).`
             );
           } catch {
             /* best effort */
           }
         }
       } catch (err) {
         log.warn(
           { event: 'pr_link_check_failed', task_id: task.id, err },
           'Could not verify existing PR body — skipping link check'
         );
       }

      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Branch updated with rework changes (attempt ${task.attempt}).`
        );
      } catch { /* best effort */ }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    updateTaskWithSync(task.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    });
    recordTaskEvent(
      task.id,
      'pr_creation_failed',
      `Could not resolve a pull request for this branch: ${detail}. Use Reset to retry.`
    );
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Could not resolve a pull request for this branch: ${detail}. Use Reset to retry.`
      );
    } catch { /* best effort */ }
    log.error(
      { event: 'pr_creation_failed', task_id: task.id, err },
      'Failed to create PR'
    );
    return false;
  }

  return true;
}

/**
 * Handle dev agent failure — retry or mark as failed.
 */
export async function handleDevFailure(
  task: Task,
  errorDetail: string,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger,
  launchDevContainer: (task: Task, feedback?: string | null) => Promise<void>
): Promise<void> {
  const freshTask = getTask(task.id)!;
  const repo = getRepo(task.repo_id);
  const newAttempt = freshTask.attempt + 1;
  const maxAttempts = freshTask.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

  if (newAttempt > maxAttempts) {
    // Max attempts exhausted
    updateTaskWithSync(task.id, {
      status: 'failed',
      attempt: newAttempt,
      completed_at: new Date().toISOString(),
    });
    try {
      if (repo) {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Task failed after ${maxAttempts} attempts. Last error: ${errorDetail}. Use the Reset action to retry from scratch.`
        );
      }
    } catch { /* best effort */ }
    log.error(
      {
        event: 'attempts_exhausted',
        task_id: task.id,
        attempts: maxAttempts,
      },
      'Max attempts exhausted'
    );
  } else {
    // Retry in the same slot
    updateTaskWithSync(task.id, { attempt: newAttempt, status: 'preparing' });
    try {
      if (repo) {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Dev agent failed (attempt ${newAttempt}/${maxAttempts}): ${errorDetail}. Retrying.`
        );
      }
    } catch { /* best effort */ }
    log.warn(
      {
        event: 'dev_failed_retry',
        task_id: task.id,
        attempt: newAttempt,
        error: errorDetail,
      },
      'Dev agent failed, retrying'
    );

    const updatedTask = getTask(task.id)!;
    await launchDevContainer(updatedTask);
  }
}
