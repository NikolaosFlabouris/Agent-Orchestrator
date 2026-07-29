import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';
import { initDatabase } from '../../db.js';

// ---------------------------------------------------------------------------
// Mocks — installed with vi.hoisted so they are available at module-parse
// time when the modules under test are imported.
//
// We want real checkpoint behaviour (runStep / getStep using the in-memory
// DB) so we do NOT mock checkpoints.ts.  We DO mock the modules that touch
// the filesystem or make network calls.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // db helpers called directly by postDevAgent
  getRepo: vi.fn(),
  getTask: vi.fn(),
  updateTaskRaw: vi.fn(),
  // state-sync helpers
  updateTaskWithSync: vi.fn(),
  recordTaskEvent: vi.fn(),
  // workspace helpers
  verifyWorkspaceState: vi.fn(),
  getWorkdir: vi.fn().mockReturnValue('/fake/workdir'),
  detectChanges: vi.fn(),
  // forgejo-linking helpers
  buildPullRequestBody: vi.fn().mockReturnValue('pr body'),
  hasIssueLink: vi.fn().mockReturnValue(true),
  ensureIssueLink: vi.fn(),
}));

// We mock db.js but forward getDb to the real module so that checkpoints.ts
// can still access the in-memory database set up by initDatabase(':memory:').
vi.mock('../../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db.js')>();
  return {
    ...real,
    getRepo: mocks.getRepo,
    getTask: mocks.getTask,
    updateTaskRaw: mocks.updateTaskRaw,
  };
});

vi.mock('../../state-sync.js', () => ({
  updateTaskWithSync: mocks.updateTaskWithSync,
  recordTaskEvent: mocks.recordTaskEvent,
}));

vi.mock('../../workspace.js', () => ({
  verifyWorkspaceState: mocks.verifyWorkspaceState,
  getWorkdir: mocks.getWorkdir,
  detectChanges: mocks.detectChanges,
}));

vi.mock('../../forgejo-linking.js', () => ({
  buildPullRequestBody: mocks.buildPullRequestBody,
  hasIssueLink: mocks.hasIssueLink,
  ensureIssueLink: mocks.ensureIssueLink,
}));

