/**
 * #228 — a duplicate task resolved from outside the orchestrator is recorded
 * as `no-change`, not `cancelled`: an issue closed carrying `status/no-change`
 * (Imbina's CI resolve step), an externally applied `status/no-change` label,
 * the poller's fallback when those webhooks are missed, and a human Close
 * with the `no-change` resolution.
 *
 * Runs the real webhook routes, poller, task routes and state-sync against an
 * in-memory DB and a stateful Forgejo double, so the label writes the sync
 * makes are observable and can be replayed as webhook echoes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import {
  initDatabase,
  insertTask,
  updateTaskRaw,
  getTask,
  getTaskEvents,
} from '../../db.js';
import { _clearSnapshotCache } from '../../forgejo-snapshot.js';
import { _clearDependencyCache } from '../../dependencies.js';
import { createWebhookRoutes } from '../../routes/webhooks.js';
import { createTaskRoutes } from '../../routes/tasks.js';
import { Poller } from '../../polling.js';
import { initStateSync } from '../../state-sync.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

const docker = vi.hoisted(() => ({
  getContainer: vi.fn((id: string) => ({ id })),
  stopContainer: vi.fn(async () => {}),
  removeContainer: vi.fn(async () => {}),
}));

vi.mock('../../docker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../docker.js')>();
  return { ...actual, ...docker };
});

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: () => log,
} as unknown as FastifyBaseLogger;

const repository = { name: 'repo1', owner: { login: 'owner' } };
const ISSUE = 10;

/** Forgejo double holding one issue's state and labels; records every call. */
function makeForgejo(initialLabels: string[]) {
  const state = {
    open: true,
    labels: [...initialLabels],
  };
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  const client = {
    getIssue: async () => ({
      number: ISSUE,
      title: 'Issue',
      body: '',
      state: state.open ? 'open' : 'closed',
      labels: state.labels.map((name, i) => ({ id: i + 1, name })),
    }),
    getPullRequest: async () => ({ merged: false, state: 'open' }),
    commentOnIssue: rec('commentOnIssue'),
    deleteBranch: rec('deleteBranch'),
    closePullRequest: rec('closePullRequest'),
    closeIssue: async (...args: unknown[]) => {
      calls.push(['closeIssue', ...args]);
      state.open = false;
    },
    replaceLabelByNames: async (_repo: unknown, _n: number, names: string[]) => {
      calls.push(['replaceLabelByNames', names]);
      state.labels = [...names];
    },
  } as unknown as ForgejoClient;
  const named = (n: string) => calls.filter((c) => c[0] === n);
  const labelWrites = () =>
    named('replaceLabelByNames').map((c) => c[1] as string[]);
  return { client, state, calls, named, labelWrites };
}

type Fake = ReturnType<typeof makeForgejo>;

let app: FastifyInstance;
let scheduler: { triggerTick: ReturnType<typeof vi.fn> };

beforeEach(() => {
  const db = initDatabase(':memory:');
  db.prepare(
    `INSERT INTO repos (id, owner, name) VALUES (1, 'owner', 'repo1')`
  ).run();
  _clearSnapshotCache();
  _clearDependencyCache();
  vi.clearAllMocks();
  scheduler = { triggerTick: vi.fn() };
});

async function mount(fj: Fake): Promise<void> {
  initStateSync(fj.client, log);
  app = Fastify();
  await app.register(
    createWebhookRoutes(fj.client, scheduler as unknown as Scheduler)
  );
  await app.register(
    createTaskRoutes(fj.client, scheduler as unknown as Scheduler)
  );
  await app.ready();
}

/** Let fire-and-forget label syncs settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Deliver an issues webhook built from the double's CURRENT issue state. */
async function issueWebhook(fj: Fake, action: 'label_updated' | 'closed') {
  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/forgejo',
    headers: { 'x-forgejo-event': 'issues', 'content-type': 'application/json' },
    payload: JSON.stringify({
      action,
      repository,
      issue: {
        number: ISSUE,
        title: 't',
        state: fj.state.open ? 'open' : 'closed',
        labels: fj.state.labels.map((name) => ({ name })),
      },
    }),
  });
  expect(res.statusCode).toBe(200);
  await flush();
}

function seed(status: string, extra: Parameters<typeof updateTaskRaw>[1] = {}) {
  const task = insertTask({ issue_id: ISSUE, repo_id: 1, status: status as never });
  updateTaskRaw(task.id, extra);
  return task.id;
}

const eventTypes = (id: number) => getTaskEvents(id).map((e) => e.event_type);

