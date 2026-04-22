import fs from 'node:fs';
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

  // Primary check: did the agent push the expected branch?
  let branchExists = false;
  let branchSha: string | undefined;
  try {
    const branch = await forgejo.getBranch(repo, task.branch_name!);
    branchExists = true;
    branchSha = branch.commit.id;
  } catch {
    // 404 — branch doesn't exist on remote
  }

  if (branchExists) {
    // Verify the remote is ahead of base
    try {
      const baseBranch = await forgejo.getBranch(repo, repo.base_branch);
      if (branchSha === baseBranch.commit.id) {
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
    } catch {
      // Can't check base — continue anyway
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

    // Salvage: commit anything uncommitted, then push.
    if (changes.hasUncommitted || changes.hasUntracked) {
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
    for (let attempt = 0; attempt < 2; attempt++) {
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
            attempt: attempt + 1,
            err,
          },
          'Salvage push failed, retrying'
        );
      }
    }

    if (!pushSucceeded) {
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
        { event: 'salvage_push_failed', task_id: task.id },
        'Salvage push failed after retries'
      );
      return false;
    }

    recordTaskEvent(task.id, 'work_salvaged', 'Local work salvaged and pushed to remote');
    log.info(
      { event: 'work_salvaged', task_id: task.id },
      'Local work salvaged and pushed'
    );
  }

  // Create or update PR
  try {
    if (task.pr_number === null || task.pr_number === undefined) {
      const pr = await forgejo.createPullRequest(repo, {
        title: issueTitle,
        body: buildPullRequestBody({
          issue_id: task.issue_id,
          attempt: task.attempt,
        }),
        head: task.branch_name!,
        base: repo.base_branch,
      });
      updateTask(task.id, { pr_number: pr.number });
      recordTaskEvent(task.id, 'pr_created', `Pull request #${pr.number} created`);
      log.info(
        { event: 'pr_created', task_id: task.id, pr_number: pr.number },
        'Pull request created'
      );

      // Verify the closing-keyword link made it into the PR body. A correctly
      // behaved Forgejo returns the body verbatim, so this should always be
      // true — but if a server-side filter or a future code path stripped it,
      // we repair before relying on the link downstream.
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
        await forgejo.commentOnPr(
          repo,
          task.pr_number,
          `Branch updated with rework changes (attempt ${task.attempt})`
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

  if (newAttempt > freshTask.max_attempts) {
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
          `Task failed after ${freshTask.max_attempts} attempts. Last error: ${errorDetail}. Use the Reset action to retry from scratch.`
        );
      }
    } catch { /* best effort */ }
    log.error(
      {
        event: 'attempts_exhausted',
        task_id: task.id,
        attempts: freshTask.max_attempts,
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
          `Dev agent failed (attempt ${newAttempt}/${freshTask.max_attempts}): ${errorDetail}. Retrying.`
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
