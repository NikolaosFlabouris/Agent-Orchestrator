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
  updateTask: vi.fn(),
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
    updateTask: mocks.updateTask,
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
    agent_tool: null,
    model: null,
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
    `INSERT INTO repos (id, owner, name, image_type, agent_tool)
     VALUES (1, 'owner', 'repo', 'default', 'tool')`
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
    image_type: 'default',
    agent_tool: 'tool',
  });

  // Default: updateTask is a no-op
  mocks.updateTask.mockReturnValue(undefined);
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
