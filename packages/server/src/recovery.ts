import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from '@orchestrator/shared';

const execFileP = promisify(execFile);
import { getTasks, getRepo, updateTask, insertTaskEvent } from './db.js';
import type { ForgejoClient } from './forgejo.js';
import { buildPullRequestBody } from './forgejo-linking.js';
import { getStep } from './checkpoints.js';
import {
  listContainers,
  getContainer,
  inspectContainer,
  stopContainer,
  removeContainer,
} from './docker.js';
import {
  getWorkdir,
  getOutputDir,
  getTaskDir,
  detectChanges,
} from './workspace.js';
import type { Scheduler } from './scheduler.js';
import { runOrphanSweep } from './orphan-recovery.js';
import type { FastifyBaseLogger } from 'fastify';

interface AgentResult {
  status: 'success' | 'failure' | 'timeout';
  exit_code?: number;
  error_message?: string;
}

/**
 * Startup recovery — examines the actual state of each in-flight task
 * rather than assuming everything is lost.
 */
export async function onStartup(
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger
): Promise<void> {
  // 1. Verify Forgejo connection
  try {
    await forgejo.getCurrentUser();
  } catch {
    log.error(
      { event: 'recovery_forgejo_unreachable' },
      'Cannot reach Forgejo. Pausing scheduler.'
    );
    scheduler.pause();
    return;
  }

  // 2. Recover orphaned containers
  let containers: Awaited<ReturnType<typeof listContainers>>;
  try {
    containers = await listContainers();
  } catch {
    log.warn(
      { event: 'recovery_docker_error' },
      'Cannot list Docker containers during recovery'
    );
    containers = [];
  }

  const containerMap = new Map<string, string>(); // task-id → container-id
  for (const c of containers) {
    const taskIdLabel = c.Labels?.['task-id'];
    if (taskIdLabel) {
      containerMap.set(taskIdLabel, c.Id);
    }
  }

  // 3. Recover in-flight tasks
  const inFlight = [
    ...getTasks({ status: 'preparing' }),
    ...getTasks({ status: 'in-progress' }),
    ...getTasks({ status: 'in-review' }),
  ];

  const inFlightIds = new Set(inFlight.map((t) => String(t.id)));

  for (const task of inFlight) {
    const containerId = containerMap.get(String(task.id));

    if (containerId) {
      try {
        const container = getContainer(containerId);
        const info = await inspectContainer(container);

        if (info.State.Status === 'running') {
          // Container is still running — kill it, can't trust partial state
          log.info(
            { event: 'recovery_kill_running', task_id: task.id },
            'Killing running container from previous session'
          );
          await stopContainer(container);
          await removeContainer(container);
          updateTask(task.id, { container_id: null });
          await recoverTask(task, forgejo, log);
        } else if (info.State.Status === 'exited') {
          // Container exited — try to process results
          log.info(
            { event: 'recovery_exited_container', task_id: task.id },
            'Processing results from exited container'
          );
          try {
            const result = await readResult(task);
            const role = await readRole(task);
            await scheduler.processCompletedTask(task, result, role);
            await removeContainer(container);
          } catch {
            // Result file missing or corrupt — fall through to recover
            await removeContainer(container);
            updateTask(task.id, { container_id: null });
            await recoverTask(task, forgejo, log);
          }
        } else {
          // Unknown state
          try {
            await removeContainer(container);
          } catch { /* best effort */ }
          updateTask(task.id, { container_id: null });
          await recoverTask(task, forgejo, log);
        }
      } catch {
        // Container inspect failed
        updateTask(task.id, { container_id: null });
        await recoverTask(task, forgejo, log);
      }
    } else {
      // No container found
      updateTask(task.id, { container_id: null });
      await recoverTask(task, forgejo, log);
    }
  }

  // 4. Clean up orphaned containers not associated with known tasks
  for (const c of containers) {
    const taskIdLabel = c.Labels?.['task-id'];
    if (taskIdLabel && !inFlightIds.has(taskIdLabel)) {
      log.info(
        { event: 'recovery_cleanup_orphan', container_id: c.Id, task_id: taskIdLabel },
        'Removing orphaned container'
      );
      try {
        const container = getContainer(c.Id);
        await stopContainer(container);
        await removeContainer(container);
      } catch {
        // Best effort
      }
    }
  }

  // 5. Sweep for orphans that survived step 3's reconciliation. In
  // particular, tasks that were previously left with status='in-review'
  // and container_id=NULL but whose running attempt row was never
  // finalised — those are the stuck-reviewing case the orphan sweep is
  // built for. Tasks reconciled in step 3 are already consistent, so
  // the sweep is a no-op for them.
  try {
    await runOrphanSweep(forgejo, scheduler, log);
  } catch (err) {
    log.error(
      { event: 'recovery_orphan_sweep_error', err },
      'Startup orphan sweep failed'
    );
  }

  // 6. Start scheduler
  log.info({ event: 'recovery_complete' }, 'Startup recovery complete');
}

