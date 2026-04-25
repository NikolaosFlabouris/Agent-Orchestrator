import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task, Attempt } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Mocks — installed with vi.hoisted so they're available when the module under
// test imports them. db.ts transitively loads better-sqlite3 in real code; we
// short-circuit that by stubbing every function orphan-recovery uses.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    getTasks: vi.fn<(args: { status: string }) => Task[]>(),
    getAttempts: vi.fn<(taskId: number) => Attempt[]>(),
    updateAttempt: vi.fn(),
    getRepo: vi.fn(),
    listContainers: vi.fn<() => Promise<Array<{ Id: string }>>>(),
    getContainer: vi.fn(),
    inspectContainer: vi.fn(),
    updateTaskWithSync: vi.fn(),
    recordTaskEvent: vi.fn(),
    resetTask: vi.fn<(...args: unknown[]) => Promise<void>>(),
  };
});

vi.mock('../../db.js', () => ({
  getTasks: mocks.getTasks,
  getAttempts: mocks.getAttempts,
  updateAttempt: mocks.updateAttempt,
  getRepo: mocks.getRepo,
}));

vi.mock('../../docker.js', () => ({
  listContainers: mocks.listContainers,
  getContainer: mocks.getContainer,
  inspectContainer: mocks.inspectContainer,
}));

vi.mock('../../state-sync.js', () => ({
  updateTaskWithSync: mocks.updateTaskWithSync,
  recordTaskEvent: mocks.recordTaskEvent,
}));

// actions.ts pulls in fs + docker + workspace + scheduler transitively; stub
// it at module level so recoverDevOrphan's call to resetTask is observable
// without exercising any of that.
vi.mock('../../actions.js', () => ({
  resetTask: mocks.resetTask,
}));

// Import after mocks are registered.
const {
  detectOrphans,
  recoverReviewOrphan,
  recoverDevOrphan,
  runOrphanSweep,
  computeTaskHealth,
} = await import('../../orphan-recovery.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 1,
    issue_title: 'Test issue title',
    repo_id: 1,
    branch_name: null,
    pr_number: null,
    status: 'in-review',
    queue_position: null,
    attempt: 1,
    max_attempts: 3,
    prep_failure_count: 0,
    agent_tool: null,
    model: null,
    container_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-04-21T00:00:00Z',
    ...overrides,
  };
}

function mkAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 100,
    task_id: 1,
    attempt_number: 1,
    role: 'review',
    status: 'running',
    verdict: null,
    started_at: '2026-04-21T09:50:46Z',
    completed_at: null,
    log_path: null,
    feedback: null,
    input_tokens: null,
    output_tokens: null,
    model: null,
    cost_usd: null,
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

const fakeForgejo = {
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
} as any;

// A bare stand-in for the Scheduler instance. The sweep only hands this
// through to resetTask (mocked), so no method on it needs to be callable.
const fakeScheduler = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  // Keep getTasks returning empty by default so detectOrphans skips each
  // status bucket unless a test overrides it.
  mocks.getTasks.mockReturnValue([]);
  // Default resetTask to a successful no-op.
  mocks.resetTask.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// computeTaskHealth — pure function
// ---------------------------------------------------------------------------