// Import after mocks are registered.
const { postDevAgent } = await import('../../agents/develop.js');

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

  // Set up a fresh in-memory DB for each test so checkpoints don't bleed
  // across tests.
  const db = initDatabase(':memory:');
  db.prepare(
    `INSERT INTO repos (id, owner, name)
     VALUES (1, 'owner', 'repo')`
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count)
     VALUES (1, 10, 1, 'in-progress', 1, 3, 0)`
  ).run();

  // Default repo mock
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

  // Default: updateTaskRaw is a no-op
  mocks.updateTaskRaw.mockReturnValue(undefined);
  mocks.updateTaskWithSync.mockReturnValue(undefined);
  mocks.verifyWorkspaceState.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('postDevAgent — verify-push idempotency', () => {
  it('invokes getBranch only once across two simulated runs of the same attempt', async () => {
    const task = mkTask();

    const getBranch = vi.fn().mockImplementation(async (_repo: unknown, branch: string) => {
      if (branch === 'agent/issue-10-test') {
        return { name: branch, commit: { id: 'abc123', message: 'feat' } };
      }
      // base branch
      return { name: branch, commit: { id: 'base000', message: 'base' } };
    });

    const getPullRequest = vi.fn().mockResolvedValue({
      number: 42,
      body: 'Closes #10',
      head: { ref: 'agent/issue-10-test', sha: 'abc123' },
      base: { ref: 'main' },
    });

    const forgejo = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      getBranch,
      createPullRequest: vi.fn().mockResolvedValue({ number: 42, body: 'Closes #10' }),
      getPullRequest,
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    // First run — getBranch should be called
    await postDevAgent(task, forgejo, silentLog);

    const callsAfterFirstRun = getBranch.mock.calls.length;
    // Exactly 2 getBranch calls: one for the agent branch, one for the base branch.
    expect(callsAfterFirstRun).toBe(2);

    // Second run with the same (task_id, attempt) — verify-push is cached;
    // getBranch should NOT be called again
    await postDevAgent(task, forgejo, silentLog);

    expect(getBranch.mock.calls.length).toBe(callsAfterFirstRun);
  });
});

describe('postDevAgent — no-changes failure reason', () => {
  it('records a no_changes task_event when the branch matches base', async () => {
    const task = mkTask();

    const forgejo = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      // Both the agent branch and the base branch resolve to the same SHA, so
      // the agent produced no net changes.
      getBranch: vi.fn().mockResolvedValue({
        name: 'any',
        commit: { id: 'samesha', message: 'base' },
      }),
      createPullRequest: vi.fn(),
      getPullRequest: vi.fn(),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await postDevAgent(task, forgejo, silentLog);

    expect(result).toBe(false);
    // Task stays in the failed terminal state.
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'failed' })
    );
    // A distinct, greppable no_changes event is recorded with the reason.
    const noChangesCalls = mocks.recordTaskEvent.mock.calls.filter(
      (call: unknown[]) => call[1] === 'no_changes'
    );
    expect(noChangesCalls).toHaveLength(1);
    expect(noChangesCalls[0][0]).toBe(task.id);
    expect(noChangesCalls[0][2]).toMatch(/no changes/i);
    // PR creation must not happen on the no-changes path.
    expect(forgejo.createPullRequest).not.toHaveBeenCalled();
  });
});

describe('postDevAgent — create-pr idempotency', () => {
  it('does not re-create the PR on a second invocation with the same (task_id, attempt)', async () => {
    const task = mkTask();

    const createPullRequest = vi.fn().mockResolvedValue({ number: 42, body: 'Closes #10' });

    const getPullRequest = vi.fn().mockResolvedValue({
      number: 42,
      body: 'Closes #10',
      head: { ref: 'agent/issue-10-test', sha: 'abc123' },
      base: { ref: 'main' },
    });

    const forgejo = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      getBranch: vi.fn().mockImplementation(async (_repo: unknown, branch: string) => {
        if (branch === 'agent/issue-10-test') {
          return { name: branch, commit: { id: 'abc123', message: 'feat' } };
        }
        return { name: branch, commit: { id: 'base000', message: 'base' } };
      }),
      // No pre-existing PR on the branch → the orchestrator creates one.
      listPullRequests: vi.fn().mockResolvedValue([]),
      createPullRequest,
      getPullRequest,
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    // First run — PR should be created
    await postDevAgent(task, forgejo, silentLog);
    expect(createPullRequest).toHaveBeenCalledTimes(1);

    // Count 'pr_created' events after first run — should be exactly 1
    const prCreatedCallsAfterFirst = mocks.recordTaskEvent.mock.calls.filter(
      (call: unknown[]) => call[1] === 'pr_created'
    ).length;
    expect(prCreatedCallsAfterFirst).toBe(1);

    // Second run — PR creation is checkpointed; should NOT be called again
    await postDevAgent(task, forgejo, silentLog);
    expect(createPullRequest).toHaveBeenCalledTimes(1);

    // 'pr_created' must still have been recorded only once total across both runs
    const prCreatedCallsAfterSecond = mocks.recordTaskEvent.mock.calls.filter(
      (call: unknown[]) => call[1] === 'pr_created'
    ).length;
    expect(prCreatedCallsAfterSecond).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PR reconciliation matrix — Accept / Repair / Recreate / Surface.
// The dev agent (or a prior run) may already have a PR on the branch; the
// orchestrator reconciles instead of blindly POSTing a duplicate (which 409s).
// ---------------------------------------------------------------------------

import { ForgejoApiError } from '../../forgejo.js';

const BRANCH = 'agent/issue-10-test';

// Drives verify-push to "branch exists and is ahead of base" so flow reaches
// the create-pr step. Mirrors the create-pr idempotency test's setup.
function aheadBranch() {
  return vi.fn().mockImplementation(async (_repo: unknown, branch: string) =>
    branch === BRANCH
      ? { name: branch, commit: { id: 'abc123', message: 'feat' } }
      : { name: branch, commit: { id: 'base000', message: 'base' } }
  );
}

function eventTypes() {
  return mocks.recordTaskEvent.mock.calls.map((c: unknown[]) => c[1]);
}

describe('postDevAgent — PR reconciliation', () => {
  it('ADOPTS a pre-existing open PR that already targets the correct base', async () => {
    const task = mkTask();
    const createPullRequest = vi.fn();
    const closePullRequest = vi.fn();
    const forgejo = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      getBranch: aheadBranch(),
      listPullRequests: vi.fn().mockResolvedValue([
        { number: 7, body: 'Closes #10', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'main' } },
      ]),
      createPullRequest,
      closePullRequest,
      getPullRequest: vi.fn().mockResolvedValue({
        number: 7, body: 'Closes #10', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'main' },
      }),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await postDevAgent(task, forgejo, silentLog);

    expect(result).toBe(true);
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(task.id, { pr_number: 7 });
    expect(eventTypes()).toContain('pr_adopted');
  });

  it('RECREATES a mis-targeted PR: closes the wrong one and opens against the correct base', async () => {
    const task = mkTask();
    const createPullRequest = vi.fn().mockResolvedValue({ number: 99, body: 'Closes #10' });
    const closePullRequest = vi.fn().mockResolvedValue(undefined);
    const forgejo = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      getBranch: aheadBranch(),
      listPullRequests: vi.fn().mockResolvedValue([
        { number: 8, body: 'x', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'develop' } },
      ]),
      createPullRequest,
      closePullRequest,
      getPullRequest: vi.fn().mockResolvedValue({
        number: 99, body: 'Closes #10', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'main' },
      }),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await postDevAgent(task, forgejo, silentLog);

    expect(result).toBe(true);
    expect(closePullRequest).toHaveBeenCalledWith(expect.anything(), 8);
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(task.id, { pr_number: 99 });
    expect(eventTypes()).toContain('pr_recreated');
  });

  it('SURFACES (fails) when multiple open PRs exist on the branch and none target the base', async () => {
    const task = mkTask();
    const createPullRequest = vi.fn();
    const closePullRequest = vi.fn();
    const forgejo = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      getBranch: aheadBranch(),
      listPullRequests: vi.fn().mockResolvedValue([
        { number: 8, body: 'x', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'develop' } },
        { number: 9, body: 'y', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'release' } },
      ]),
      createPullRequest,
      closePullRequest,
      getPullRequest: vi.fn(),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await postDevAgent(task, forgejo, silentLog);

    expect(result).toBe(false);
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(closePullRequest).not.toHaveBeenCalled();
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ status: 'failed' })
    );
    expect(eventTypes()).toContain('pr_creation_failed');
  });

  it('on a 409 create race, re-reads and ADOPTS the PR that beat it (no failure)', async () => {
    const task = mkTask();
    const createPullRequest = vi
      .fn()
      .mockRejectedValue(new ForgejoApiError('conflict', 409, 'pull request already exists'));
    const forgejo = {
      getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
      getBranch: aheadBranch(),
      // First lookup: empty → we attempt create. Create 409s. Second lookup
      // (the fallback) now sees the PR the agent opened in the gap.
      listPullRequests: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { number: 14, body: 'Closes #10', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'main' } },
        ]),
      createPullRequest,
      closePullRequest: vi.fn(),
      getPullRequest: vi.fn().mockResolvedValue({
        number: 14, body: 'Closes #10', changed_files: 5, head: { ref: BRANCH, sha: 'abc123' }, base: { ref: 'main' },
      }),
      commentOnIssue: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await postDevAgent(task, forgejo, silentLog);

    expect(result).toBe(true);
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(task.id, { pr_number: 14 });
    expect(eventTypes()).toContain('pr_adopted');
    expect(eventTypes()).not.toContain('pr_creation_failed');
  });
});
