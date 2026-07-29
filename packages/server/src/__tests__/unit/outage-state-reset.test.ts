import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { Task } from '@orchestrator/shared';
import { initDatabase, getTask, getRepo, updateTaskRaw } from '../../db.js';
import { Poller } from '../../polling.js';
import { createWebhookRoutes } from '../../routes/webhooks.js';

// ---------------------------------------------------------------------------
// Every path that requeues or resets a task must also clear the v31 git-outage
// state (#144). Leaving `prep_next_attempt_at` set would park a freshly
// requeued task for up to 30 minutes for no reason, and a stale
// `salvage_next_attempt_at` would have the scheduler's deferred-salvage sweep
// resurrect a task whose workspace the reset just deleted.
//
// resetTask is exercised for real (in-memory DB, Docker + workspace mocked
// away). The label-driven requeue in polling.ts / routes/webhooks.ts writes
// the same patch through updateTaskWithSync, so it is asserted here against
// the same DB rather than by booting the poller and a Fastify server. (The
// broadcast half of that write is covered by
// external-transition-broadcast.test.ts.)
// ---------------------------------------------------------------------------

vi.mock('../../docker.js', () => ({
  getContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
}));

vi.mock('../../workspace.js', () => ({
  getWorkdir: vi.fn().mockReturnValue('/tmp/__outage_reset_test_nonexistent__'),
}));

const { resetTask } = await import('../../actions.js');

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
} as any;

const TASK_ID = 1;

function makeForgejoStub() {
  return {
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    closePullRequest: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    replaceLabel: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
  };
}

/** A task mid-outage: backing off on prep AND holding a deferred salvage. */
function backingOffTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    issue_id: 144,
    issue_title: 'Add backoff and outage resilience',
    repo_id: 1,
    branch_name: 'agent/issue-144-backoff',
    pr_number: null,
    status: 'queued',
    queue_position: 3,
    attempt: 2,
    max_attempts: 7,
    prep_failure_count: 1,
    prep_backoff_level: 4,
    prep_next_attempt_at: '2126-07-23T10:30:00.000Z',
    salvage_backoff_level: 2,
    salvage_next_attempt_at: '2126-07-23T10:15:00.000Z',
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2126-07-23T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  const db = initDatabase(':memory:');
  db.prepare(
    `INSERT INTO repos (id, owner, name) VALUES (1, 'nik', 'agent-orchestrator')`
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, branch_name, status, queue_position,
                        attempt, max_attempts, prep_failure_count,
                        prep_backoff_level, prep_next_attempt_at,
                        salvage_backoff_level, salvage_next_attempt_at)
     VALUES (?, 144, 1, 'agent/issue-144-backoff', 'queued', 3, 2, 7, 1,
             4, '2126-07-23T10:30:00.000Z', 2, '2126-07-23T10:15:00.000Z')`
  ).run(TASK_ID);
});

describe('resetTask clears git-outage state', () => {
  it('clears prep backoff and deferred salvage on a user reset', async () => {
    await resetTask(
      backingOffTask(),
      makeForgejoStub() as any,
      { triggerTick: vi.fn() } as any,
      silentLog
    );

    const after = getTask(TASK_ID)!;
    expect(after.status).toBe('reset');
    expect(after.prep_failure_count).toBe(0);
    expect(after.prep_backoff_level).toBe(0);
    expect(after.prep_next_attempt_at).toBeNull();
    expect(after.salvage_backoff_level).toBe(0);
    expect(after.salvage_next_attempt_at).toBeNull();
  });

  it('clears it on the orphan-recovery requeue path too, so the task is immediately runnable', async () => {
    await resetTask(
      backingOffTask(),
      makeForgejoStub() as any,
      { triggerTick: vi.fn() } as any,
      silentLog,
      { requeue: true, incrementAttempt: true }
    );

    const after = getTask(TASK_ID)!;
    expect(after.status).toBe('queued');
    expect(after.attempt).toBe(3);
    expect(after.prep_next_attempt_at).toBeNull();
    expect(after.salvage_next_attempt_at).toBeNull();
  });
});

describe('label-driven requeue clears git-outage state', () => {
  /** Put the task in a terminal state a human can re-queue from. */
  function markFailed(): void {
    updateTaskRaw(TASK_ID, { status: 'failed' });
  }

  it('the fallback poller clears it when status/queued is re-applied', async () => {
    markFailed();
    const forgejo = {
      listIssues: vi.fn().mockResolvedValue([
        { number: 144, title: 'Add backoff', body: '', labels: [{ name: 'status/queued' }] },
      ]),
    };
    // Only the queued-issue scan is exercised: the rest of poll() (external
    // state derivation, alerts, cleanup) is unrelated to this assertion.
    const poller = new Poller(
      forgejo as any,
      { triggerTick: vi.fn() } as any,
      silentLog
    );
    await (poller as any).pollRepoForQueuedIssues(getRepo(1));

    const after = getTask(TASK_ID)!;
    expect(after.status).toBe('queued');
    expect(after.prep_failure_count).toBe(0);
    expect(after.prep_backoff_level).toBe(0);
    expect(after.prep_next_attempt_at).toBeNull();
    expect(after.salvage_backoff_level).toBe(0);
    expect(after.salvage_next_attempt_at).toBeNull();
  });

  it('the webhook handler clears it on a label_updated event', async () => {
    markFailed();
    const app = Fastify();
    await app.register(
      createWebhookRoutes({} as any, { triggerTick: vi.fn() } as any)
    );

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/forgejo',
      headers: {
        'x-forgejo-event': 'issues',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        action: 'label_updated',
        issue: { number: 144, title: 'Add backoff', body: '', labels: [{ name: 'status/queued' }] },
        repository: { name: 'agent-orchestrator', owner: { login: 'nik' } },
      }),
    });
    expect(res.statusCode).toBe(200);

    const after = getTask(TASK_ID)!;
    expect(after.status).toBe('queued');
    expect(after.prep_backoff_level).toBe(0);
    expect(after.prep_next_attempt_at).toBeNull();
    expect(after.salvage_backoff_level).toBe(0);
    expect(after.salvage_next_attempt_at).toBeNull();

    await app.close();
  });
});
