import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';
import { initDatabase, getTask } from '../../db.js';
import {
  recordStep,
  getStep,
  listStepsForAttempt,
  runStep,
} from '../../checkpoints.js';

// ---------------------------------------------------------------------------
// Regression test for the "Issue 71 marked failed" bug.
//
// resetTask deletes the branch + PR and recycles the attempt counter back to
// 1. Step checkpoints are keyed only on (task_id, attempt_number, step_name),
// so before the fix a stale `create-pr` row from the pre-reset run would be
// replayed by the requeued attempt: the orchestrator skipped PR creation and
// then tried to merge the PR this very reset had just closed — Forgejo 404,
// task marked failed.
//
// We use the real db.js + real checkpoints (in-memory DB) so the checkpoint
// rows and the tasks row behave exactly as in production. Only Docker and the
// workspace path are mocked away.
// ---------------------------------------------------------------------------

vi.mock('../../docker.js', () => ({
  getContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
}));

vi.mock('../../workspace.js', () => ({
  getWorkdir: vi.fn().mockReturnValue('/tmp/__reset_test_nonexistent__'),
}));

// Import after mocks are registered.
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

function makeForgejoStub() {
  return {
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    closePullRequest: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn().mockResolvedValue({ labels: [] }),
    replaceLabel: vi.fn().mockResolvedValue(undefined),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
  };
}

const TASK_ID = 1;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    issue_id: 71,
    issue_title: 'Remove "Today: X tasks" counter from Dashboard header',
    repo_id: 1,
    branch_name: 'agent/issue-71-remove-today-x-tasks-counter',
    pr_number: 73,
    status: 'in-review',
    queue_position: 8,
    attempt: 1,
    max_attempts: 7,
    prep_failure_count: 0,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: '2026-05-18T11:49:01.387Z',
    completed_at: null,
    created_at: '2026-05-12T12:24:07.062Z',
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
    `INSERT INTO tasks (id, issue_id, issue_title, repo_id, branch_name, pr_number,
                        status, queue_position, attempt, max_attempts, prep_failure_count)
     VALUES (?, 71, 'Issue 71', 1, 'agent/issue-71-remove-today-x-tasks-counter',
             73, 'in-review', 8, 1, 7, 0)`
  ).run(TASK_ID);

  // Plant the stale pre-reset checkpoints that caused the bug.
  recordStep(TASK_ID, 1, 'verify-push', {
    branch_exists: true,
    branch_sha: 'e41281aa',
    base_sha: 'fd8e94ce',
  });
  recordStep(TASK_ID, 1, 'create-pr', { pr_number: 73, created: true });
});

describe('resetTask — checkpoint cleanup', () => {
  it('deletes all step checkpoints for the task on reset', async () => {
    const forgejo = makeForgejoStub();
    const scheduler = { triggerTick: vi.fn() };

    await resetTask(
      task(),
      forgejo as any,
      scheduler as any,
      silentLog,
      { requeue: true }
    );

    expect(getStep(TASK_ID, 1, 'verify-push')).toBeUndefined();
    expect(getStep(TASK_ID, 1, 'create-pr')).toBeUndefined();
    expect(listStepsForAttempt(TASK_ID, 1)).toEqual([]);
  });

  it('still closes the PR and resets task fields (existing behaviour intact)', async () => {
    const forgejo = makeForgejoStub();
    const scheduler = { triggerTick: vi.fn() };

    await resetTask(
      task(),
      forgejo as any,
      scheduler as any,
      silentLog,
      { requeue: true }
    );

    expect(forgejo.closePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      73
    );

    const after = getTask(TASK_ID)!;
    expect(after.status).toBe('queued');
    expect(after.pr_number).toBeNull();
    expect(after.branch_name).toBeNull();
    expect(after.attempt).toBe(1);
    expect(scheduler.triggerTick).toHaveBeenCalledTimes(1);
  });

  it('a requeued attempt re-creates the PR instead of replaying the stale one', async () => {
    const forgejo = makeForgejoStub();
    const scheduler = { triggerTick: vi.fn() };

    await resetTask(
      task(),
      forgejo as any,
      scheduler as any,
      silentLog,
      { requeue: true }
    );

    // The requeued task runs as attempt 1 again. Without the fix, this
    // runStep would replay the stale {pr_number: 73} row and never call fn.
    let createdFresh = false;
    const result = await runStep(TASK_ID, 1, 'create-pr', () => {
      createdFresh = true;
      return { pr_number: 101, created: true };
    });

    expect(createdFresh).toBe(true);
    expect(result).toEqual({ pr_number: 101, created: true });
  });
});