/**
 * Recover a single task by examining remote branch and local workspace state.
 */
async function recoverTask(
  task: Task,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  const repo = getRepo(task.repo_id);
  if (!repo) {
    log.error(
      { event: 'recovery_repo_missing', task_id: task.id },
      'Cannot recover — repo not found'
    );
    resetToQueued(task, 'Repo configuration missing.', forgejo, log);
    return;
  }

  if (!task.branch_name) {
    resetToQueued(task, 'No branch name assigned.', forgejo, log);
    return;
  }

  // ── Checkpoint-fast-path ────────────────────────────────────────────────
  // Consult step checkpoints written by postDevAgent for this attempt.  If
  // they exist, we know what postDevAgent already completed and can skip the
  // expensive branch/workspace derivation.

  const verifiedCheckpoint = getStep<{
    branch_exists: boolean;
    branch_sha: string | null;
    base_sha: string;
  }>(task.id, task.attempt, 'verify-push');

  const createdCheckpoint = getStep<{ pr_number: number; created: boolean }>(
    task.id,
    task.attempt,
    'create-pr'
  );

  if (createdCheckpoint) {
    // Both verify-push and create-pr completed — PR already exists.
    // Ensure the task has the PR number and transition straight to in-review.
    log.info(
      { event: 'recovery_checkpoint_pr_exists', task_id: task.id, pr_number: createdCheckpoint.pr_number },
      'Checkpoint: PR was already created. Transitioning to in-review.'
    );

    insertTaskEvent(
      task.id,
      'recovery',
      `Orchestrator recovered: PR #${createdCheckpoint.pr_number} already created (checkpoint). Transitioning to in-review.`
    );

    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        'Orchestrator recovered after restart. PR already created. Continuing to review.'
      );
    } catch { /* best effort */ }

    // Merge pr_number (if missing) and status transition into one atomic update.
    updateTask(task.id, {
      ...(task.pr_number ? {} : { pr_number: createdCheckpoint.pr_number }),
      status: 'in-review',
      container_id: null,
    });
    return;
  }

  if (verifiedCheckpoint) {
    // verify-push completed but create-pr did not — crash between push
    // verification and PR creation.

    if (!verifiedCheckpoint.branch_exists) {
      // The verify-push step recorded that the branch did NOT exist on the
      // remote when it ran (e.g. the salvage-local step also hadn't run yet).
      // We cannot create a PR against a branch that doesn't exist — fall
      // through to the existing derivation logic which will salvage local work
      // or re-queue the task.
      log.info(
        { event: 'recovery_checkpoint_branch_not_pushed', task_id: task.id },
        'Checkpoint: branch was not pushed yet. Falling through to derivation logic.'
      );
      // Fall through — do NOT return here.
    } else {
      // Branch exists on remote.  Skip branch derivation and go straight
      // to creating the PR.
      log.info(
        { event: 'recovery_checkpoint_verified_no_pr', task_id: task.id },
        'Checkpoint: branch verified but PR not yet created. Creating PR.'
      );

      let prNumber = task.pr_number ?? null;
      if ((task.status === 'in-progress' || task.status === 'preparing') && !task.pr_number) {
        try {
          let issueTitle: string;
          try {
            const issue = await forgejo.getIssue(repo, task.issue_id);
            issueTitle = issue.title;
          } catch {
            issueTitle = `Issue #${task.issue_id}`;
          }
          const pr = await forgejo.createPullRequest(repo, {
            title: issueTitle,
            body: buildPullRequestBody({
              issue_id: task.issue_id,
              attempt: task.attempt,
            }),
            head: task.branch_name,
            base: repo.base_branch,
          });
          prNumber = pr.number;
        } catch (err) {
          log.error(
            { event: 'recovery_pr_creation_failed', task_id: task.id, err },
            'Failed to create PR during recovery (checkpoint path)'
          );
        }
      }

      if (prNumber) {
        insertTaskEvent(
          task.id,
          'recovery',
          `Orchestrator recovered: branch verified (checkpoint), PR #${prNumber} created/found. Transitioning to in-review.`
        );

        try {
          await forgejo.commentOnIssue(
            repo,
            task.issue_id,
            'Orchestrator recovered after restart. Agent work found on branch. Continuing to review.'
          );
        } catch { /* best effort */ }

        // Merge pr_number persistence and status transition into one atomic update.
        updateTask(task.id, {
          ...(task.pr_number ? {} : { pr_number: prNumber }),
          status: 'in-review',
          container_id: null,
        });
        return;
      }

      // PR creation failed — fall through to re-queue
      resetToQueued(task, 'PR creation failed during recovery.', forgejo, log);
      return;
    }
  }

  // ── Fallback: existing derivation logic ────────────────────────────────
  // No checkpoints present — inspect Docker, Forgejo, and workspace from
  // scratch as before.

  // Check if the agent pushed its branch to Forgejo
  let branchExists = false;
  let branchSha: string | undefined;
  try {
    const branch = await forgejo.getBranch(repo, task.branch_name);
    branchExists = true;
    branchSha = branch.commit.id;
  } catch {
    // 404 — branch doesn't exist
  }

  if (branchExists) {
    // Check if branch is ahead of base
    let baseSha: string | undefined;
    try {
      const base = await forgejo.getBranch(repo, repo.base_branch);
      baseSha = base.commit.id;
    } catch {
      // Can't check base
    }

    if (baseSha && branchSha === baseSha) {
      // Branch exists but has no changes
      resetToQueued(task, 'Branch exists but contains no changes.', forgejo, log);
      return;
    }

    if (task.status === 'in-progress') {
      // Dev agent pushed work — create PR and continue to review
      log.info(
        { event: 'recovery_branch_found', task_id: task.id },
        'Found pushed branch. Creating PR and setting up for review.'
      );

      if (!task.pr_number) {
        try {
          let issueTitle: string;
          try {
            const issue = await forgejo.getIssue(repo, task.issue_id);
            issueTitle = issue.title;
          } catch {
            issueTitle = `Issue #${task.issue_id}`;
          }
          const pr = await forgejo.createPullRequest(repo, {
            title: issueTitle,
            body: buildPullRequestBody({
              issue_id: task.issue_id,
              attempt: task.attempt,
            }),
            head: task.branch_name,
            base: repo.base_branch,
          });
          updateTask(task.id, { pr_number: pr.number });
        } catch (err) {
          log.error(
            { event: 'recovery_pr_creation_failed', task_id: task.id, err },
            'Failed to create PR during recovery'
          );
        }
      }

      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          'Orchestrator recovered after restart. Agent work found on branch. Continuing to review.'
        );
      } catch { /* best effort */ }

      // Set to in-review without container — fillSlots will pick it up
      updateTask(task.id, { status: 'in-review', container_id: null });
    } else if (task.status === 'in-review') {
      // Review was in progress — re-run review
      log.info(
        { event: 'recovery_rerun_review', task_id: task.id },
        'Review was in progress. Re-running review.'
      );
      try {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          'Orchestrator recovered after restart. Re-running review.'
        );
      } catch { /* best effort */ }

      // fillSlots will detect in-review without container and start review
      updateTask(task.id, { status: 'in-review', container_id: null });
    } else {
      // preparing or other — just re-queue
      resetToQueued(task, 'Task recovered after restart.', forgejo, log);
    }
  } else {
    // No branch on remote — check for local work
    const workdir = getWorkdir(task);
    if (fs.existsSync(path.join(workdir, '.git'))) {
      const changes = await detectChanges(task, repo.base_branch, log);

      if (
        changes.hasUncommitted ||
        changes.hasUntracked ||
        changes.hasLocalCommits
      ) {
        // Local work exists but was never pushed — salvage it
        log.info(
          { event: 'recovery_salvage', task_id: task.id },
          'Found local unpushed work. Salvaging.'
        );

        if (changes.hasUncommitted || changes.hasUntracked) {
          try {
            await execFileP('git', ['add', '-A'], {
              cwd: workdir,
              encoding: 'utf-8',
              timeout: 30_000,
            });

            let issueTitle: string;
            try {
              const issue = await forgejo.getIssue(repo, task.issue_id);
              issueTitle = issue.title;
            } catch {
              issueTitle = `Issue #${task.issue_id}`;
            }

            await execFileP(
              'git',
              [
                'commit',
                '-m',
                `feat: ${issueTitle} (salvaged after restart)`,
              ],
              {
                cwd: workdir,
                encoding: 'utf-8',
                timeout: 30_000,
              }
            );
          } catch {
            // Commit failed — re-queue
            resetToQueued(
              task,
              'Recovery salvage commit failed.',
              forgejo,
              log
            );
            return;
          }
        }

        // Push salvaged work
        try {
          await execFileP(
            'git',
            ['push', '-f', 'origin', task.branch_name],
            {
              cwd: workdir,
              encoding: 'utf-8',
              timeout: 120_000,
            }
          );
        } catch (err) {
          log.error(
            { event: 'recovery_push_failed', task_id: task.id, err },
            'Recovery salvage push failed'
          );
          resetToQueued(
            task,
            `Recovery salvage push failed: ${err instanceof Error ? err.message : String(err)}.`,
            forgejo,
            log
          );
          return;
        }

        try {
          await forgejo.commentOnIssue(
            repo,
            task.issue_id,
            'Orchestrator recovered after restart. Unpushed agent work salvaged and pushed.'
          );
        } catch { /* best effort */ }

        updateTask(task.id, { status: 'in-review', container_id: null });
        return;
      }
    }

    // No remote branch, no local work — re-queue
    resetToQueued(task, 'No work found after restart.', forgejo, log);
  }
}

function resetToQueued(
  task: Task,
  reason: string,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): void {
  insertTaskEvent(task.id, 'recovery', `Orchestrator recovered: ${reason}`);
  updateTask(task.id, {
    status: 'queued',
    container_id: null,
    started_at: null,
  });

  log.info(
    { event: 'recovery_requeued', task_id: task.id, reason },
    'Task returned to queue after recovery'
  );

  // Best-effort Forgejo updates
  const repo = getRepo(task.repo_id);
  if (repo) {
    forgejo
      .commentOnIssue(
        repo,
        task.issue_id,
        `Orchestrator restarted. ${reason} Task returned to queue (attempt ${task.attempt} preserved).`
      )
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

async function readResult(task: Task): Promise<AgentResult> {
  const outputDir = getOutputDir(task);
  const raw = await fsp.readFile(path.join(outputDir, 'result.json'), 'utf-8');
  return JSON.parse(raw);
}

async function readRole(task: Task): Promise<'develop' | 'review'> {
  const taskDir = getTaskDir(task);
  try {
    const raw = await fsp.readFile(path.join(taskDir, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw);
    return meta.role ?? 'develop';
  } catch {
    return 'develop';
  }
}