describe('computeTaskHealth', () => {
  const runningAttempt = mkAttempt();

  it('returns "idle" for terminal / queued tasks', () => {
    expect(
      computeTaskHealth(mkTask({ status: 'queued' }), new Set(), runningAttempt)
    ).toBe('idle');
    expect(
      computeTaskHealth(mkTask({ status: 'merged' }), new Set(), runningAttempt)
    ).toBe('idle');
  });

  it('returns "healthy" for active tasks with no running attempt', () => {
    // A task between roles (e.g. dev just completed, review pending) has
    // status='in-review' but no running attempt row yet — not orphaned.
    expect(
      computeTaskHealth(
        mkTask({ status: 'in-review', container_id: null }),
        new Set(),
        undefined
      )
    ).toBe('healthy');
  });

  it('returns "orphaned" when container_id is null and attempt is running', () => {
    expect(
      computeTaskHealth(
        mkTask({ status: 'in-review', container_id: null }),
        new Set(),
        runningAttempt
      )
    ).toBe('orphaned');
  });

  it('returns "orphaned" when container_id is set but Docker has lost it', () => {
    expect(
      computeTaskHealth(
        mkTask({ status: 'in-progress', container_id: 'abc123' }),
        new Set(['other']),
        runningAttempt
      )
    ).toBe('orphaned');
  });

  it('returns "healthy" when container_id is present in the managed set', () => {
    expect(
      computeTaskHealth(
        mkTask({ status: 'in-progress', container_id: 'abc123' }),
        new Set(['abc123']),
        runningAttempt
      )
    ).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// detectOrphans
// ---------------------------------------------------------------------------

describe('detectOrphans', () => {
  it('returns null when Docker is unreachable (skip, do not false-positive)', async () => {
    mocks.listContainers.mockRejectedValue(new Error('docker down'));
    const result = await detectOrphans(silentLog);
    expect(result).toBeNull();
  });

  it('returns empty list when there are no active tasks', async () => {
    mocks.listContainers.mockResolvedValue([]);
    const result = await detectOrphans(silentLog);
    expect(result).toEqual([]);
  });

  it('flags null_container orphans', async () => {
    mocks.listContainers.mockResolvedValue([]);
    const task = mkTask({
      id: 3,
      status: 'in-review',
      container_id: null,
      attempt: 1,
    });
    const attempt = mkAttempt({ task_id: 3, role: 'review' });
    mocks.getTasks.mockImplementation(({ status }) =>
      status === 'in-review' ? [task] : []
    );
    mocks.getAttempts.mockReturnValue([attempt]);

    const result = await detectOrphans(silentLog);
    expect(result).toEqual([
      { task, stuckAttempt: attempt, kind: 'null_container' },
    ]);
  });

  it('flags missing_container orphans (container_id set, not in Docker list)', async () => {
    mocks.listContainers.mockResolvedValue([{ Id: 'other-id' }]);
    const task = mkTask({
      id: 4,
      status: 'in-progress',
      container_id: 'ghost-id',
    });
    const attempt = mkAttempt({ task_id: 4, role: 'develop' });
    mocks.getTasks.mockImplementation(({ status }) =>
      status === 'in-progress' ? [task] : []
    );
    mocks.getAttempts.mockReturnValue([attempt]);

    const result = await detectOrphans(silentLog);
    expect(result).toEqual([
      { task, stuckAttempt: attempt, kind: 'missing_container' },
    ]);
  });

  it('does not flag healthy tasks (container_id present in Docker list)', async () => {
    mocks.listContainers.mockResolvedValue([{ Id: 'running-id' }]);
    const task = mkTask({
      id: 5,
      status: 'in-progress',
      container_id: 'running-id',
    });
    mocks.getTasks.mockImplementation(({ status }) =>
      status === 'in-progress' ? [task] : []
    );
    mocks.getAttempts.mockReturnValue([mkAttempt({ task_id: 5 })]);

    const result = await detectOrphans(silentLog);
    expect(result).toEqual([]);
  });

  it('does not flag a task with no running attempt as orphaned', async () => {
    // Task between roles — container_id null but attempts are all completed.
    mocks.listContainers.mockResolvedValue([]);
    const task = mkTask({
      id: 6,
      status: 'in-review',
      container_id: null,
    });
    mocks.getTasks.mockImplementation(({ status }) =>
      status === 'in-review' ? [task] : []
    );
    mocks.getAttempts.mockReturnValue([
      mkAttempt({ task_id: 6, status: 'completed' }),
    ]);

    const result = await detectOrphans(silentLog);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// recoverReviewOrphan
// ---------------------------------------------------------------------------

describe('recoverReviewOrphan', () => {
  it('finalises the stuck attempt and bumps tasks.attempt on happy path', async () => {
    const task = mkTask({ id: 3, attempt: 1, max_attempts: 3 });
    const attempt = mkAttempt({
      id: 87,
      task_id: 3,
      // Old — well outside the 30 s crash-loop window.
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    await recoverReviewOrphan(task, attempt, fakeForgejo, silentLog);

    expect(mocks.updateAttempt).toHaveBeenCalledWith(
      87,
      expect.objectContaining({ status: 'failed' })
    );
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ attempt: 2, container_id: null })
    );
    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      3,
      'orphan_recovery_triggered',
      expect.stringContaining('attempt 2/3')
    );
    expect(fakeForgejo.commentOnIssue).not.toHaveBeenCalled();
  });

  it('escalates to failed when max_attempts has been reached', async () => {
    const task = mkTask({ id: 3, attempt: 3, max_attempts: 3 });
    const attempt = mkAttempt({
      id: 99,
      task_id: 3,
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    mocks.getRepo.mockReturnValue({ id: 1, owner: 'o', name: 'r' });

    await recoverReviewOrphan(task, attempt, fakeForgejo, silentLog);

    expect(mocks.updateAttempt).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: 'failed' })
    );
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ status: 'failed', container_id: null })
    );
    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      3,
      'orphan_recovery_exhausted',
      expect.stringContaining('Exhausted')
    );
    expect(fakeForgejo.commentOnIssue).toHaveBeenCalled();
  });

  it('escalates to failed when the stuck attempt started less than 30s ago', async () => {
    const task = mkTask({ id: 3, attempt: 1, max_attempts: 5 });
    const attempt = mkAttempt({
      id: 101,
      task_id: 3,
      started_at: new Date(Date.now() - 5_000).toISOString(), // 5 s ago
    });
    mocks.getRepo.mockReturnValue({ id: 1, owner: 'o', name: 'r' });

    await recoverReviewOrphan(task, attempt, fakeForgejo, silentLog);

    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ status: 'failed' })
    );
    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      3,
      'orphan_recovery_exhausted',
      expect.stringContaining('crash-looped')
    );
  });
});

