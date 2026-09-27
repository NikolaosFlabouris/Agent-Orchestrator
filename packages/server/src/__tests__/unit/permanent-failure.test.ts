import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Fail-fast on non-retryable agent errors (#208): handleDevFailure and
// handleReviewFailure stop the task after one attempt when the error is
// classified permanent, and Extend still works on the resulting task.
//
// Tasks live in a tiny in-memory store: getTask reads it and
// updateTaskWithSync merges into it, so the flow sees realistic state.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  tasks: new Map<number, any>(),
  getRepo: vi.fn(),
  getDb: vi.fn(),
  updateTaskWithSync: vi.fn(),
  recordTaskEvent: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  getRepo: mocks.getRepo,
  getTask: (id: number) => mocks.tasks.get(id),
  getDb: mocks.getDb,
  updateTaskRaw: vi.fn(),
  getReviewFeedbackHistory: vi.fn(),
  getLatestAttempt: vi.fn(),
  updateAttempt: vi.fn(),
}));

vi.mock('../../state-sync.js', () => ({
  updateTaskWithSync: mocks.updateTaskWithSync,
  recordTaskEvent: mocks.recordTaskEvent,
}));

vi.mock('../../workspace.js', () => ({
  getWorkdir: vi.fn().mockReturnValue('/tmp/fake-workdir'),
  getOutputDir: vi.fn().mockReturnValue('/tmp/fake-output'),
  verifyWorkspaceState: vi.fn(),
  detectChanges: vi.fn(),
}));

vi.mock('../../docker.js', () => ({
  getContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
}));

const { handleDevFailure } = await import('../../agents/develop.js');
const { handleReviewFailure } = await import('../../agents/review.js');
const { extendTask } = await import('../../actions.js');

const OUTDATED_CLI =
  "[API 400] API Error: 400 Claude Code 2.1.232 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 435,
    issue_id: 208,
    issue_title: 'Some issue',
    repo_id: 1,
    branch_name: 'agent/issue-208',
    pr_number: null,
    status: 'in-progress',
    queue_position: null,
    attempt: 1,
    max_attempts: 7,
    prep_failure_count: 0,
    prep_backoff_level: 0,
    prep_next_attempt_at: null,
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-09-26T00:00:00Z',
    ...overrides,
  };
}

function makeLog() {
  const log: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  log.child = () => log;
  return log;
}

function makeForgejo() {
  return {
    commentOnIssue: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
  } as any;
}

function store(task: Task): Task {
  mocks.tasks.set(task.id, { ...task });
  return task;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tasks.clear();
  mocks.getRepo.mockReturnValue({ id: 1, owner: 'nik', name: 'agent-orchestrator' });
  mocks.updateTaskWithSync.mockImplementation((id: number, fields: any) => {
    mocks.tasks.set(id, { ...mocks.tasks.get(id), ...fields });
  });
  mocks.getDb.mockReturnValue({
    prepare: () => ({ get: () => ({ max_pos: null }) }),
  });
});

describe('handleDevFailure — permanent errors', () => {
  it('fails the task after the single attempt, comments and logs permanent_failure', async () => {
    const task = store(mkTask({ attempt: 1, max_attempts: 7 }));
    const forgejo = makeForgejo();
    const log = makeLog();
    const launch = vi.fn<(t: Task) => Promise<void>>();

    await handleDevFailure(task, OUTDATED_CLI, forgejo, log, launch, 1);

    // No relaunch — no further attempts consumed.
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.updateTaskWithSync).toHaveBeenCalledTimes(1);
    const fresh = mocks.tasks.get(task.id);
    expect(fresh.status).toBe('failed');
    expect(fresh.completed_at).toEqual(expect.any(String));
    // Counter advances past the attempt that ran, as on exhaustion.
    expect(fresh.attempt).toBe(2);

    expect(forgejo.commentOnIssue).toHaveBeenCalledTimes(1);
    const body = forgejo.commentOnIssue.mock.calls[0][2] as string;
    expect(body).toMatch(/non-retryable environment error/);
    expect(body).toMatch(/attempt 1/);
    expect(body).toContain(OUTDATED_CLI);
    expect(body).toMatch(/rebuild the agent image/);
    expect(body).toMatch(/then use Extend to retry/);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'permanent_failure',
        task_id: task.id,
        category: 'cli_outdated',
      }),
      expect.any(String)
    );
    expect(mocks.recordTaskEvent).toHaveBeenCalledWith(
      task.id,
      'permanent_failure',
      expect.stringContaining('cli_outdated')
    );
  });

  it.each([
    ['auth', '[API 401] {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', /provider credentials/],
    ['unknown_model', '[API 404] {"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}', /model id/],
  ])('gives the %s hint', async (category, msg, hint) => {
    const task = store(mkTask());
    const forgejo = makeForgejo();
    const log = makeLog();

    await handleDevFailure(task, msg, forgejo, log, vi.fn(), 1);

    expect(mocks.tasks.get(task.id).status).toBe('failed');
    expect(forgejo.commentOnIssue.mock.calls[0][2]).toMatch(hint);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'permanent_failure', category }),
      expect.any(String)
    );
  });

  it('can be extended like any failed task', async () => {
    const task = store(mkTask({ attempt: 1, max_attempts: 7 }));
    await handleDevFailure(task, OUTDATED_CLI, makeForgejo(), makeLog(), vi.fn(), 1);

    const failed = mocks.tasks.get(task.id) as Task;
    const scheduler = { triggerTick: vi.fn() } as any;
    await extendTask(failed, makeForgejo(), scheduler, makeLog(), 1);

    const extended = mocks.tasks.get(task.id);
    expect(extended.status).toBe('queued');
    expect(extended.max_attempts).toBe(8);
    expect(extended.completed_at).toBeNull();
    expect(extended.attempt).toBe(2);
    expect(scheduler.triggerTick).toHaveBeenCalled();
  });
});

