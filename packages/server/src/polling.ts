import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { scanForHumanMergeConflicts } from './conflict-detector.js';

// Terminal-state tasks that should re-enter the queue if the user re-applies
// status/queued in Forgejo. 'merged' is intentionally excluded — the PR is
// already in; open a new issue for further work.
const REQUEUEABLE_FROM_LABEL = new Set<string>([
  'failed',
  'cancelled',
  'reset',
  'awaiting-human-merge',
  'awaiting-human-review',
  'needs-human-review',
]);
import {
  getRepos,
  getTaskByIssue,
  getTasks,
  getTask,
  insertTask,
  updateTask,
} from './db.js';
import { checkAlerts } from './alerts.js';
import { cleanupOldWorkspaces } from './cleanup.js';
import { POLL_INTERVAL_SECONDS } from './constants.js';
import { notifyTaskCreated } from './state-sync.js';
import { syncTaskDependencies } from './dependencies.js';
import type { ForgejoClient } from './forgejo.js';
import type { Scheduler } from './scheduler.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Fallback polling loop.
 * Catches events that webhooks missed (network blip, orchestrator restart, etc.).
 */
export class Poller {
  private forgejo: ForgejoClient;
  private scheduler: Scheduler;
  private log: FastifyBaseLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  lastPollAt: string | null = null;

