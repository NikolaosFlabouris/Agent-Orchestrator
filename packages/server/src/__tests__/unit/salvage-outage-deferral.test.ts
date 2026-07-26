import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';
import { initDatabase } from '../../db.js';

// ---------------------------------------------------------------------------
// Salvage-push resilience during a git-host outage (#144).
//
// `postDevAgent` salvages work the agent left behind but never pushed: it
// commits it and force-pushes the branch. Before this change the push had two
// immediate retries and then emitted a TERMINAL `salvage_failed` — during the
// 2026-07-23 Forgejo outage that stranded two finished implementation runs,
// even though the work was sitting safe on disk the whole time.
//
// Now an outage-shaped push failure defers instead: the task keeps its
// workspace, the retry is scheduled with the same escalating backoff the
// scheduler uses for prep, and the scheduler's deferred-salvage sweep picks it
// up later. Structural push failures (auth, protected branch, missing git
// identity) still fail terminally, unchanged.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getRepo: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  updateTaskWithSync: vi.fn(),
  recordTaskEvent: vi.fn(),
  verifyWorkspaceState: vi.fn(),
  getWorkdir: vi.fn().mockReturnValue('/fake/workdir'),
  detectChanges: vi.fn(),
  buildPullRequestBody: vi.fn().mockReturnValue('pr body'),
  hasIssueLink: vi.fn().mockReturnValue(true),
  ensureIssueLink: vi.fn(),
  /** (command, args) -> Error to throw, or null to succeed. */
  execFileHandler: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void
  ) => {
    const done = typeof _opts === 'function' ? (_opts as typeof cb) : cb;
    const err = mocks.execFileHandler(cmd, args) as Error | null;
    if (err) done(err);
    else done(null, { stdout: '', stderr: '' });
  },
}));

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

const { postDevAgent } = await import('../../agents/develop.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BRANCH = 'agent/issue-10-test';

/** The push failure Forgejo produced while it was unreachable. */
const OUTAGE_PUSH_ERROR = new Error(
  "Command failed: git push -f origin agent/issue-10-test\nfatal: unable to access 'http://agent:tok3n@forgejo:3000/owner/repo.git/': Failed to connect to forgejo port 3000: Connection refused"
);
/** A push failure that is the task's own fault — must stay terminal. */
const STRUCTURAL_PUSH_ERROR = new Error(
  'Command failed: git push -f origin agent/issue-10-test\n! [remote rejected] agent/issue-10-test -> agent/issue-10-test (pre-receive hook declined)'
);

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 10,
    issue_title: 'Test issue',
    repo_id: 1,
    branch_name: BRANCH,
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
    created_at: '2026-07-23T00:00:00Z',
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

/** Forgejo stub where the agent's branch does NOT exist on the remote (so
 *  postDevAgent goes down the salvage path) and PR creation works. */
function makeForgejo() {
  return {
    getIssue: vi.fn().mockResolvedValue({ title: 'Test issue', number: 10 }),
    getBranch: vi.fn().mockImplementation(async (_repo: unknown, branch: string) => {
      if (branch === BRANCH) throw new Error('404 branch not found');
      return { name: branch, commit: { id: 'base000', message: 'base' } };
    }),
    listBranches: vi.fn().mockResolvedValue([]),
    listPullRequests: vi.fn().mockResolvedValue([]),
    createPullRequest: vi.fn().mockResolvedValue({ number: 42, body: 'Closes #10' }),
    getPullRequest: vi.fn().mockResolvedValue({
      number: 42,
      body: 'Closes #10',
      changed_files: 3,
      head: { ref: BRANCH, sha: 'abc123' },
      base: { ref: 'main' },
    }),
    commentOnIssue: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function eventsOfType(type: string): string[] {
  return mocks.recordTaskEvent.mock.calls
    .filter((c: unknown[]) => c[1] === type)
    .map((c: unknown[]) => c[2] as string);
}

function updatePatches(): Array<Record<string, unknown>> {
  return mocks.updateTask.mock.calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();

  const db = initDatabase(':memory:');
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'owner', 'repo')`).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count)
     VALUES (1, 10, 1, 'in-progress', 1, 3, 0)`
  ).run();

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
  mocks.getTask.mockReturnValue(mkTask());
  mocks.updateTask.mockReturnValue(undefined);
  mocks.updateTaskWithSync.mockReturnValue(undefined);
  mocks.verifyWorkspaceState.mockResolvedValue(undefined);
  // The agent left uncommitted work behind and never pushed a branch.
  mocks.detectChanges.mockResolvedValue({
    hasUncommitted: true,
    hasUntracked: false,
    hasLocalCommits: false,
  });
  // add/commit succeed by default; individual tests fail the push.
  mocks.execFileHandler.mockReturnValue(null);
});

// ---------------------------------------------------------------------------

