import { TERMINAL_STATUSES } from '@orchestrator/shared';
import {
  getRepos,
  getTaskByIssue,
  getTasks,
  getTask,
  getSettingInt,
  insertTask,
  updateTask,
} from './db.js';
import { checkAlerts } from './alerts.js';
import { cleanupOldWorkspaces } from './cleanup.js';
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

    const intervalMs = (getSettingInt('poll_interval_seconds') || 60) * 1000;
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

    // Check alert conditions and run cleanup on each poll cycle
    checkAlerts(this.log);
    cleanupOldWorkspaces(this.log);
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
      // Idempotency check
      const existing = getTaskByIssue(issue.number);
      if (existing) continue;

      // New task from Forgejo
      insertTask({
        issue_id: issue.number,
        repo_id: repo.id,
        status: 'queued',
      });

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
   */
  private async detectExternalStateChanges(
    repo: import('@orchestrator/shared').Repo
  ): Promise<void> {
    // Check active tasks for this repo
    const activeTasks = getTasks({ repo_id: repo.id }).filter(
      (t) => !TERMINAL_STATUSES.has(t.status)
    );

    for (const task of activeTasks) {
      try {
        // Check issue state
        const issue = await this.forgejo.getIssue(repo, task.issue_id);

        // Issue closed externally
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

        // Check if PR was merged externally
        if (task.pr_number && !TERMINAL_STATUSES.has(task.status)) {
          try {
            const pr = await this.forgejo.getPullRequest(repo, task.pr_number);
            if (pr.merged) {
              updateTask(task.id, {
                status: 'merged',
                completed_at: new Date().toISOString(),
              });
              this.log.info(
                { event: 'poll_pr_merged', task_id: task.id, pr_number: task.pr_number },
                'Task marked as merged — PR merged externally (detected by poll)'
              );
            }
          } catch {
            // PR may not exist
          }
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
      } catch {
        // Issue may have been deleted or API unreachable
      }
    }
  }
}
