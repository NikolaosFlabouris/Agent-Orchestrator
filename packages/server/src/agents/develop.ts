import { execFileSync } from 'node:child_process';
import type { Task } from '@orchestrator/shared';
import { getRepo, getTask, updateTask } from '../db.js';
import { updateTaskWithSync, recordTaskEvent } from '../state-sync.js';
import type { ForgejoClient } from '../forgejo.js';
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
import { runStep } from '../checkpoints.js';
import type { FastifyBaseLogger } from 'fastify';

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

  verifyWorkspaceState(task, log);

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
    // Verify the remote is ahead of base
    if (baseSha && branchSha === baseSha) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
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
    const changes = detectChanges(task, repo.base_branch, log);

    if (
      !changes.hasUncommitted &&
      !changes.hasUntracked &&
      !changes.hasLocalCommits
    ) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
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
    let salvageResult: { pushed: true; reason: 'salvaged' };
    try {
      salvageResult = await runStep<{ pushed: true; reason: 'salvaged' }>(
        task.id,
        task.attempt,
        'salvage-local',
        async () => {
          // Re-check changes inside the step so a re-run after a partial commit
          // still does the right thing.
          const innerChanges = detectChanges(task, repo.base_branch, log);

          if (innerChanges.hasUncommitted || innerChanges.hasUntracked) {
            try {
              execFileSync('git', ['add', '-A'], {
                cwd: workdir,
                encoding: 'utf-8',
                timeout: 30_000,
              });
              execFileSync(
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
              log.warn(
                { event: 'salvage_commit_failed', task_id: task.id, err },
                'Failed to commit salvaged work'
              );
            }
          }

          // Push with retry
          let pushSucceeded = false;
          for (let pushAttempt = 0; pushAttempt < 2; pushAttempt++) {
            try {
              execFileSync(
                'git',
                ['push', '-f', 'origin', task.branch_name!],
                {
                  cwd: workdir,
                  encoding: 'utf-8',
                  timeout: 120_000,
                }
              );
              pushSucceeded = true;
              break;
            } catch (err) {
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
            throw new Error('Salvage push failed after retries');
          }

          return { pushed: true, reason: 'salvaged' as const };
        }
      );
    } catch (err) {
      updateTaskWithSync(task.id, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          'Salvage push failed. Local work preserved in workspace.'
        );
      } catch { /* best effort */ }
      log.error(
        { event: 'salvage_push_failed', task_id: task.id, err },
        'Salvage push failed after retries'
      );
      return false;
    }

    if (salvageResult.pushed) {
      recordTaskEvent(task.id, 'work_salvaged', 'Local work salvaged and pushed to remote');
      log.info(
        { event: 'work_salvaged', task_id: task.id },
        'Local work salvaged and pushed'
      );
    }
  }

  // ── Step 3: create-pr ───────────────────────────────────────────────────
  // Create the pull request when task.pr_number is null, otherwise handle
  // the rework path.  The create is wrapped in a checkpoint so a restart
  // after push but before PR creation skips the branch-check and goes
  // straight to creating the PR.
  try {
    if (task.pr_number === null || task.pr_number === undefined) {
      const createResult = await runStep<{ pr_number: number; created: boolean }>(
        task.id,
        task.attempt,
        'create-pr',
        async () => {
          const pr = await forgejo.createPullRequest(repo, {
            title: issueTitle,
            body: buildPullRequestBody({
              issue_id: task.issue_id,
              attempt: task.attempt,
            }),
            head: task.branch_name!,
            base: repo.base_branch,
          });
          return { pr_number: pr.number, created: true };
        }
      );

      if (createResult.created) {
        updateTask(task.id, { pr_number: createResult.pr_number });
        recordTaskEvent(task.id, 'pr_created', `Pull request #${createResult.pr_number} created`);
        log.info(
          { event: 'pr_created', task_id: task.id, pr_number: createResult.pr_number },
          'Pull request created'
        );
      }

      // Verify the closing-keyword link made it into the PR body. A correctly
      // behaved Forgejo returns the body verbatim, so this should always be
      // true — but if a server-side filter or a future code path stripped it,
      // we repair before relying on the link downstream.
      try {
        const pr = await forgejo.getPullRequest(repo, createResult.pr_number);
        if (!hasIssueLink(pr.body, task.issue_id)) {
          const repaired = ensureIssueLink(pr.body, task.issue_id);
          try {
            await forgejo.updatePullRequest(repo, pr.number, { body: repaired });
            recordTaskEvent(
              task.id,
              'pr_issue_link_repaired',
              `Restored \`Closes #${task.issue_id}\` link on PR #${pr.number}`
            );
            log.warn(
              { event: 'pr_issue_link_missing', task_id: task.id, pr_number: pr.number },
              'PR body missing issue link after create — repaired'
            );
          } catch (err) {
            log.error(
              { event: 'pr_issue_link_repair_failed', task_id: task.id, err },
              'Failed to repair missing PR↔issue link'
            );
          }
        }
      } catch {
        // Best effort — link check failure is non-fatal
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
    updateTaskWithSync(task.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    });
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Failed to create PR: ${err instanceof Error ? err.message : String(err)}. Branch exists on remote — use Reset to retry.`
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
  const maxAttempts = freshTask.max_attempts ?? 3;

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
