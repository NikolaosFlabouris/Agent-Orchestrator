import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { scanForHumanMergeConflicts } from '../conflict-detector.js';

// Terminal-state tasks that should re-enter the queue when the user re-applies
// status/queued in Forgejo. Mirrors the set in polling.ts. 'merged' is excluded —
// open a new issue for further work on an already-merged PR.
const REQUEUEABLE_FROM_LABEL = new Set<string>([
  'failed',
  'cancelled',
  'reset',
  'awaiting-human-merge',
  'awaiting-human-review',
  'needs-human-review',
]);
import {
  getTaskByIssue,
  getRepoByOwnerName,
  getTasks,
  insertTask,
  updateTask,
  getTask,
} from '../db.js';
import type { ForgejoClient } from '../forgejo.js';
import type { Scheduler } from '../scheduler.js';
import { invalidateSnapshot } from '../forgejo-snapshot.js';
import { notifyTaskCreated } from '../state-sync.js';
import {
  syncTaskDependencies,
  reevaluateDependentsOfIssue,
} from '../dependencies.js';

const WEBHOOK_SECRET = process.env.FORGEJO_WEBHOOK_SECRET ?? '';

export function createWebhookRoutes(
  forgejo: ForgejoClient,
  scheduler: Scheduler
) {
  return async function webhookRoutes(app: FastifyInstance): Promise<void> {
    const log = app.log;

    // Accept raw body for HMAC verification
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      }
    );

    app.post('/webhooks/forgejo', async (request, reply) => {
      const rawBody = request.body as Buffer;

      // 1. HMAC-SHA256 signature verification
      if (WEBHOOK_SECRET) {
        const signature = request.headers['x-forgejo-signature'] as
          | string
          | undefined;
        if (!signature) {
          log.warn(
            { event: 'webhook_signature_missing' },
            'Webhook signature header missing'
          );
          return reply.status(401).send({ error: 'Missing signature' });
        }

        const expected = createHmac('sha256', WEBHOOK_SECRET)
          .update(rawBody)
          .digest('hex');

        try {
          const sigBuf = Buffer.from(signature, 'hex');
          const expBuf = Buffer.from(expected, 'hex');
          if (
            sigBuf.length !== expBuf.length ||
            !timingSafeEqual(sigBuf, expBuf)
          ) {
            throw new Error('mismatch');
          }
        } catch {
          log.warn(
            { event: 'webhook_signature_invalid' },
            'Webhook signature verification failed'
          );
          return reply.status(401).send({ error: 'Invalid signature' });
        }
      }

      // 2. Parse the payload
      let payload: WebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        return reply.status(400).send({ error: 'Invalid JSON' });
      }

      const eventType = request.headers['x-forgejo-event'] as string | undefined;

      log.debug(
        { event: 'webhook_received', forgejo_event: eventType, action: payload.action },
        'Webhook received'
      );

      // 3. Dispatch by event type
      try {
        if (eventType === 'issues') {
          await handleIssueEvent(payload, forgejo, scheduler, log);
        } else if (eventType === 'pull_request') {
          await handlePullRequestEvent(payload, forgejo, scheduler, log);
        }
        // issue_comment events are informational — no action needed
      } catch (err) {
        log.error(
          { event: 'webhook_handler_error', err },
          'Error processing webhook'
        );
      }

      return { ok: true };
    });
  };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleIssueEvent(
  payload: WebhookPayload,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: import('fastify').FastifyBaseLogger
): Promise<void> {
  const issue = payload.issue;
  if (!issue) return;

  const repoData = payload.repository;
  if (!repoData) return;

  const repo = getRepoByOwnerName(repoData.owner?.login ?? '', repoData.name);
  if (!repo) {
    // Issue is from an untracked repo
    return;
  }

  // Any issue event may have changed state or labels that derivation reads.
  // Invalidate any cached snapshot so the next read pulls fresh data.
  const trackedForInvalidate = getTaskByIssue(repo.id, issue.number);
  if (trackedForInvalidate) invalidateSnapshot(trackedForInvalidate.id);

  if (payload.action === 'opened' || payload.action === 'label_updated') {
    // Check if the issue has the status/queued label
    const hasQueued = issue.labels?.some(
      (l: { name: string }) => l.name === 'status/queued'
    );

    if (hasQueued) {
      const existing = getTaskByIssue(repo.id, issue.number);
      if (existing) {
        // Already tracked. Re-queue only if the task is in a re-queueable
        // terminal state — the user re-labeled to request another attempt.
        //
        // Re-queue is a soft reset (mirrors polling.ts): clear branch/PR and
        // reset attempt to 1. The prior branch may have been deleted on
        // Forgejo, so trying to rework against it would hit "branch not found".
        if (REQUEUEABLE_FROM_LABEL.has(existing.status)) {
          updateTask(existing.id, {
            status: 'queued',
            container_id: null,
            branch_name: null,
            pr_number: null,
            attempt: 1,
            prep_failure_count: 0,
            // A re-queue is a fresh start: drop any git-outage backoff or
            // deferred-salvage state left over from the previous run.
            prep_backoff_level: 0,
            prep_next_attempt_at: null,
            salvage_backoff_level: 0,
            salvage_next_attempt_at: null,
            started_at: null,
            completed_at: null,
          });
          log.info(
            {
              event: 'webhook_task_requeued',
              task_id: existing.id,
              issue_id: issue.number,
              previous_status: existing.status,
            },
            `Task #${existing.id} re-queued by webhook (was ${existing.status})`
          );
          scheduler.triggerTick();
        } else {
          log.info(
            {
              event: 'webhook_duplicate_queue',
              issue_id: issue.number,
              existing_status: existing.status,
            },
            `Duplicate queue request for issue #${issue.number}, already tracked as ${existing.status}`
          );
        }
        return;
      }

      // Insert new task
      let issueTitle: string | null = issue.title ?? null;
      if (!issueTitle) {
        try {
          const fullIssue = await forgejo.getIssue(repo, issue.number);
          issueTitle = fullIssue.title;
        } catch {
          // Best effort
        }
      }

      const task = insertTask({
        issue_id: issue.number,
        issue_title: issueTitle,
        repo_id: repo.id,
        status: 'queued',
      });

      // Broadcast so connected dashboards see the new task immediately
      // — without this the operator has to manually refresh the page
      // because the periodic REST poll only updates existing rows, it
      // doesn't add new ones (Dashboard.tsx refreshTasks calls
      // updateTask, not addTask). The UI's own POST /api/tasks routes
      // already broadcast; this matches them for the webhook path.
      notifyTaskCreated(task);

      log.info(
        { event: 'webhook_task_queued', issue_id: issue.number },
        `Task queued from webhook for issue #${issue.number}`
      );

      scheduler.triggerTick();
    }

    // Handle external label changes on tracked tasks
    if (payload.action === 'label_updated') {
      const tracked = getTaskByIssue(repo.id, issue.number);
      if (!tracked) return;

      // If the issue now has a status/cancelled label applied externally
      const hasCancelled = issue.labels?.some(
        (l: { name: string }) => l.name === 'status/cancelled'
      );
      if (
        hasCancelled &&
        !TERMINAL_STATUSES.has(tracked.status)
      ) {
        updateTask(tracked.id, {
          status: 'cancelled',
          completed_at: new Date().toISOString(),
        });
        log.info(
          { event: 'webhook_external_cancel', task_id: tracked.id },
          'Task cancelled externally via label change'
        );
        scheduler.triggerTick();
      }
    }
  }

  // Body edited on Forgejo → re-derive the dependency rows immediately.
  // The webhook payload carries the fresh body, so this costs no extra
  // Forgejo fetch for the task's own issue. (The polling piggyback is the
  // fallback when this event is lost.) Non-terminal only — terminal tasks
  // keep their rows as history.
  if (payload.action === 'edited') {
    const tracked = getTaskByIssue(repo.id, issue.number);
    if (
      tracked &&
      !TERMINAL_STATUSES.has(tracked.status) &&
      typeof issue.body === 'string'
    ) {
      try {
        await syncTaskDependencies(tracked, issue.body, forgejo, log);
      } catch (err) {
        log.warn(
          { event: 'webhook_dep_sync_failed', task_id: tracked.id, err },
          'Dependency sync from edited webhook failed'
        );
      }
      // A removed/ticked dependency may have made the task eligible.
      scheduler.triggerTick();
    }
  }

  if (payload.action === 'closed' || payload.action === 'reopened') {
    // The state flip may unblock (closed) or re-block (reopened) queued
    // tasks that list this issue as a dependency — whether or not the
    // issue itself is tracked as a task.
    try {
      const touched = await reevaluateDependentsOfIssue(
        repo.id,
        issue.number,
        forgejo,
        log
      );
      if (touched > 0 && payload.action === 'closed') {
        scheduler.triggerTick();
      }
    } catch (err) {
      log.warn(
        { event: 'webhook_dependents_reeval_failed', issue_id: issue.number, err },
        'Dependent re-evaluation failed'
      );
    }
  }

  if (payload.action === 'closed') {
    const tracked = getTaskByIssue(repo.id, issue.number);
    if (!tracked) return;

    // If still active, mark as cancelled
    if (!TERMINAL_STATUSES.has(tracked.status)) {
      updateTask(tracked.id, {
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      });
      log.info(
        { event: 'webhook_issue_closed', task_id: tracked.id },
        'Task cancelled — issue closed externally'
      );
      scheduler.triggerTick();
    }
  }
}