function expectFinalNoChange(fj: Fake, id: number) {
  const t = getTask(id)!;
  expect(t.status).toBe('no-change');
  expect(t.completed_at).not.toBeNull();
  expect(t.container_id).toBeNull();
  // Slot freed: terminal, no container, and the scheduler told to refill.
  expect(scheduler.triggerTick).toHaveBeenCalled();
  expect(eventTypes(id)).toContain('no_change_confirmed');
  expect(fj.state.labels).toContain('status/no-change');
  expect(fj.state.labels).toContain('ci-failure');
  expect(fj.state.labels.filter((l) => l.startsWith('status/'))).toEqual([
    'status/no-change',
  ]);
  expect(fj.labelWrites().flat()).not.toContain('status/cancelled');
}

describe('issues webhook — closed with status/no-change', () => {
  it('label then close (two webhooks) → no-change, labels kept, slot free', async () => {
    const fj = makeForgejo(['status/queued', 'ci-failure']);
    await mount(fj);
    const id = seed('queued');

    // The closer swaps in status/no-change, then closes the issue.
    fj.state.labels = ['status/no-change', 'ci-failure'];
    await issueWebhook(fj, 'label_updated');
    fj.state.open = false;
    await issueWebhook(fj, 'closed');

    expectFinalNoChange(fj, id);
    expect(fj.state.open).toBe(false);
  });

  it('only the closed webhook, label already present → no-change, issue not re-closed', async () => {
    const fj = makeForgejo(['status/no-change', 'ci-failure']);
    fj.state.open = false;
    await mount(fj);
    const id = seed('queued');

    await issueWebhook(fj, 'closed');

    expectFinalNoChange(fj, id);
    // The closer already closed and explained it: no re-close, one short note.
    expect(fj.named('closeIssue')).toHaveLength(0);
    const comments = fj.named('commentOnIssue').map((c) => c[3] as string);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatch(/recorded as no-change/);
    const event = getTaskEvents(id).find((e) => e.event_type === 'no_change_confirmed')!;
    expect(event.message).toMatch(/external close with the status\/no-change label/);
  });

  it('closed without status/no-change → cancelled, unchanged', async () => {
    const fj = makeForgejo(['status/queued', 'ci-failure']);
    fj.state.open = false;
    await mount(fj);
    const id = seed('queued');

    await issueWebhook(fj, 'closed');

    expect(getTask(id)!.status).toBe('cancelled');
    expect(eventTypes(id)).not.toContain('no_change_confirmed');
    expect(fj.state.labels).toEqual(['status/cancelled', 'ci-failure']);
  });
});

describe('issues webhook — external status/no-change label', () => {
  it('in-progress task → container stopped, branch deleted, PR closed, issue closed', async () => {
    const fj = makeForgejo(['status/in-progress', 'ci-failure']);
    await mount(fj);
    const id = seed('in-progress', {
      container_id: 'c1',
      branch_name: 'agent/issue-10-x',
      pr_number: 7,
    });

    fj.state.labels = ['status/no-change', 'ci-failure'];
    await issueWebhook(fj, 'label_updated');

    expectFinalNoChange(fj, id);
    expect(docker.stopContainer).toHaveBeenCalledTimes(1);
    expect(docker.removeContainer).toHaveBeenCalledTimes(1);
    expect(fj.named('deleteBranch').map((c) => c[2])).toEqual(['agent/issue-10-x']);
    expect(fj.named('closePullRequest').map((c) => c[2])).toEqual([7]);
    expect(fj.named('closeIssue')).toHaveLength(1);
    expect(fj.state.open).toBe(false);
  });

  it('cancelled task with a closed issue → reclassified as no-change', async () => {
    const fj = makeForgejo(['status/cancelled', 'ci-failure']);
    fj.state.open = false;
    await mount(fj);
    const id = seed('cancelled', { completed_at: '2026-10-01T00:00:00Z' });

    fj.state.labels = ['status/no-change', 'ci-failure'];
    await issueWebhook(fj, 'label_updated');

    expectFinalNoChange(fj, id);
    expect(fj.named('closeIssue')).toHaveLength(0);
  });

  it('cancelled task with an OPEN issue → left cancelled', async () => {
    const fj = makeForgejo(['status/cancelled']);
    await mount(fj);
    const id = seed('cancelled');

    fj.state.labels = ['status/no-change'];
    await issueWebhook(fj, 'label_updated');

    expect(getTask(id)!.status).toBe('cancelled');
  });

  it.each(['merged', 'failed'])('%s task → status unchanged', async (status) => {
    const fj = makeForgejo([`status/${status}`]);
    fj.state.open = false;
    await mount(fj);
    const id = seed(status);

    fj.state.labels = ['status/no-change'];
    await issueWebhook(fj, 'label_updated');
    await issueWebhook(fj, 'closed');

    expect(getTask(id)!.status).toBe(status);
    expect(fj.calls).toHaveLength(0);
  });

  it('the status/no-change echo of its own sync causes no further transition', async () => {
    const fj = makeForgejo(['status/queued', 'ci-failure']);
    await mount(fj);
    const id = seed('queued');

    fj.state.labels = ['status/no-change', 'ci-failure'];
    await issueWebhook(fj, 'label_updated');
    expect(getTask(id)!.status).toBe('no-change');

    // Replay what Forgejo sends back for the orchestrator's own writes: the
    // label echo and the closed event from closing the issue.
    const callsBefore = fj.calls.length;
    const eventsBefore = getTaskEvents(id).length;
    const ticksBefore = scheduler.triggerTick.mock.calls.length;
    await issueWebhook(fj, 'label_updated');
    await issueWebhook(fj, 'closed');
    await issueWebhook(fj, 'label_updated');

    expect(getTask(id)!.status).toBe('no-change');
    expect(fj.calls.length).toBe(callsBefore);
    expect(getTaskEvents(id).length).toBe(eventsBefore);
    expect(scheduler.triggerTick.mock.calls.length).toBe(ticksBefore);
  });
});

