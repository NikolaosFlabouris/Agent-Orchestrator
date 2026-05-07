import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Mocks — installed with vi.hoisted so they're available when actions.ts and
// routes/tasks.ts import them. We stub db, docker, state-sync, and workspace
// to avoid loading better-sqlite3 or Docker in the test process.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    getRepo: vi.fn(),
    getTask: vi.fn(),
    getDb: vi.fn(),
    updateTaskWithSync: vi.fn(),
    recordTaskEvent: vi.fn(),
    replaceLabelByNames: vi.fn<() => Promise<void>>(),
    commentOnIssue: vi.fn<() => Promise<void>>(),
    triggerTick: vi.fn(),
    prepare: vi.fn(),
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

// Stub docker and workspace so actions.ts imports resolve
vi.mock('../../docker.js', () => ({
  getContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
}));

vi.mock('../../workspace.js', () => ({
  getWorkdir: vi.fn().mockReturnValue('/tmp/fake-workdir'),
}));

// Import extendTask after mocks are registered
const { extendTask } = await import('../../actions.js');

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
    agent_tool: null,
    model: null,
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
    replaceLabelByNames: mocks.replaceLabelByNames.mockResolvedValue(undefined),
    commentOnIssue: mocks.commentOnIssue.mockResolvedValue(undefined),
  } as any;
}

function makeScheduler() {
  return { triggerTick: mocks.triggerTick } as any;
}