// ---------------------------------------------------------------------------
// runOrphanSweep — end-to-end wiring
// ---------------------------------------------------------------------------

describe('runOrphanSweep', () => {
  it('reproduces the task-3 scenario: stuck in-review with null container and running review attempt recovers', async () => {
    const task = mkTask({
      id: 3,
      status: 'in-review',
      container_id: null,
      attempt: 1,
      max_attempts: 3,
    });
    const attempt = mkAttempt({
      id: 87,
      task_id: 3,
      role: 'review',
      status: 'running',
      started_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    });

    mocks.listContainers.mockResolvedValue([]);
    mocks.getTasks.mockImplementation(({ status }) =>
      status === 'in-review' ? [task] : []
    );
    mocks.getAttempts.mockReturnValue([attempt]);

    await runOrphanSweep(fakeForgejo, fakeScheduler, silentLog);

    // Attempt finalised.
    expect(mocks.updateAttempt).toHaveBeenCalledWith(
      87,
      expect.objectContaining({ status: 'failed' })
    );
    // Task counter bumped, container cleared, status still in-review.
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ attempt: 2, container_id: null })
    );
    // Both the detection and the recovery events are recorded.
    const eventTypes = mocks.recordTaskEvent.mock.calls.map((c) => c[1]);
    expect(eventTypes).toContain('orphan_detected');
    expect(eventTypes).toContain('orphan_recovery_triggered');
  });

  it('is a no-op when Docker is unreachable', async () => {
    mocks.listContainers.mockRejectedValue(new Error('docker down'));
    await runOrphanSweep(fakeForgejo, fakeScheduler, silentLog);
    expect(mocks.updateAttempt).not.toHaveBeenCalled();
    expect(mocks.updateTaskWithSync).not.toHaveBeenCalled();
  });

  it('recovers dev orphans by delegating to resetTask with incrementAttempt+requeue', async () => {
    const task = mkTask({
      id: 4,
      status: 'in-progress',
      container_id: null,
      attempt: 1,
      max_attempts: 3,
    });
    const attempt = mkAttempt({
      id: 200,
      task_id: 4,
      role: 'develop',
      // Outside crash-loop window so recovery proceeds.
      started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    mocks.listContainers.mockResolvedValue([]);
    mocks.getTasks.mockImplementation(({ status }) =>
      status === 'in-progress' ? [task] : []
    );
    mocks.getAttempts.mockReturnValue([attempt]);

    await runOrphanSweep(fakeForgejo, fakeScheduler, silentLog);

    expect(mocks.updateAttempt).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ status: 'failed' })
    );
    expect(mocks.resetTask).toHaveBeenCalledWith(
      task,
      fakeForgejo,
      fakeScheduler,
      silentLog,
      expect.objectContaining({ incrementAttempt: true, requeue: true })
    );
    const eventTypes = mocks.recordTaskEvent.mock.calls.map((c) => c[1]);
    expect(eventTypes).toContain('orphan_detected');
    expect(eventTypes).toContain('orphan_recovery_triggered');
  });
});