describe('poller — missed webhooks', () => {
  function detect(fj: Fake): Promise<void> {
    const poller = new Poller(fj.client, scheduler as unknown as Scheduler, log);
    return (
      poller as unknown as {
        detectExternalStateChanges: (repo: unknown) => Promise<void>;
      }
    ).detectExternalStateChanges({ id: 1, owner: 'owner', name: 'repo1' });
  }

  it('closed issue with status/no-change → stored no-change, label no-change', async () => {
    const fj = makeForgejo(['status/no-change', 'ci-failure']);
    fj.state.open = false;
    await mount(fj);
    const id = seed('queued');

    await detect(fj);
    await flush();

    expectFinalNoChange(fj, id);
    expect(fj.named('closeIssue')).toHaveLength(0);

    // A second pass is quiet: the task is final now.
    const callsBefore = fj.calls.length;
    await detect(fj);
    await flush();
    expect(fj.calls.length).toBe(callsBefore);
  });

  it('open issue with status/no-change → no-change and the issue is closed', async () => {
    const fj = makeForgejo(['status/no-change', 'ci-failure']);
    await mount(fj);
    const id = seed('in-progress');

    await detect(fj);
    await flush();

    expectFinalNoChange(fj, id);
    expect(fj.state.open).toBe(false);
  });

  it('closed issue without the label → cancelled, unchanged', async () => {
    const fj = makeForgejo(['status/queued']);
    fj.state.open = false;
    await mount(fj);
    const id = seed('queued');

    await detect(fj);
    await flush();

    expect(getTask(id)!.status).toBe('cancelled');
  });
});

describe('PATCH close — resolution', () => {
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/tasks/1', payload });

  it('resolution no-change with a reason → no-change; comment names the human and the reason', async () => {
    const fj = makeForgejo(['status/failed', 'ci-failure']);
    await mount(fj);
    const id = seed('failed', { branch_name: 'agent/issue-10-x' });

    const res = await patch({
      action: 'close',
      resolution: 'no-change',
      reason: 'duplicate of #123',
    });
    expect(res.statusCode).toBe(200);
    await flush();

    expectFinalNoChange(fj, id);
    expect(fj.state.open).toBe(false);
    const comments = fj.named('commentOnIssue').map((c) => c[3] as string);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatch(/confirmed by human/);
    expect(comments[0]).toMatch(/duplicate of #123/);
  });

  it('resolution no-change without a reason → 400, nothing changes', async () => {
    const fj = makeForgejo(['status/failed']);
    await mount(fj);
    const id = seed('failed');

    const res = await patch({ action: 'close', resolution: 'no-change', reason: '  ' });
    expect(res.statusCode).toBe(400);
    expect(getTask(id)!.status).toBe('failed');
    expect(fj.calls).toHaveLength(0);
  });

  it('unknown resolution → 400', async () => {
    const fj = makeForgejo(['status/failed']);
    await mount(fj);
    seed('failed');

    const res = await patch({ action: 'close', resolution: 'won’t-fix' });
    expect(res.statusCode).toBe(400);
  });

  it('no resolution → cancelled as today', async () => {
    const fj = makeForgejo(['status/failed', 'ci-failure']);
    await mount(fj);
    const id = seed('failed');

    const res = await patch({ action: 'close' });
    expect(res.statusCode).toBe(200);
    await flush();

    expect(getTask(id)!.status).toBe('cancelled');
    expect(eventTypes(id)).not.toContain('no_change_confirmed');
    expect(fj.state.labels).toEqual(['status/cancelled', 'ci-failure']);
  });

  it.each(['merged', 'no-change'])('refused on a %s task', async (status) => {
    const fj = makeForgejo([]);
    await mount(fj);
    seed(status);

    const res = await patch({ action: 'close', resolution: 'no-change', reason: 'dup' });
    expect(res.statusCode).toBe(400);
  });
});