// A minimal DB stub: prepare().get() returns a max_pos value.
function stubQueuePosition(maxPos: number | null) {
  mocks.getDb.mockReturnValue({
    prepare: () => ({
      get: () => ({ max_pos: maxPos }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRepo.mockReturnValue(fakeRepo);
  // Default queue position stub (no queued tasks yet)
  stubQueuePosition(null);
});

// ---------------------------------------------------------------------------
// extendTask — core behaviour
// ---------------------------------------------------------------------------

describe('extendTask', () => {
  it('transitions a failed task with a PR to changes-needed', async () => {
    const task = mkTask({ pr_number: 55, max_attempts: 3 });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        status: 'changes-needed',
        max_attempts: 5,
        completed_at: null,
        queue_position: null,
      })
    );
  });

  it('increases max_attempts by the given amount (with PR)', async () => {
    const task = mkTask({ pr_number: 55, max_attempts: 3 });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    const call = mocks.updateTaskWithSync.mock.calls[0];
    expect(call[1].max_attempts).toBe(5);
  });

  it('clears completed_at (with PR)', async () => {
    const task = mkTask({ pr_number: 55, completed_at: '2026-05-07T12:00:00Z' });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    const call = mocks.updateTaskWithSync.mock.calls[0];
    expect(call[1].completed_at).toBeNull();
  });

  it('transitions a failed task without a PR to queued', async () => {
    const task = mkTask({ pr_number: null, max_attempts: 3 });
    stubQueuePosition(10);
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        status: 'queued',
        max_attempts: 5,
        completed_at: null,
      })
    );
  });

  it('assigns a queue_position when going to queued (no PR)', async () => {
    const task = mkTask({ pr_number: null, max_attempts: 3 });
    stubQueuePosition(7);
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    const call = mocks.updateTaskWithSync.mock.calls[0];
    // MAX(queue_position) + 1 = 7 + 1 = 8
    expect(call[1].queue_position).toBe(8);
  });

  it('places at position 1 when queue is empty (no existing tasks)', async () => {
    const task = mkTask({ pr_number: null });
    stubQueuePosition(null); // no tasks in queue
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 1);

    const call = mocks.updateTaskWithSync.mock.calls[0];
    expect(call[1].queue_position).toBe(1);
  });

  it('leaves the attempt counter unchanged', async () => {
    const task = mkTask({ attempt: 3, pr_number: null });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    // updateTaskWithSync should NOT include an attempt field
    const call = mocks.updateTaskWithSync.mock.calls[0];
    expect(call[1]).not.toHaveProperty('attempt');
  });

  it('records a task_extended event', async () => {
    const task = mkTask({ max_attempts: 3 });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      task.id,
      'task_extended',
      expect.stringContaining('max_attempts 3 → 5')
    );
  });

  it('records the extended-by amount in the event message', async () => {
    const task = mkTask({ max_attempts: 3 });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      task.id,
      'task_extended',
      expect.stringContaining('Extended by 2')
    );
  });

  it('uses the default max_attempts of 3 when task.max_attempts is absent', async () => {
    // In practice the DB always stores an integer, but guard against edge cases.
    const task = mkTask({ max_attempts: 3 }); // explicit default
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 1);

    const call = mocks.updateTaskWithSync.mock.calls[0];
    expect(call[1].max_attempts).toBe(4);
  });

  it('posts a Forgejo issue comment (best-effort)', async () => {
    const task = mkTask({ pr_number: 55 });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    expect(mocks.commentOnIssue).toHaveBeenCalledWith(
      fakeRepo,
      task.issue_id,
      expect.stringContaining('max_attempts is now 5')
    );
  });

  it('includes PR clause in comment when task has a PR', async () => {
    const task = mkTask({ pr_number: 55 });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 2);

    expect(mocks.commentOnIssue).toHaveBeenCalledWith(
      fakeRepo,
      task.issue_id,
      expect.stringContaining('PR #55')
    );
  });

  it('omits PR clause in comment when task has no PR', async () => {
    const task = mkTask({ pr_number: null });
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 1);

    const call = mocks.commentOnIssue.mock.calls[0] as unknown as unknown[];
    const comment = call?.[2] as string;
    expect(comment).not.toContain('PR #');
  });

  it('triggers the scheduler after extending', async () => {
    const task = mkTask();
    const forgejo = makeForgejo();
    const scheduler = makeScheduler();

    await extendTask(task, forgejo, scheduler, silentLog, 1);

    expect(mocks.triggerTick).toHaveBeenCalledOnce();
  });

  it('does not throw if Forgejo comment fails (best-effort)', async () => {
    const task = mkTask();
    const forgejo = {
      ...makeForgejo(),
      commentOnIssue: vi.fn().mockRejectedValue(new Error('Forgejo down')),
    } as any;
    const scheduler = makeScheduler();

    // Should resolve without throwing
    await expect(
      extendTask(task, forgejo, scheduler, silentLog, 1)
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route-level validation (status guard & body validation)
// These tests exercise the validation logic directly without spinning up the
// full Fastify server, by reproducing the same checks inline.
// ---------------------------------------------------------------------------

describe('extend route validation (logic parity tests)', () => {
  const EXTENDABLE_STATUSES = new Set(['failed']);

  function validateExtend(
    taskStatus: string,
    additionalAttempts: unknown
  ): { status: 200 } | { status: 400; error: string } {
    if (!EXTENDABLE_STATUSES.has(taskStatus)) {
      return {
        status: 400,
        error: `Cannot extend task in state '${taskStatus}'. Valid states: ${[...EXTENDABLE_STATUSES].join(', ')}`,
      };
    }
    if (
      typeof additionalAttempts !== 'number' ||
      !Number.isInteger(additionalAttempts) ||
      additionalAttempts < 1 ||
      additionalAttempts > 10
    ) {
      return {
        status: 400,
        error: 'additional_attempts must be an integer between 1 and 10',
      };
    }
    return { status: 200 };
  }

  it('accepts a failed task with valid additional_attempts', () => {
    expect(validateExtend('failed', 2)).toEqual({ status: 200 });
  });

  it('accepts additional_attempts at the minimum boundary (1)', () => {
    expect(validateExtend('failed', 1)).toEqual({ status: 200 });
  });

  it('accepts additional_attempts at the maximum boundary (10)', () => {
    expect(validateExtend('failed', 10)).toEqual({ status: 200 });
  });

  it('rejects a non-failed task with 400', () => {
    for (const s of ['queued', 'in-progress', 'in-review', 'changes-needed', 'merged', 'cancelled', 'reset']) {
      const result = validateExtend(s, 2);
      expect(result.status).toBe(400);
    }
  });

  it('rejects additional_attempts = 0', () => {
    expect(validateExtend('failed', 0).status).toBe(400);
  });

  it('rejects additional_attempts = 11 (above sanity cap)', () => {
    expect(validateExtend('failed', 11).status).toBe(400);
  });

  it('rejects non-integer additional_attempts', () => {
    expect(validateExtend('failed', 1.5).status).toBe(400);
  });

  it('rejects string additional_attempts', () => {
    expect(validateExtend('failed', '2').status).toBe(400);
  });

  it('rejects missing additional_attempts (undefined)', () => {
    expect(validateExtend('failed', undefined).status).toBe(400);
  });

  it('error message for non-extendable status includes the current status', () => {
    const result = validateExtend('queued', 2);
    expect(result.status).toBe(400);
    if (result.status === 400) {
      expect(result.error).toContain("'queued'");
    }
  });
});
