import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';
import { initDatabase } from '../../db.js';
import { recordStep } from '../../checkpoints.js';

// ---------------------------------------------------------------------------
// Mocks
//
// We use real checkpoints (getStep/recordStep via the in-memory DB) so we
// can plant checkpoint rows before calling recoverTask.  Everything else
// that would touch the filesystem or Docker is mocked.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getTasks: vi.fn(),
  getRepo: vi.fn(),
  updateTaskRaw: vi.fn(),
  updateTaskWithSync: vi.fn(),
  recordTaskEvent: vi.fn(),
  insertTaskEvent: vi.fn(),
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  inspectContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  getWorkdir: vi.fn().mockReturnValue('/fake/workdir'),
  getOutputDir: vi.fn().mockReturnValue('/fake/output'),
  getTaskDir: vi.fn().mockReturnValue('/fake/task'),
  detectChanges: vi.fn(),
  buildPullRequestBody: vi.fn().mockReturnValue('pr body'),
  runOrphanSweep: vi.fn().mockResolvedValue(undefined),
}));

// Forward getDb to the real module so checkpoints still work.
vi.mock('../../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db.js')>();
  return {
    ...real,
    getTasks: mocks.getTasks,
    getRepo: mocks.getRepo,
    updateTaskRaw: mocks.updateTaskRaw,
    insertTaskEvent: mocks.insertTaskEvent,
  };
});

// recovery.ts routes every status transition AND every timeline row through
// state-sync now, so the broadcasting wrappers are what the assertions below
// watch.
vi.mock('../../state-sync.js', () => ({
  updateTaskWithSync: mocks.updateTaskWithSync,
  recordTaskEvent: mocks.recordTaskEvent,
}));

vi.mock('../../docker.js', () => ({
  listContainers: mocks.listContainers,
  getContainer: mocks.getContainer,
  inspectContainer: mocks.inspectContainer,
  stopContainer: mocks.stopContainer,
  removeContainer: mocks.removeContainer,
}));

vi.mock('../../workspace.js', () => ({
  getWorkdir: mocks.getWorkdir,
  getOutputDir: mocks.getOutputDir,
  getTaskDir: mocks.getTaskDir,
  detectChanges: mocks.detectChanges,
}));

vi.mock('../../forgejo-linking.js', () => ({
  buildPullRequestBody: mocks.buildPullRequestBody,
}));

vi.mock('../../orphan-recovery.js', () => ({
  runOrphanSweep: mocks.runOrphanSweep,
}));