// ---------------------------------------------------------------------------
// recoverDevOrphan
// ---------------------------------------------------------------------------

describe('recoverDevOrphan', () => {
  it('finalises the stuck attempt and hands off to resetTask on happy path', async () => {
    const task = mkTask({ id: 4, attempt: 1, max_attempts: 3 });
    const attempt = mkAttempt({
      id: 300,
      task_id: 4,
      role: 'develop',
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    await recoverDevOrphan(task, attempt, fakeForgejo, fakeScheduler, silentLog);

    expect(mocks.updateAttempt).toHaveBeenCalledWith(
      300,
      expect.objectContaining({ status: 'failed' })
    );
    expect(mocks.resetTask).toHaveBeenCalledTimes(1);
    const resetArgs = mocks.resetTask.mock.calls[0];
    expect(resetArgs[0]).toBe(task);
    expect(resetArgs[4]).toMatchObject({
      incrementAttempt: true,
      requeue: true,
    });
    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      4,
      'orphan_recovery_triggered',
      expect.stringContaining('attempt 2/3')
    );
  });

  it('escalates to failed when max_attempts has been reached (no resetTask call)', async () => {
    const task = mkTask({ id: 4, attempt: 3, max_attempts: 3 });
    const attempt = mkAttempt({
      id: 301,
      task_id: 4,
      role: 'develop',
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    mocks.getRepo.mockReturnValue({ id: 1, owner: 'o', name: 'r' });

    await recoverDevOrphan(task, attempt, fakeForgejo, fakeScheduler, silentLog);

    expect(mocks.resetTask).not.toHaveBeenCalled();
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ status: 'failed', container_id: null })
    );
    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      4,
      'orphan_recovery_exhausted',
      expect.stringContaining('Exhausted')
    );
  });

  it('escalates to failed on crash-loop (no resetTask call)', async () => {
    const task = mkTask({ id: 4, attempt: 1, max_attempts: 5 });
    const attempt = mkAttempt({
      id: 302,
      task_id: 4,
      role: 'develop',
      started_at: new Date(Date.now() - 5_000).toISOString(), // 5s ago
    });
    mocks.getRepo.mockReturnValue({ id: 1, owner: 'o', name: 'r' });

    await recoverDevOrphan(task, attempt, fakeForgejo, fakeScheduler, silentLog);

    expect(mocks.resetTask).not.toHaveBeenCalled();
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      4,
      expect.objectContaining({ status: 'failed' })
    );
    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      4,
      'orphan_recovery_exhausted',
      expect.stringContaining('crash-looped')
    );
  });
});