async function handlePullRequestEvent(
  payload: WebhookPayload,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: import('fastify').FastifyBaseLogger
): Promise<void> {
  const pr = payload.pull_request;
  if (!pr) return;

  // Invalidate any snapshot cached for the task that owns this PR so the
  // next derivation sees the fresh PR state (merged, closed, draft change).
  const repoData = payload.repository;
  if (repoData) {
    const invRepo = getRepoByOwnerName(
      repoData.owner?.login ?? '',
      repoData.name
    );
    if (invRepo) {
      const invTask = getTasks({ repo_id: invRepo.id }).find(
        (t) => t.pr_number === pr.number
      );
      if (invTask) invalidateSnapshot(invTask.id);
    }
  }

  // PR merged externally
  if (payload.action === 'closed' && pr.merged) {
    const repoData = payload.repository;
    if (!repoData) return;

    const repo = getRepoByOwnerName(
      repoData.owner?.login ?? '',
      repoData.name
    );
    if (!repo) return;

    // Find the task associated with this PR (may be one we tracked, or a
    // human-merged sibling — either way we want to scan the repo afterwards).
    const allTasks = getTasks({ repo_id: repo.id });
    const task = allTasks.find((t) => t.pr_number === pr.number);

    if (task) {
      if (TERMINAL_STATUSES.has(task.status)) {
        log.info(
          { event: 'webhook_pr_merged_already_terminal', task_id: task.id },
          'PR merged webhook but task already in terminal state'
        );
      } else {
        updateTask(task.id, {
          status: 'merged',
          completed_at: new Date().toISOString(),
        });
        log.info(
          { event: 'webhook_pr_merged', task_id: task.id, pr_number: pr.number },
          'Task marked as merged — PR merged externally'
        );
      }
    }

    // Now that a PR merged, any other `awaiting-human-merge` task in this
    // repo may have become stale. Scan them and auto-queue a rebase for any
    // PR that's gone unmergeable. Detection is immediate here; the fallback
    // poller does the same scan every minute in case this webhook was lost.
    try {
      const promoted = await scanForHumanMergeConflicts(
        repo.id,
        forgejo,
        log,
        () => scheduler.triggerTick()
      );
      if (promoted > 0) {
        log.info(
          {
            event: 'webhook_post_merge_rebase_queued',
            repo_id: repo.id,
            promoted,
            merged_pr: pr.number,
          },
          `Auto-queued ${promoted} task(s) for rebase after PR #${pr.number} merged`
        );
      }
    } catch (err) {
      log.warn(
        { event: 'webhook_post_merge_scan_failed', err },
        'Failed to scan for human-merge conflicts after PR merged'
      );
    }

    scheduler.triggerTick();
  }
}

// ---------------------------------------------------------------------------
// Payload types (subset of Forgejo webhook payload)
// ---------------------------------------------------------------------------

interface WebhookPayload {
  action?: string;
  issue?: {
    number: number;
    title: string;
    state: string;
    /** Present on `opened`/`edited` payloads — the full markdown body. */
    body?: string;
    labels?: Array<{ name: string }>;
  };
  pull_request?: {
    number: number;
    title: string;
    state: string;
    merged: boolean;
  };
  repository?: {
    name: string;
    owner?: { login: string };
  };
}
