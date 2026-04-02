import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
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
          await handlePullRequestEvent(payload, scheduler, log);
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

  if (payload.action === 'opened' || payload.action === 'label_updated') {
    // Check if the issue has the status/queued label
    const hasQueued = issue.labels?.some(
      (l: { name: string }) => l.name === 'status/queued'
    );

    if (hasQueued) {
      // Idempotency: check if task already exists
      const existing = getTaskByIssue(issue.number);
      if (existing) {
        log.info(
          {
            event: 'webhook_duplicate_queue',
            issue_id: issue.number,
            existing_status: existing.status,
          },
          `Duplicate queue request for issue #${issue.number}, already tracked as ${existing.status}`
        );
        return;
      }

      // Insert new task
      insertTask({
        issue_id: issue.number,
        repo_id: repo.id,
        status: 'queued',
      });

      log.info(
        { event: 'webhook_task_queued', issue_id: issue.number },
        `Task queued from webhook for issue #${issue.number}`
      );

      scheduler.triggerTick();
    }

    // Handle external label changes on tracked tasks
    if (payload.action === 'label_updated') {
      const tracked = getTaskByIssue(issue.number);
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

  if (payload.action === 'closed') {
    const tracked = getTaskByIssue(issue.number);
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
  scheduler: Scheduler,
  log: import('fastify').FastifyBaseLogger
): Promise<void> {
  const pr = payload.pull_request;
  if (!pr) return;

  // PR merged externally
  if (payload.action === 'closed' && pr.merged) {
    // Find the task associated with this PR
    // PR number might match an issue number in our tasks table via pr_number
    const repoData = payload.repository;
    if (!repoData) return;

    const repo = getRepoByOwnerName(
      repoData.owner?.login ?? '',
      repoData.name
    );
    if (!repo) return;

    // Search for a task with this PR number
    const allTasks = getTasks({ repo_id: repo.id });
    const task = allTasks.find((t) => t.pr_number === pr.number);

    if (!task) return;

    // Idempotency: skip if already terminal
    if (TERMINAL_STATUSES.has(task.status)) {
      log.info(
        { event: 'webhook_pr_merged_already_terminal', task_id: task.id },
        'PR merged webhook but task already in terminal state'
      );
      return;
    }

    updateTask(task.id, {
      status: 'merged',
      completed_at: new Date().toISOString(),
    });

    log.info(
      { event: 'webhook_pr_merged', task_id: task.id, pr_number: pr.number },
      'Task marked as merged — PR merged externally'
    );

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
