import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import {
  initDatabase,
  insertTask,
  updateTask,
  getTaskDependencies,
  getRepo,
} from '../../db.js';
import { createWebhookRoutes } from '../../routes/webhooks.js';
import {
  evaluateTaskDependencies,
  reevaluateDependentsOfIssue,
  _clearDependencyCache,
  type DependencyForgejo,
} from '../../dependencies.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

/**
 * Webhook-driven dependency sync (T4): `edited` re-derives rows from the
 * payload body; `closed`/`reopened` re-evaluate queued dependents of the
 * issue. The Scheduler dependency is type-only in webhooks.ts, so a
 * two-method stub suffices.
 */

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

let db: ReturnType<typeof initDatabase>;
let app: FastifyInstance;
let issueStates: Record<number, 'open' | 'closed'>;
let forgejo: DependencyForgejo;
let scheduler: { triggerTick: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  db = initDatabase(':memory:');
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'owner', 'repo1')`).run();
  _clearDependencyCache();
  vi.clearAllMocks();

  issueStates = {};
  forgejo = {
    getIssue: vi.fn(async (_repo, n: number) => {
      const state = issueStates[n];
      if (!state) throw new Error('not found');
      return { state, body: '' } as never;
    }),
  };
  scheduler = { triggerTick: vi.fn() };

  app = Fastify();
  await app.register(
    createWebhookRoutes(
      forgejo as unknown as ForgejoClient,
      scheduler as unknown as Scheduler
    )
  );
});

function inject(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/forgejo',
    headers: {
      'x-forgejo-event': 'issues',
      'content-type': 'application/json',
    },
    payload: JSON.stringify(payload),
  });
}

const repository = { name: 'repo1', owner: { login: 'owner' } };

describe('issues edited webhook', () => {
  it('re-derives dependency rows from the payload body and ticks', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    issueStates[5] = 'open';

    const res = await inject({
      action: 'edited',
      repository,
      issue: {
        number: 10,
        title: 't',
        state: 'open',
        body: '## Dependencies\n- [ ] #5',
      },
    });

    expect(res.statusCode).toBe(200);
    const rows = getTaskDependencies(task.id);
    expect(rows.map((r) => [r.dep_issue_number, r.state])).toEqual([
      [5, 'open'],
    ]);
    expect(scheduler.triggerTick).toHaveBeenCalled();
  });

  it('removing the section via edit deletes the rows', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    issueStates[5] = 'open';
    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    expect(getTaskDependencies(task.id)).toHaveLength(1);

    await inject({
      action: 'edited',
      repository,
      issue: { number: 10, title: 't', state: 'open', body: 'no deps now' },
    });
    expect(getTaskDependencies(task.id)).toHaveLength(0);
  });

  it('ignores edits to issues of terminal tasks', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    updateTask(task.id, { status: 'merged' });

    await inject({
      action: 'edited',
      repository,
      issue: {
        number: 10,
        title: 't',
        state: 'closed',
        body: '## Dependencies\n- [ ] #5',
      },
    });
    expect(getTaskDependencies(task.id)).toHaveLength(0);
  });
});

describe('issues closed/reopened webhooks re-evaluate dependents', () => {
  it('closing an untracked dependency unblocks its dependents and ticks', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    issueStates[5] = 'open';
    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    expect(getTaskDependencies(task.id)[0].state).toBe('open');

    issueStates[5] = 'closed';
    const res = await inject({
      action: 'closed',
      repository,
      issue: { number: 5, title: 'dep', state: 'closed' },
    });

    expect(res.statusCode).toBe(200);
    expect(getTaskDependencies(task.id)[0].state).toBe('satisfied');
    expect(scheduler.triggerTick).toHaveBeenCalled();
  });

  it('reopening a dependency re-blocks queued dependents', async () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    issueStates[5] = 'closed';
    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    expect(getTaskDependencies(task.id)[0].state).toBe('satisfied');

    issueStates[5] = 'open';
    await inject({
      action: 'reopened',
      repository,
      issue: { number: 5, title: 'dep', state: 'open' },
    });

    expect(getTaskDependencies(task.id)[0].state).toBe('open');
    expect(scheduler.triggerTick).not.toHaveBeenCalled();
  });
});

describe('reevaluateDependentsOfIssue', () => {
  it('touches only queued dependents in the right repo', async () => {
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'owner', 'repo2')`).run();
    expect(getRepo(2)).toBeDefined();

    const queued = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const running = insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });
    const otherRepo = insertTask({ issue_id: 12, repo_id: 2, status: 'queued' });
    issueStates[5] = 'open';
    for (const t of [queued, running, otherRepo]) {
      await evaluateTaskDependencies(
        t,
        [{ issue: 5, checked: false }],
        forgejo,
        log
      );
    }
    updateTask(running.id, { status: 'in-progress' });

    issueStates[5] = 'closed';
    const touched = await reevaluateDependentsOfIssue(1, 5, forgejo, log);

    expect(touched).toBe(1);
    expect(getTaskDependencies(queued.id)[0].state).toBe('satisfied');
    expect(getTaskDependencies(running.id)[0].state).toBe('open');
    expect(getTaskDependencies(otherRepo.id)[0].state).toBe('open');
  });
});