describe('salvage push during a git-host outage', () => {
  it('defers instead of terminally failing the task', async () => {
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'push' ? OUTAGE_PUSH_ERROR : null
    );
    const forgejo = makeForgejo();

    const ready = await postDevAgent(mkTask(), forgejo, silentLog);

    expect(ready).toBe(false);
    // The work is NOT abandoned: no terminal failure, no salvage_failed.
    expect(mocks.updateTaskWithSync).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed' })
    );
    expect(eventsOfType('salvage_failed')).toHaveLength(0);

    // It is deferred, with the outcome visible on the timeline.
    const deferred = eventsOfType('salvage_deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatch(/git host unreachable/i);
    expect(deferred[0]).toMatch(/preserved in workspace/i);
    // …and the underlying git text is carried, with the token redacted.
    expect(deferred[0]).toContain('Connection refused');
    expect(deferred[0]).not.toContain('tok3n');
  });

  it('persists an escalating retry schedule', async () => {
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'push' ? OUTAGE_PUSH_ERROR : null
    );
    const before = Date.now();

    await postDevAgent(mkTask(), makeForgejo(), silentLog);
    const first = updatePatches().find((p) => 'salvage_next_attempt_at' in p)!;
    expect(first.salvage_backoff_level).toBe(1);
    expect(Date.parse(first.salvage_next_attempt_at as string)).toBeGreaterThan(
      before + 30_000
    );

    // The next deferral escalates off the PERSISTED level, not the stale
    // in-memory task row the caller happens to be holding.
    mocks.updateTask.mockClear();
    mocks.getTask.mockReturnValue(mkTask({ salvage_backoff_level: 3 }));
    await postDevAgent(mkTask(), makeForgejo(), silentLog);
    const second = updatePatches().find((p) => 'salvage_next_attempt_at' in p)!;
    expect(second.salvage_backoff_level).toBe(4);
    expect(
      Date.parse(second.salvage_next_attempt_at as string) - Date.now()
    ).toBeGreaterThan(Date.parse(first.salvage_next_attempt_at as string) - before);
  });

  it('comments on the issue so the operator knows the work is safe', async () => {
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'push' ? OUTAGE_PUSH_ERROR : null
    );
    const forgejo = makeForgejo();

    await postDevAgent(mkTask(), forgejo, silentLog);

    const comment = forgejo.commentOnIssue.mock.calls.at(-1)![2] as string;
    expect(comment).toMatch(/retried automatically/i);
    expect(comment).not.toContain('tok3n');
  });

  it('comments only on the first deferral, not on every retry', async () => {
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'push' ? OUTAGE_PUSH_ERROR : null
    );
    // Second and later deferrals of the same outage.
    mocks.getTask.mockReturnValue(mkTask({ salvage_backoff_level: 1 }));
    const forgejo = makeForgejo();

    await postDevAgent(mkTask(), forgejo, silentLog);

    expect(eventsOfType('salvage_deferred')).toHaveLength(1);
    expect(forgejo.commentOnIssue).not.toHaveBeenCalled();
  });

  it('classifies on the full stderr, not the truncated event text', async () => {
    // A wall of git output with the outage signature past the 500-char
    // event limit. Classifying the truncated copy would misread this as
    // structural and terminally fail a task whose work is fine.
    const noisy = new Error(
      `Command failed: git push -f origin ${BRANCH}\n${'remote: Counting objects\n'.repeat(40)}fatal: Could not read from remote repository.`
    );
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'push' ? noisy : null
    );

    const ready = await postDevAgent(mkTask(), makeForgejo(), silentLog);

    expect(ready).toBe(false);
    expect(eventsOfType('salvage_deferred')).toHaveLength(1);
    expect(eventsOfType('salvage_failed')).toHaveLength(0);
  });

  it('retries the push twice inside the run before deferring', async () => {
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'push' ? OUTAGE_PUSH_ERROR : null
    );

    await postDevAgent(mkTask(), makeForgejo(), silentLog);

    const pushCalls = mocks.execFileHandler.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[])[0] === 'push'
    );
    expect(pushCalls).toHaveLength(2);
  });

  it('clears the deferral and opens the PR once the host comes back', async () => {
    // Simulates the scheduler's deferred-salvage sweep re-running
    // postDevAgent after the outage: the push now succeeds.
    mocks.getTask.mockReturnValue(
      mkTask({
        salvage_backoff_level: 2,
        salvage_next_attempt_at: '2026-07-23T10:00:00.000Z',
      })
    );
    const forgejo = makeForgejo();

    const ready = await postDevAgent(mkTask(), forgejo, silentLog);

    expect(ready).toBe(true);
    expect(updatePatches()).toContainEqual({
      salvage_backoff_level: 0,
      salvage_next_attempt_at: null,
    });
    expect(eventsOfType('work_salvaged')).toHaveLength(1);
    expect(forgejo.createPullRequest).toHaveBeenCalledTimes(1);
  });
});

describe('structural salvage failures stay terminal', () => {
  it('fails the task when the remote rejects the push', async () => {
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'push' ? STRUCTURAL_PUSH_ERROR : null
    );

    const ready = await postDevAgent(mkTask(), makeForgejo(), silentLog);

    expect(ready).toBe(false);
    expect(mocks.updateTaskWithSync).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'failed' })
    );
    const failed = eventsOfType('salvage_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/pre-receive hook declined/);
    expect(eventsOfType('salvage_deferred')).toHaveLength(0);
    // No stale deferral is left behind for the retry sweep to resurrect.
    expect(updatePatches()).toContainEqual({
      salvage_backoff_level: 0,
      salvage_next_attempt_at: null,
    });
  });

  it('fails the task when the commit itself cannot be made', async () => {
    mocks.execFileHandler.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'commit'
        ? new Error('Command failed: git commit\n*** Please tell me who you are.')
        : null
    );

    const ready = await postDevAgent(mkTask(), makeForgejo(), silentLog);

    expect(ready).toBe(false);
    expect(eventsOfType('salvage_failed')).toHaveLength(1);
    expect(eventsOfType('salvage_deferred')).toHaveLength(0);
  });
});
