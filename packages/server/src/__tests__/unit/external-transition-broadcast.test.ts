/**
 * Every "a human did something on Forgejo" transition must reach an open
 * browser immediately (issue #147). Those transitions used to be written with
 * the raw `db.updateTask`, which emits no `task_updated` event — the Dashboard
 * masked it by re-polling REST every 30s, but TaskDetail has no polling at all
 * and showed a stale status until the operator reloaded.
 *
 * These tests drive the real webhook handlers and the real poller and assert on
 * what the dashboard socket actually received.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { TaskUpdatedEvent } from '@orchestrator/shared';
import { initDatabase, insertTask, updateTaskRaw, getTask } from '../../db.js';
import { _clearSnapshotCache, getSnapshot } from '../../forgejo-snapshot.js';
import { _clearDependencyCache } from '../../dependencies.js';
import { createWebhookRoutes } from '../../routes/webhooks.js';
import { Poller } from '../../polling.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

// Keep the real module — only the socket fan-out is captured.
vi.mock('../../ws/dashboard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ws/dashboard.js')>();
  return { ...actual, broadcastDashboardEvent: vi.fn() };
});

const { broadcastDashboardEvent } = await import('../../ws/dashboard.js');
const { updateTaskWithSync } = await import('../../state-sync.js');

const broadcastMock = vi.mocked(broadcastDashboardEvent);

/** Every `task_updated` event the broadcaster received, in order. */
function taskUpdatedEvents(): TaskUpdatedEvent[] {
  return broadcastMock.mock.calls
    .map(([event]) => event)
    .filter((e): e is TaskUpdatedEvent => e.type === 'task_updated');
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

const repository = { name: 'repo1', owner: { login: 'owner' } };

let db: ReturnType<typeof initDatabase>;
let app: FastifyInstance;
let scheduler: { triggerTick: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  db = initDatabase(':memory:');
  db.prepare(
    `INSERT INTO repos (id, owner, name) VALUES (1, 'owner', 'repo1')`
  ).run();
  _clearSnapshotCache();
  _clearDependencyCache();
  vi.clearAllMocks();

  scheduler = { triggerTick: vi.fn() };
});

/** Register the webhook routes against a Forgejo double. */
async function mountWebhooks(forgejo: Partial<ForgejoClient>): Promise<void> {
  app = Fastify();
  await app.register(
    createWebhookRoutes(
      forgejo as ForgejoClient,
      scheduler as unknown as Scheduler
    )
  );
}

function inject(event: 'issues' | 'pull_request', payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/forgejo',
    headers: {
      'x-forgejo-event': event,
      'content-type': 'application/json',
    },
    payload: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Webhook handlers
// ---------------------------------------------------------------------------

describe('pull_request webhook — PR merged externally', () => {
  it('broadcasts task_updated carrying status merged', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'in-review' });
    updateTaskRaw(task.id, { pr_number: 42 });
    await mountWebhooks({ getPullRequest: vi.fn() });

    const res = await inject('pull_request', {
      action: 'closed',
      repository,
      pull_request: { number: 42, title: 't', state: 'closed', merged: true },
    });

    expect(res.statusCode).toBe(200);
    expect(getTask(task.id)!.status).toBe('merged');

    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task.id).toBe(task.id);
    expect(events[0].task.status).toBe('merged');
  });

  it('stays silent when the task is already terminal', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'merged' });
    updateTaskRaw(task.id, { pr_number: 42 });
    await mountWebhooks({ getPullRequest: vi.fn() });

    await inject('pull_request', {
      action: 'closed',
      repository,
      pull_request: { number: 42, title: 't', state: 'closed', merged: true },
    });

    expect(taskUpdatedEvents()).toHaveLength(0);
  });
});

describe('issues webhook — issue closed on Forgejo', () => {
  it('broadcasts task_updated carrying status cancelled', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'in-progress' });
    await mountWebhooks({
      getIssue: vi.fn(async () => ({ state: 'closed', body: '' }) as never),
    });

    const res = await inject('issues', {
      action: 'closed',
      repository,
      issue: { number: 10, title: 't', state: 'closed' },
    });

    expect(res.statusCode).toBe(200);
    expect(getTask(task.id)!.status).toBe('cancelled');

    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task.id).toBe(task.id);
    expect(events[0].task.status).toBe('cancelled');
  });
});