// Import after mocks are registered.
const { onStartup } = await import('../../recovery.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 10,
    issue_title: 'Test issue',
    repo_id: 1,
    branch_name: 'agent/issue-10-test',
    pr_number: null,
    status: 'in-progress',
    queue_position: null,
    attempt: 1,
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
    completed_at: null,
    created_at: '2026-01-01T00:00:00Z',
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

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Fresh in-memory DB so checkpoint rows don't bleed across tests.
  const db = initDatabase(':memory:');
  db.prepare(
    `INSERT INTO repos (id, owner, name)
     VALUES (1, 'owner', 'repo')`
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count)
     VALUES (1, 10, 1, 'in-progress', 1, 3, 0)`
  ).run();

  // Default mocks
  mocks.getRepo.mockReturnValue({
    id: 1,
    owner: 'owner',
    name: 'repo',
    base_branch: 'main',
    agent_profile_id: null,
    review_agent_profile_id: null,
    install_steps: [],
    allow_script_steps: false,
    container_memory_mb: null,
    container_cpu_cores: null,
    merge_strategy: 'squash',
  });
  mocks.updateTaskRaw.mockReturnValue(undefined);
  mocks.updateTaskWithSync.mockReturnValue(undefined);
  mocks.insertTaskEvent.mockReturnValue(undefined);
  mocks.listContainers.mockResolvedValue([]);
  mocks.runOrphanSweep.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests: recoverTask via onStartup
//
// onStartup is the exported entry-point; recoverTask is called internally
// for tasks with no container.  We drive the tests through onStartup to
// keep them black-box.
// ---------------------------------------------------------------------------

describe('recoverTask — verify-push checkpoint exists, no create-pr checkpoint', () => {
  it('calls createPullRequest exactly once', async () => {
    const task = mkTask({ status: 'in-progress', container_id: null });

    // Plant a verify-push checkpoint indicating the branch was pushed.
    recordStep(task.id, task.attempt, 'verify-push', {
      branch_exists: true,
      branch_sha: 'abc123',
      base_sha: 'base000',
    });

    // No create-pr checkpoint — recovery must create the PR.

    const createPullRequest = vi.fn().mockResolvedValue({ number: 42, body: 'Closes #10' });

    const forgejo = {
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'bot' }),
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      createPullRequest,
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    const scheduler = {
      pause: vi.fn(),
      processCompletedTask: vi.fn(),
    } as any;

    // onStartup fetches in-flight tasks; return our task in 'in-progress'.
    mocks.getTasks.mockImplementation(({ status }: { status: string }) =>
      status === 'in-progress' ? [task] : []
    );

    await onStartup(forgejo, scheduler, silentLog);

    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'in-review' })
    );
  });
});

describe('recoverTask — both verify-push and create-pr checkpoints exist', () => {
  it('does not call createPullRequest', async () => {
    const task = mkTask({ status: 'in-progress', container_id: null });

    // Plant both checkpoints — postDevAgent already completed everything.
    recordStep(task.id, task.attempt, 'verify-push', {
      branch_exists: true,
      branch_sha: 'abc123',
      base_sha: 'base000',
    });
    recordStep(task.id, task.attempt, 'create-pr', {
      pr_number: 42,
      created: true,
    });

    const createPullRequest = vi.fn().mockResolvedValue({ number: 42, body: 'Closes #10' });

    const forgejo = {
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'bot' }),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
      createPullRequest,
    } as any;

    const scheduler = {
      pause: vi.fn(),
      processCompletedTask: vi.fn(),
    } as any;

    mocks.getTasks.mockImplementation(({ status }: { status: string }) =>
      status === 'in-progress' ? [task] : []
    );

    await onStartup(forgejo, scheduler, silentLog);

    expect(createPullRequest).not.toHaveBeenCalled();
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'in-review' })
    );
  });
});

describe('recoverTask — verify-push checkpoint with branch_exists: false, no create-pr checkpoint', () => {
  it('does not call createPullRequest and does not transition to in-review', async () => {
    const task = mkTask({ status: 'in-progress', container_id: null });

    // Plant a verify-push checkpoint indicating the branch was NOT pushed.
    // This means the crash happened before salvage-local ran.
    recordStep(task.id, task.attempt, 'verify-push', {
      branch_exists: false,
      branch_sha: null,
      base_sha: 'base000',
    });

    // No create-pr checkpoint.

    const createPullRequest = vi.fn().mockResolvedValue({ number: 42, body: 'Closes #10' });

    // The fallback derivation will inspect the branch on Forgejo and the
    // local workspace.  Return no branch so the task falls through to
    // resetToQueued.  Note: detectChanges is NOT called — the recovery path
    // gates the workspace check behind `fs.existsSync(workdir/.git)`, which
    // returns false for the fake workdir path used in this test.
    const getBranch = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));

    const forgejo = {
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'bot' }),
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      getBranch,
      createPullRequest,
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    const scheduler = {
      pause: vi.fn(),
      processCompletedTask: vi.fn(),
    } as any;

    mocks.getTasks.mockImplementation(({ status }: { status: string }) =>
      status === 'in-progress' ? [task] : []
    );

    await onStartup(forgejo, scheduler, silentLog);

    // PR must NOT be created — the branch doesn't exist on the remote yet.
    expect(createPullRequest).not.toHaveBeenCalled();

    // Task must NOT be moved to in-review without a valid branch/PR.
    const inReviewCall = mocks.updateTaskWithSync.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' &&
        call[1] !== null &&
        (call[1] as Record<string, unknown>).status === 'in-review'
    );
    expect(inReviewCall).toBeUndefined();
  });
});