  constructor(
    forgejo: ForgejoClient,
    scheduler: Scheduler,
    log: FastifyBaseLogger
  ) {
    this.forgejo = forgejo;
    this.scheduler = scheduler;
    this.log = log;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = POLL_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        this.log.error({ event: 'poll_error', err }, 'Fallback poll failed');
      });
    }, intervalMs);

    this.log.info(
      { event: 'poller_started', interval_ms: intervalMs },
      'Fallback poller started'
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info({ event: 'poller_stopped' }, 'Fallback poller stopped');
  }

  async poll(): Promise<void> {
    this.lastPollAt = new Date().toISOString();
    const repos = getRepos();
    let foundNew = false;

    for (const repo of repos) {
      try {
        await this.pollRepoForQueuedIssues(repo);
        await this.detectExternalStateChanges(repo);
        // Safety-net scan for `awaiting-human-merge` tasks that have gone
        // stale because a sibling merged. The webhook handler performs the
        // same scan immediately on merge; this runs every poll cycle as a
        // fallback for dropped webhooks. checkHumanMergeConflict is idempotent.
        await scanForHumanMergeConflicts(
          repo.id,
          this.forgejo,
          this.log,
          () => this.scheduler.triggerTick()
        );
        foundNew = true;
      } catch (err) {
        this.log.warn(
          { event: 'poll_repo_error', repo_id: repo.id, err },
          `Poll failed for ${repo.owner}/${repo.name}`
        );
      }
    }

    if (foundNew) {
      this.scheduler.triggerTick();
    }

    // Check alert conditions and run cleanup on each poll cycle. Both are
    // now async and yield to the event loop so they don't stall incoming
    // HTTP requests. Independent try/catch so a failure in one doesn't skip
    // the other.
    try {
      await checkAlerts(this.log);
    } catch (err) {
      this.log.warn({ event: 'check_alerts_failed', err }, 'checkAlerts threw');
    }
    try {
      await cleanupOldWorkspaces(this.log);
    } catch (err) {
      this.log.warn({ event: 'cleanup_failed', err }, 'cleanupOldWorkspaces threw');
    }
  }

  /**
   * Query Forgejo for issues with status/queued label.
   * Add any that aren't already tracked.
   */
  private async pollRepoForQueuedIssues(
    repo: import('@orchestrator/shared').Repo
  ): Promise<void> {
    let issues;
    try {
      // Filter by label server-side to avoid fetching all issues
      issues = await this.forgejo.listIssues(repo, {
        state: 'open',
        labels: 'status/queued',
      });
    } catch {
      return;
    }

    for (const issue of issues) {
      const existing = getTaskByIssue(repo.id, issue.number);

      if (existing) {
        // Issue is already tracked. Re-queue only if the task is in a
        // re-queueable terminal state — the human re-labeled the issue
        // status/queued to ask for another attempt. 'merged' is intentionally
        // excluded: if the PR is already in, opening another attempt on the
        // same issue is confusing; the user should create a new issue instead.
        //
        // Re-queue is a soft reset: branch/PR are cleared (the previous branch
        // may have been deleted on Forgejo, and trying to rework against it
        // hits "branch not found"); attempt is reset to 1 so the user gets a
        // full retry budget. To preserve the prior branch, use the orchestrator
        // UI's reset+requeue flow instead.
        if (REQUEUEABLE_FROM_LABEL.has(existing.status)) {
          updateTask(existing.id, {
            status: 'queued',
            container_id: null,
            branch_name: null,
            pr_number: null,
            attempt: 1,
            prep_failure_count: 0,
            started_at: null,
            completed_at: null,
          });
          this.log.info(
            {
              event: 'poll_task_requeued',
              task_id: existing.id,
              issue_id: issue.number,
              previous_status: existing.status,
            },
            `Task #${existing.id} re-queued by Forgejo label change (was ${existing.status})`
          );
        }
        continue;
      }

      // New task from Forgejo. Broadcast `task_created` so connected
      // dashboards add the row to their local state — without this the
      // task only appears after a manual page reload (the periodic
      // refreshTasks call in Dashboard.tsx only UPDATES existing rows).
      const task = insertTask({
        issue_id: issue.number,
        issue_title: issue.title,
        repo_id: repo.id,
        status: 'queued',
      });
      notifyTaskCreated(task);

      this.log.info(
        { event: 'poll_task_queued', issue_id: issue.number, repo: `${repo.owner}/${repo.name}` },
        `Task queued from poll for issue #${issue.number}`
      );
    }
  }

  /**
   * Detect external state changes on tracked tasks:
   * - Issue closed externally → cancel
   * - PR merged manually → mark as merged
   * - Label changed externally → sync state
   *
   * Scope: runs on every task that is not already in a FINAL status (i.e.
   * not `merged` or `cancelled`). In particular, `failed`, `reset`, and the
   * `awaiting-human-*` states ARE re-checked so that a PR merged manually on
   * Forgejo after the orchestrator gave up will still heal the task to
   * `merged` rather than leaving it stuck. Issue-closed and external-cancel
   * are still scoped to non-terminal tasks so a prior `failed` outcome isn't
   * silently overwritten when the issue is later closed as "won't fix".
   */
  private async detectExternalStateChanges(
    repo: import('@orchestrator/shared').Repo
  ): Promise<void> {
    // Only skip tasks that are already fully finalised — a merged task can't
    // be unmerged, a cancelled task has already been cleaned up. Everything
    // else (including `failed`) is eligible for reconciliation in case the
    // user took action on Forgejo after the orchestrator stopped tracking.
    const candidateTasks = getTasks({ repo_id: repo.id }).filter(
      (t) => t.status !== 'merged' && t.status !== 'cancelled'
    );

    for (const task of candidateTasks) {
      try {
        // Check issue state
        const issue = await this.forgejo.getIssue(repo, task.issue_id);

        // PR merged externally → mark merged. Runs first so it wins over an
        // issue-closed signal: merging a PR usually auto-closes its issue, and
        // "merged" is the more informative outcome of the two.
        if (task.pr_number) {
          try {
            const pr = await this.forgejo.getPullRequest(repo, task.pr_number);
            if (pr.merged) {
              const previousStatus = task.status;
              updateTask(task.id, {
                status: 'merged',
                completed_at: new Date().toISOString(),
              });
              this.log.info(
                {
                  event: 'poll_pr_merged',
                  task_id: task.id,
                  pr_number: task.pr_number,
                  previous_status: previousStatus,
                },
                `Task marked merged — PR merged externally (was ${previousStatus})`
              );
              continue;
            }
          } catch {
            // PR may not exist
          }
        }

        // Issue closed externally → cancel. Skip tasks already in a terminal
        // state so a prior `failed` outcome isn't overwritten by a later
        // "won't fix" issue closure.
        if (issue.state === 'closed' && !TERMINAL_STATUSES.has(task.status)) {
          updateTask(task.id, {
            status: 'cancelled',
            completed_at: new Date().toISOString(),
          });
          this.log.info(
            { event: 'poll_issue_closed', task_id: task.id },
            'Task cancelled — issue closed externally (detected by poll)'
          );
          continue;
        }

        // Check for external label changes (e.g., someone manually added status/cancelled)
        const hasCancelled = issue.labels.some(
          (l) => l.name === 'status/cancelled'
        );
        if (hasCancelled && !TERMINAL_STATUSES.has(task.status)) {
          updateTask(task.id, {
            status: 'cancelled',
            completed_at: new Date().toISOString(),
          });
          this.log.info(
            { event: 'poll_external_cancel', task_id: task.id },
            'Task cancelled — external label change (detected by poll)'
          );
        }

        // Dependency piggyback: this loop already fetched the issue, so
        // re-deriving the dependency rows from its body costs no extra
        // Forgejo call. This is the lost-`edited`-webhook fallback — body
        // edits made directly on Forgejo converge within one poll
        // interval. Re-read the task first: the branches above may have
        // just cancelled it, and terminal tasks keep their rows as
        // history.
        const fresh = getTask(task.id);
        if (fresh && !TERMINAL_STATUSES.has(fresh.status)) {
          try {
            await syncTaskDependencies(
              fresh,
              issue.body ?? '',
              this.forgejo,
              this.log
            );
          } catch {
            // Best effort — the scheduler's dependency pass retries.
          }
        }
      } catch {
        // Issue may have been deleted or API unreachable
      }
    }
  }
}