describe('issues webhook — status/queued re-applied by hand', () => {
  it('broadcasts task_updated carrying status queued', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'failed' });
    updateTaskRaw(task.id, { pr_number: 42, branch_name: 'agent/issue-10' });
    await mountWebhooks({ getIssue: vi.fn() });

    const res = await inject('issues', {
      action: 'label_updated',
      repository,
      issue: {
        number: 10,
        title: 't',
        state: 'open',
        labels: [{ name: 'status/queued' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(getTask(task.id)!.status).toBe('queued');

    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task.status).toBe('queued');
    // The re-queue is a soft reset, and the payload reflects the whole of it —
    // the client replaces the row wholesale from this event.
    expect(events[0].task.pr_number).toBeNull();
    expect(events[0].task.branch_name).toBeNull();
  });

  it('stays silent for a status the label cannot re-queue', async () => {
    // `merged` is deliberately excluded from REQUEUEABLE_FROM_LABEL, and this
    // is also the loop guard: the label sync that follows a transition echoes
    // back as a `label_updated` event, and it must not re-trigger the write.
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'merged' });
    await mountWebhooks({ getIssue: vi.fn() });

    await inject('issues', {
      action: 'label_updated',
      repository,
      issue: {
        number: 10,
        title: 't',
        state: 'open',
        labels: [{ name: 'status/queued' }],
      },
    });

    expect(getTask(task.id)!.status).toBe('merged');
    expect(taskUpdatedEvents()).toHaveLength(0);
  });

  it('re-queueing again from `queued` is a no-op, so label sync cannot loop', async () => {
    // Second pass of the echo: after the re-queue above, the task sits in
    // `queued`, which is not in REQUEUEABLE_FROM_LABEL — so the event Forgejo
    // sends back in response to our own `status/queued` label write dead-ends.
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    await mountWebhooks({ getIssue: vi.fn() });

    await inject('issues', {
      action: 'label_updated',
      repository,
      issue: {
        number: 10,
        title: 't',
        state: 'open',
        labels: [{ name: 'status/queued' }],
      },
    });

    expect(getTask(task.id)!.status).toBe('queued');
    expect(taskUpdatedEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Poller — the missed-webhook fallback
// ---------------------------------------------------------------------------

describe('poller detectExternalStateChanges', () => {
  /** `detectExternalStateChanges` is private; call it directly rather than via
   *  `poll()`, which would also run the alert and workspace-cleanup passes. */
  function detect(poller: Poller, repoId = 1): Promise<void> {
    return (
      poller as unknown as {
        detectExternalStateChanges: (repo: unknown) => Promise<void>;
      }
    ).detectExternalStateChanges({ id: repoId, owner: 'owner', name: 'repo1' });
  }

  it('broadcasts task_updated when it finds a PR merged externally', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'in-review' });
    updateTaskRaw(task.id, { pr_number: 42 });

    const forgejo = {
      getIssue: vi.fn(async () => ({ state: 'open', labels: [], body: '' })),
      getPullRequest: vi.fn(async () => ({
        number: 42,
        state: 'closed',
        merged: true,
      })),
    } as unknown as ForgejoClient;

    const poller = new Poller(
      forgejo,
      scheduler as unknown as Scheduler,
      log
    );
    await detect(poller);

    expect(getTask(task.id)!.status).toBe('merged');
    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task.id).toBe(task.id);
    expect(events[0].task.status).toBe('merged');
  });

  it('broadcasts the status it just wrote, not the one a warm stale snapshot implies', async () => {
    // Regression guard. `updateTaskWithSync` derives its payload via
    // `peekSnapshot`, which deliberately serves EXPIRED entries — so a cache
    // warmed by an earlier REST read makes the broadcast announce the OLD
    // derived status even though the DB now says `merged`. The client replaces
    // the row wholesale from that payload, which would re-introduce exactly
    // the staleness this change exists to remove. The poller must invalidate
    // before it writes, the way the webhook handler does.
    const task = insertTask({
      issue_id: 10,
      repo_id: 1,
      status: 'awaiting-human-merge',
    });
    updateTaskRaw(task.id, { pr_number: 42 });

    // Warm the cache the way a dashboard REST load would: PR still open, and
    // the `human-merge` driver label present → derives `awaiting-human-merge`.
    const warm = {
      getIssue: vi.fn(async () => ({
        number: 10,
        state: 'open',
        labels: [{ name: 'human-merge' }],
      })),
      getPullRequest: vi.fn(async () => ({
        number: 42,
        state: 'open',
        merged: false,
        mergeable: true,
      })),
    } as unknown as ForgejoClient;
    await getSnapshot(getTask(task.id)!, warm);

    // Now the human merges the PR and the webhook is lost, so the poller is
    // the one that notices.
    const forgejo = {
      getIssue: vi.fn(async () => ({ state: 'open', labels: [], body: '' })),
      getPullRequest: vi.fn(async () => ({
        number: 42,
        state: 'closed',
        merged: true,
      })),
    } as unknown as ForgejoClient;

    const poller = new Poller(
      forgejo,
      scheduler as unknown as Scheduler,
      log
    );
    await detect(poller);

    expect(getTask(task.id)!.status).toBe('merged');
    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task.status).toBe('merged');
  });

  it('does not broadcast for tasks whose state has not changed', async () => {
    // The loop visits every non-final task in the repo on every 60s cycle.
    // The writes must stay inside the branches that actually change status,
    // or the poller becomes a per-task broadcast storm.
    insertTask({ issue_id: 10, repo_id: 1, status: 'in-progress' });
    insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });

    const forgejo = {
      getIssue: vi.fn(async () => ({ state: 'open', labels: [], body: '' })),
      getPullRequest: vi.fn(),
    } as unknown as ForgejoClient;

    const poller = new Poller(
      forgejo,
      scheduler as unknown as Scheduler,
      log
    );
    await detect(poller);
    await detect(poller);

    expect(taskUpdatedEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR/branch links
// ---------------------------------------------------------------------------

describe('pr_number writes', () => {
  it('emit a task_updated whose payload carries the new pr_number', async () => {
    // The shape `agents/develop.ts`, `scheduler.ts` and `recovery.ts` now use
    // for the PR/branch links (their call sites are pinned by
    // develop-checkpoints.test.ts and recovery-checkpoints.test.ts); this
    // asserts the resulting payload actually reaches the client with the link.
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'in-progress' });

    updateTaskWithSync(task.id, { pr_number: 77 });

    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task.id).toBe(task.id);
    expect(events[0].task.pr_number).toBe(77);
  });

  it('emit a task_updated carrying the new branch_name', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });

    updateTaskWithSync(task.id, { branch_name: 'agent/issue-10-thing' });

    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].task.branch_name).toBe('agent/issue-10-thing');
  });
});
