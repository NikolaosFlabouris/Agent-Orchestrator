import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Mocks — installed with vi.hoisted so they're available when actions.ts
// imports them. We stub db, docker, state-sync, and workspace to avoid loading
// better-sqlite3 or Docker in the test process.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    getRepo: vi.fn(),
    getTask: vi.fn(),
    getDb: vi.fn(),
    updateTaskWithSync: vi.fn(),
    recordTaskEvent: vi.fn(),
    deleteBranch: vi.fn<() => Promise<void>>(),
    closePullRequest: vi.fn<() => Promise<void>>(),
    replaceLabelByNames: vi.fn<() => Promise<void>>(),
    commentOnIssue: vi.fn<() => Promise<void>>(),
    closeIssue: vi.fn<() => Promise<void>>(),
    triggerTick: vi.fn(),
    getContainer: vi.fn(),
    stopContainer: vi.fn<() => Promise<void>>(),
    removeContainer: vi.fn<() => Promise<void>>(),
  };
});

vi.mock('../../db.js', () => ({
  getRepo: mocks.getRepo,
  getTask: mocks.getTask,
  getDb: mocks.getDb,
}));

vi.mock('../../state-sync.js', () => ({
  updateTaskWithSync: mocks.updateTaskWithSync,
  recordTaskEvent: mocks.recordTaskEvent,
}));

vi.mock('../../docker.js', () => ({
  getContainer: mocks.getContainer,
  stopContainer: mocks.stopContainer,
  removeContainer: mocks.removeContainer,
}));

vi.mock('../../workspace.js', () => ({
  getWorkdir: vi.fn().mockReturnValue('/tmp/fake-workdir'),
}));

// Import closeTask after mocks are registered
const { closeTask } = await import('../../actions.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 42,
    issue_id: 10,
    issue_title: 'Fix the bug',
    repo_id: 1,
    branch_name: 'agent/issue-10',
    pr_number: null,
    status: 'failed',
    queue_position: null,
    attempt: 3,
    max_attempts: 3,
    prep_failure_count: 0,
    prep_backoff_level: 0,
    prep_next_attempt_at: null,
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: null,
    completed_at: '2026-05-07T12:00:00Z',
    created_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
} as any;

const fakeRepo = { id: 1, owner: 'nik', name: 'myrepo' };

function makeForgejo() {
  return {
    deleteBranch: mocks.deleteBranch.mockResolvedValue(undefined),
    closePullRequest: mocks.closePullRequest.mockResolvedValue(undefined),
    replaceLabelByNames: mocks.replaceLabelByNames.mockResolvedValue(undefined),
    commentOnIssue: mocks.commentOnIssue.mockResolvedValue(undefined),
    closeIssue: mocks.closeIssue.mockResolvedValue(undefined),
  } as any;
}

function makeScheduler() {
  return { triggerTick: mocks.triggerTick } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRepo.mockReturnValue(fakeRepo);
});

// ---------------------------------------------------------------------------
// closeTask — core behaviour
// ---------------------------------------------------------------------------

describe('closeTask', () => {
  it('closes the Forgejo issue when closing a failed task', async () => {
    const task = mkTask({ status: 'failed' });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog);

    expect(mocks.closeIssue).toHaveBeenCalledWith(fakeRepo, task.issue_id);
  });

  it('sets status to cancelled with a completed_at timestamp', async () => {
    const task = mkTask({ status: 'failed' });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog);

    const call = mocks.updateTaskWithSync.mock.calls[0];
    expect(call[0]).toBe(task.id);
    expect(call[1].status).toBe('cancelled');
    expect(call[1].container_id).toBeNull();
    expect(typeof call[1].completed_at).toBe('string');
  });

  it('applies the status/cancelled label', async () => {
    const task = mkTask({ status: 'failed' });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog);

    expect(mocks.replaceLabelByNames).toHaveBeenCalledWith(
      fakeRepo,
      task.issue_id,
      ['status/cancelled']
    );
  });

  it('posts an issue comment noting the human close', async () => {
    const task = mkTask({ status: 'failed' });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog, 'work already done');

    expect(mocks.commentOnIssue).toHaveBeenCalledWith(
      fakeRepo,
      task.issue_id,
      expect.stringContaining('work already done')
    );
  });

  it('records a task_closed timeline event', async () => {
    const task = mkTask({ status: 'failed' });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog);

    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      task.id,
      'task_closed',
      expect.stringContaining('Closed')
    );
  });

  it('triggers the scheduler to free the slot', async () => {
    const task = mkTask({ status: 'failed' });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog);

    expect(mocks.triggerTick).toHaveBeenCalledOnce();
  });

  it('stops and removes a running container and deletes the branch', async () => {
    const fakeContainer = { id: 'c1' };
    mocks.getContainer.mockReturnValue(fakeContainer);
    mocks.stopContainer.mockResolvedValue(undefined);
    mocks.removeContainer.mockResolvedValue(undefined);
    const task = mkTask({
      status: 'in-progress',
      container_id: 'c1',
      branch_name: 'agent/issue-10',
    });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog);

    expect(mocks.stopContainer).toHaveBeenCalledWith(fakeContainer);
    expect(mocks.removeContainer).toHaveBeenCalledWith(fakeContainer);
    expect(mocks.deleteBranch).toHaveBeenCalledWith(fakeRepo, 'agent/issue-10');
  });

  it('closes an open PR when present', async () => {
    const task = mkTask({ status: 'in-review', pr_number: 55 });
    const forgejo = makeForgejo();

    await closeTask(task, forgejo, makeScheduler(), silentLog);

    expect(mocks.closePullRequest).toHaveBeenCalledWith(fakeRepo, 55);
  });

  it('still marks the task cancelled when closeIssue fails (idempotent/best-effort)', async () => {
    const task = mkTask({ status: 'failed' });
    const forgejo = {
      ...makeForgejo(),
      closeIssue: vi.fn().mockRejectedValue(new Error('already closed')),
    } as any;

    await expect(
      closeTask(task, forgejo, makeScheduler(), silentLog)
    ).resolves.toBeUndefined();

    const call = mocks.updateTaskWithSync.mock.calls[0];
    expect(call[1].status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Route-level validation — the `close` action is ungated EXCEPT for `merged`.
// Reproduces the route guard inline (mirrors the extend-action test style).
// ---------------------------------------------------------------------------

describe('close route validation (logic parity tests)', () => {
  function validateClose(
    taskStatus: string
  ): { status: 200 } | { status: 400; error: string } {
    if (taskStatus === 'merged') {
      return {
        status: 400,
        error: 'Cannot close a merged task — it represents a completed success.',
      };
    }
    return { status: 200 };
  }

  it('accepts a failed task', () => {
    expect(validateClose('failed')).toEqual({ status: 200 });
  });

  it('accepts non-merged statuses (terminal and active)', () => {
    for (const s of [
      'queued', 'preparing', 'in-progress', 'in-review', 'changes-needed',
      'failed', 'cancelled', 'reset', 'awaiting-human-merge',
      'awaiting-human-review', 'needs-human-review',
    ]) {
      expect(validateClose(s).status).toBe(200);
    }
  });

  it('rejects a merged task with a clear error', () => {
    const result = validateClose('merged');
    expect(result.status).toBe(400);
    if (result.status === 400) {
      expect(result.error).toContain('merged');
    }
  });
});