describe('handleDevFailure — retryable errors (unchanged behaviour)', () => {
  it('retries an unrecognised error', async () => {
    const task = store(mkTask({ attempt: 1, max_attempts: 7 }));
    const forgejo = makeForgejo();
    const log = makeLog();
    const launch = vi.fn<(t: Task) => Promise<void>>().mockResolvedValue();

    await handleDevFailure(task, '[API 500] Internal server error', forgejo, log, launch, 1);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(mocks.tasks.get(task.id)).toMatchObject({ attempt: 2, status: 'preparing' });
    expect(forgejo.commentOnIssue.mock.calls[0][2]).toMatch(/Retrying/);
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'permanent_failure' }),
      expect.anything()
    );
  });

  it('retries a usage-limit error', async () => {
    const task = store(mkTask({ attempt: 1 }));
    const launch = vi.fn<(t: Task) => Promise<void>>().mockResolvedValue();

    await handleDevFailure(task, 'Claude AI usage limit reached|1790000000', makeForgejo(), makeLog(), launch, 1);

    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('still exhausts attempts at max_attempts', async () => {
    const task = store(mkTask({ attempt: 7, max_attempts: 7 }));
    const forgejo = makeForgejo();
    const log = makeLog();
    const launch = vi.fn();

    await handleDevFailure(task, 'something broke', forgejo, log, launch, 1);

    expect(launch).not.toHaveBeenCalled();
    expect(mocks.tasks.get(task.id)).toMatchObject({ status: 'failed', attempt: 8 });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attempts_exhausted' }),
      expect.any(String)
    );
  });
});

describe('handleReviewFailure', () => {
  it('fails the task on a permanent review-agent error without retrying', async () => {
    const task = store(mkTask({ status: 'in-review', pr_number: 12, attempt: 2 }));
    const forgejo = makeForgejo();
    const log = makeLog();
    const launch = vi.fn();

    const res = await handleReviewFailure(task, 0, forgejo, log, launch, {
      errorMessage: OUTDATED_CLI,
      exitCode: 1,
    });

    expect(res.shouldRetry).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.tasks.get(task.id)).toMatchObject({ status: 'failed', attempt: 3 });
    const body = forgejo.commentOnIssue.mock.calls[0][2] as string;
    expect(body).toMatch(/Review agent failed with a non-retryable environment error/);
    expect(body).toMatch(/then use Extend to retry/);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'permanent_failure', task_id: task.id, category: 'cli_outdated' }),
      expect.any(String)
    );
  });

  it('retries a retryable review-agent error as before', async () => {
    const task = store(mkTask({ status: 'in-review', pr_number: 12 }));
    const launch = vi.fn<(t: Task) => Promise<void>>().mockResolvedValue();

    const res = await handleReviewFailure(task, 0, makeForgejo(), makeLog(), launch, {
      errorMessage: '[API 529] Overloaded',
      exitCode: 1,
    });

    expect(res).toEqual({ shouldRetry: true, newRetryCount: 1 });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('retries when no failure detail is supplied (missing review.json)', async () => {
    const task = store(mkTask({ status: 'in-review', pr_number: 12 }));
    const launch = vi.fn<(t: Task) => Promise<void>>().mockResolvedValue();

    const res = await handleReviewFailure(task, 0, makeForgejo(), makeLog(), launch);

    expect(res.shouldRetry).toBe(true);
  });
});
