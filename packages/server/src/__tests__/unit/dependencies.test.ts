import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Repo } from '@orchestrator/shared';
import {
  initDatabase,
  insertTask,
  updateTask,
  getTask,
  getTaskDependencies,
  getDependentTasks,
  getTaskByRepoIssue,
  upsertTaskDependency,
  deleteTaskDependenciesExcept,
  getTaskEvents,
  getRepo,
} from '../../db.js';
import {
  parseDependencySection,
  formatDependencySection,
  upsertDependencySection,
  stripDependencySection,
  isBlocked,
  dependencyPathExists,
  validateDependencies,
  evaluateTaskDependencies,
  syncTaskDependencies,
  createDependencyPassState,
  runQueuedDependencyPass,
  dependencyGateAllows,
  _clearDependencyCache,
  type DependencyForgejo,
} from '../../dependencies.js';
import { ForgejoApiError } from '../../forgejo.js';

// ---------------------------------------------------------------------------
// Pure text functions (no DB)
// ---------------------------------------------------------------------------

describe('parseDependencySection', () => {
  it('parses checklist items under a ## Dependencies heading', () => {
    const body = `## Task\nDo it\n\n## Dependencies\n- [ ] #38\n- [ ] #39`;
    expect(parseDependencySection(body)).toEqual([
      { issue: 38, checked: false },
      { issue: 39, checked: false },
    ]);
  });

  it('ignores checklist items outside a Dependencies section', () => {
    const body = `## Acceptance criteria\n- [ ] #12 follow-up filed\n\n- [ ] #99`;
    expect(parseDependencySection(body)).toEqual([]);
  });

  it('accepts ### Dependencies but not # Dependencies', () => {
    expect(
      parseDependencySection(`### Dependencies\n- [ ] #1`)
    ).toEqual([{ issue: 1, checked: false }]);
    expect(parseDependencySection(`# Dependencies\n- [ ] #1`)).toEqual([]);
  });

  it('matches the heading case-insensitively', () => {
    expect(
      parseDependencySection(`## dependencies\n- [ ] #7`)
    ).toEqual([{ issue: 7, checked: false }]);
  });

  it('terminates the section at the next heading of equal or higher level', () => {
    const body = `## Dependencies\n- [ ] #1\n\n## Notes\n- [ ] #2`;
    expect(parseDependencySection(body)).toEqual([{ issue: 1, checked: false }]);
  });

  it('does not terminate the section at a deeper heading', () => {
    const body = `## Dependencies\n#### Group A\n- [ ] #1\n#### Group B\n- [ ] #2\n## Done`;
    expect(parseDependencySection(body).map((d) => d.issue)).toEqual([1, 2]);
  });

  it('tolerates *, + bullets and indentation', () => {
    const body = `## Dependencies\n* [ ] #1\n+ [ ] #2\n  - [ ] #3`;
    expect(parseDependencySection(body).map((d) => d.issue)).toEqual([1, 2, 3]);
  });

  it('parses the checked flag (x and X)', () => {
    const body = `## Dependencies\n- [x] #1\n- [X] #2\n- [ ] #3`;
    expect(parseDependencySection(body)).toEqual([
      { issue: 1, checked: true },
      { issue: 2, checked: true },
      { issue: 3, checked: false },
    ]);
  });

  it('unchecked wins when the same issue is listed both ways', () => {
    const body = `## Dependencies\n- [x] #5\n- [ ] #5`;
    expect(parseDependencySection(body)).toEqual([{ issue: 5, checked: false }]);
    const reversed = `## Dependencies\n- [ ] #5\n- [x] #5`;
    expect(parseDependencySection(reversed)).toEqual([
      { issue: 5, checked: false },
    ]);
  });

  it('dedupes duplicate lines', () => {
    const body = `## Dependencies\n- [ ] #5\n- [ ] #5`;
    expect(parseDependencySection(body)).toEqual([{ issue: 5, checked: false }]);
  });

  it('ignores cross-repo and URL references', () => {
    const body = `## Dependencies\n- [ ] owner/repo#38\n- [ ] https://forge/o/r/issues/39\n- [ ] #40`;
    expect(parseDependencySection(body).map((d) => d.issue)).toEqual([40]);
  });

  it('returns empty for a heading with no items, or no heading at all', () => {
    expect(parseDependencySection(`## Dependencies\n\nnothing here`)).toEqual([]);
    expect(parseDependencySection('plain text')).toEqual([]);
    expect(parseDependencySection('')).toEqual([]);
  });

  it('unions multiple Dependencies sections', () => {
    const body = `## Dependencies\n- [ ] #1\n\n## Middle\ntext\n\n## Dependencies\n- [ ] #2`;
    expect(parseDependencySection(body).map((d) => d.issue)).toEqual([1, 2]);
  });

  it('handles CRLF line endings', () => {
    const body = `## Dependencies\r\n- [ ] #11\r\n- [x] #12\r\n`;
    expect(parseDependencySection(body)).toEqual([
      { issue: 11, checked: false },
      { issue: 12, checked: true },
    ]);
  });

  it('tolerates extra whitespace inside the item', () => {
    expect(
      parseDependencySection(`## Dependencies\n-  [ ]  #42`)
    ).toEqual([{ issue: 42, checked: false }]);
  });
});

describe('formatDependencySection', () => {
  it('produces the canonical section', () => {
    expect(formatDependencySection([38, 39])).toBe(
      '## Dependencies\n- [ ] #38\n- [ ] #39'
    );
  });

  it('dedupes while preserving order', () => {
    expect(formatDependencySection([3, 1, 3])).toBe(
      '## Dependencies\n- [ ] #3\n- [ ] #1'
    );
  });

  it('round-trips through the parser', () => {
    const section = formatDependencySection([7, 8]);
    expect(parseDependencySection(section).map((d) => d.issue)).toEqual([7, 8]);
  });
});

describe('upsertDependencySection', () => {
  it('appends a new section when none exists', () => {
    const result = upsertDependencySection('Fix the bug.\n', [4, 5]);
    expect(result).toBe('Fix the bug.\n\n## Dependencies\n- [ ] #4\n- [ ] #5\n');
    expect(parseDependencySection(result).map((d) => d.issue)).toEqual([4, 5]);
  });

  it('creates a section in an empty body', () => {
    expect(upsertDependencySection('', [1])).toBe('## Dependencies\n- [ ] #1\n');
  });

  it('unions into an existing section without duplicating', () => {
    const body = `Intro\n\n## Dependencies\n- [x] #1\n- [ ] #2\n\n## Notes\ntext`;
    const result = upsertDependencySection(body, [2, 3]);
    expect(result).toBe(
      `Intro\n\n## Dependencies\n- [x] #1\n- [ ] #2\n- [ ] #3\n\n## Notes\ntext`
    );
  });

  it('preserves checked flags on existing items', () => {
    const body = `## Dependencies\n- [x] #1`;
    const result = upsertDependencySection(body, [1, 2]);
    expect(parseDependencySection(result)).toEqual([
      { issue: 1, checked: true },
      { issue: 2, checked: false },
    ]);
  });

  it('returns the body unchanged when everything is already present', () => {
    const body = `## Dependencies\n- [ ] #1\n- [x] #2\n`;
    expect(upsertDependencySection(body, [1, 2])).toBe(body);
  });

  it('inserts right after the heading when the section is empty', () => {
    const body = `## Dependencies\n\n## Notes\ntext`;
    expect(upsertDependencySection(body, [9])).toBe(
      `## Dependencies\n- [ ] #9\n\n## Notes\ntext`
    );
  });
});

describe('stripDependencySection', () => {
  it('removes the section and the blank gap above it', () => {
    const body = `Fix the bug.\n\n## Dependencies\n- [ ] #4\n\n## Acceptance\n- works`;
    expect(stripDependencySection(body)).toBe(
      `Fix the bug.\n\n## Acceptance\n- works`
    );
  });

  it('removes a trailing section entirely', () => {
    expect(stripDependencySection(`Fix it.\n\n## Dependencies\n- [ ] #4\n`)).toBe(
      'Fix it.'
    );
  });

  it('removes multiple sections', () => {
    const body = `## Dependencies\n- [ ] #1\n## Task\ndo it\n## Dependencies\n- [ ] #2`;
    expect(stripDependencySection(body)).toBe(`## Task\ndo it`);
  });

  it('returns bodies without a section unchanged', () => {
    const body = `Just a task\n- [ ] #5 unrelated`;
    expect(stripDependencySection(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// DB-backed pieces
// ---------------------------------------------------------------------------

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

let db: ReturnType<typeof initDatabase>;

function seedRepo(id: number, name = `repo${id}`): Repo {
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (?, 'owner', ?)`).run(
    id,
    name
  );
  return getRepo(id)!;
}

beforeEach(() => {
  db = initDatabase(':memory:');
  _clearDependencyCache();
  vi.clearAllMocks();
});

function issue(state: 'open' | 'closed') {
  return { state } as Awaited<ReturnType<DependencyForgejo['getIssue']>>;
}

function forgejoStub(
  impl: (issueNumber: number) => 'open' | 'closed' | 404 | 500
): DependencyForgejo & { getIssue: ReturnType<typeof vi.fn> } {
  return {
    getIssue: vi.fn(async (_repo: Repo, n: number) => {
      const result = impl(n);
      if (result === 404) {
        throw new ForgejoApiError('not found', 404, '');
      }
      if (result === 500) {
        throw new ForgejoApiError('boom', 500, '');
      }
      return issue(result);
    }),
  } as DependencyForgejo & { getIssue: ReturnType<typeof vi.fn> };
}

describe('task_dependencies accessors', () => {
  it('upserts, reads, and deletes rows', () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });

    upsertTaskDependency({
      task_id: task.id,
      dep_issue_number: 5,
      state: 'open',
      detail: 'issue open',
      checked: false,
      last_evaluated_at: new Date().toISOString(),
    });
    upsertTaskDependency({
      task_id: task.id,
      dep_issue_number: 6,
      state: 'satisfied',
      detail: 'issue closed',
      checked: false,
      last_evaluated_at: new Date().toISOString(),
    });

    let rows = getTaskDependencies(task.id);
    expect(rows.map((r) => [r.dep_issue_number, r.state])).toEqual([
      [5, 'open'],
      [6, 'satisfied'],
    ]);
    expect(rows[0].checked).toBe(false);

    // Upsert updates in place (no duplicate row).
    upsertTaskDependency({
      task_id: task.id,
      dep_issue_number: 5,
      state: 'satisfied',
      detail: 'issue closed',
      checked: false,
      last_evaluated_at: new Date().toISOString(),
    });
    rows = getTaskDependencies(task.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe('satisfied');

    expect(deleteTaskDependenciesExcept(task.id, new Set([5]))).toBe(1);
    expect(getTaskDependencies(task.id).map((r) => r.dep_issue_number)).toEqual(
      [5]
    );
    expect(deleteTaskDependenciesExcept(task.id, new Set())).toBe(1);
    expect(getTaskDependencies(task.id)).toEqual([]);
  });

  it('getDependentTasks is repo-scoped', () => {
    seedRepo(1);
    seedRepo(2);
    const a = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const b = insertTask({ issue_id: 11, repo_id: 2, status: 'queued' });
    const dep = {
      state: 'open' as const,
      detail: null,
      checked: false,
      last_evaluated_at: new Date().toISOString(),
    };
    upsertTaskDependency({ task_id: a.id, dep_issue_number: 7, ...dep });
    upsertTaskDependency({ task_id: b.id, dep_issue_number: 7, ...dep });

    expect(getDependentTasks(1, 7).map((t) => t.id)).toEqual([a.id]);
    expect(getDependentTasks(2, 7).map((t) => t.id)).toEqual([b.id]);
  });

  it('getTaskByRepoIssue scopes by repo', () => {
    seedRepo(1);
    seedRepo(2);
    const a = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    expect(getTaskByRepoIssue(1, 10)?.id).toBe(a.id);
    expect(getTaskByRepoIssue(2, 10)).toBeUndefined();
  });
});

describe('isBlocked', () => {
  const base = {
    id: 1,
    task_id: 1,
    dep_issue_number: 1,
    detail: null,
    checked: false,
    first_seen_at: '',
    last_evaluated_at: null,
  };
  it('is false for zero deps and all-satisfied deps', () => {
    expect(isBlocked([])).toBe(false);
    expect(
      isBlocked([
        { ...base, state: 'satisfied' },
        { ...base, state: 'manually-satisfied' },
      ])
    ).toBe(false);
  });
  it('is true when any dep is unsatisfied', () => {
    for (const state of [
      'open',
      'in-progress',
      'failed',
      'missing',
      'error',
      'cycle',
    ] as const) {
      expect(isBlocked([{ ...base, state }])).toBe(true);
    }
  });
});

describe('evaluateTaskDependencies', () => {
  it('checked box short-circuits without a Forgejo call', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');

    const summary = await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: true }],
      forgejo,
      log
    );

    expect(summary.blocked).toBe(false);
    expect(summary.deps[0].state).toBe('manually-satisfied');
    expect(forgejo.getIssue).not.toHaveBeenCalled();
  });

  it('tracked merged task satisfies without a Forgejo call', async () => {
    seedRepo(1);
    const depTask = insertTask({ issue_id: 5, repo_id: 1, status: 'queued' });
    updateTask(depTask.id, { status: 'merged', pr_number: 52 });
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');

    const summary = await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );

    expect(summary.blocked).toBe(false);
    expect(summary.deps[0].state).toBe('satisfied');
    expect(summary.deps[0].detail).toBe(`merged via task #${depTask.id} / PR #52`);
    expect(forgejo.getIssue).not.toHaveBeenCalled();
  });

  it('closed untracked issue satisfies; open blocks', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub((n) => (n === 5 ? 'closed' : 'open'));

    const summary = await evaluateTaskDependencies(
      task,
      [
        { issue: 5, checked: false },
        { issue: 6, checked: false },
      ],
      forgejo,
      log
    );

    expect(summary.blocked).toBe(true);
    expect(summary.deps.map((d) => [d.dep_issue_number, d.state])).toEqual([
      [5, 'satisfied'],
      [6, 'open'],
    ]);
  });

  it('404 yields missing (blocked)', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const summary = await evaluateTaskDependencies(
      task,
      [{ issue: 99, checked: false }],
      forgejoStub(() => 404),
      log
    );
    expect(summary.blocked).toBe(true);
    expect(summary.deps[0].state).toBe('missing');
  });

  it('fetch error yields error, but keeps a previously satisfied dep satisfied', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });

    // First pass: closed → satisfied.
    let summary = await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejoStub(() => 'closed'),
      log
    );
    expect(summary.deps[0].state).toBe('satisfied');

    // Second pass: Forgejo errors. Previously satisfied → stays satisfied.
    _clearDependencyCache();
    summary = await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejoStub(() => 500),
      log
    );
    expect(summary.deps[0].state).toBe('satisfied');
    expect(summary.blocked).toBe(false);

    // A dep with no satisfied history errors out (blocked).
    _clearDependencyCache();
    summary = await evaluateTaskDependencies(
      task,
      [
        { issue: 5, checked: false },
        { issue: 6, checked: false },
      ],
      forgejoStub(() => 500),
      log
    );
    expect(summary.deps.find((d) => d.dep_issue_number === 6)?.state).toBe(
      'error'
    );
    expect(summary.blocked).toBe(true);
  });

  it('caches issue lookups within the TTL', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');

    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    expect(forgejo.getIssue).toHaveBeenCalledTimes(1);
  });

  it('reflects tracked task progress as in-progress / failed', async () => {
    seedRepo(1);
    const depTask = insertTask({ issue_id: 5, repo_id: 1, status: 'queued' });
    updateTask(depTask.id, { status: 'in-progress' });
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');

    let summary = await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    expect(summary.deps[0].state).toBe('in-progress');

    updateTask(depTask.id, { status: 'failed' });
    _clearDependencyCache();
    summary = await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    expect(summary.deps[0].state).toBe('failed');
    expect(summary.blocked).toBe(true);
  });

  it('detects a two-task cycle', async () => {
    seedRepo(1);
    const taskA = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const taskB = insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');

    // A depends on B (rows persisted), then B depends on A → cycle.
    await evaluateTaskDependencies(
      taskA,
      [{ issue: 11, checked: false }],
      forgejo,
      log
    );
    const summary = await evaluateTaskDependencies(
      taskB,
      [{ issue: 10, checked: false }],
      forgejo,
      log
    );
    expect(summary.deps[0].state).toBe('cycle');
  });

  it('a self-reference is reported as a cycle', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const summary = await evaluateTaskDependencies(
      task,
      [{ issue: 10, checked: false }],
      forgejoStub(() => 'open'),
      log
    );
    expect(summary.deps[0].state).toBe('cycle');
  });

  it('a closed issue satisfies even when stale rows would suggest a cycle', async () => {
    seedRepo(1);
    const taskA = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const taskB = insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub((n) => (n === 11 ? 'closed' : 'open'));

    await evaluateTaskDependencies(
      taskA,
      [{ issue: 11, checked: false }],
      forgejo,
      log
    );
    await evaluateTaskDependencies(
      taskB,
      [{ issue: 10, checked: false }],
      forgejo,
      log
    );
    // A's dep on B: B's issue is closed → satisfied, not cycle.
    const summary = await evaluateTaskDependencies(
      taskA,
      [{ issue: 11, checked: false }],
      forgejo,
      log
    );
    expect(summary.deps[0].state).toBe('satisfied');
  });

  it('removes rows for deps no longer in the body', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');

    await evaluateTaskDependencies(
      task,
      [
        { issue: 5, checked: false },
        { issue: 6, checked: false },
      ],
      forgejo,
      log
    );
    const summary = await evaluateTaskDependencies(
      task,
      [{ issue: 6, checked: false }],
      forgejo,
      log
    );
    expect(summary.deps.map((d) => d.dep_issue_number)).toEqual([6]);
    expect(summary.changed).toBe(true);
  });

  it('records timeline events on blocked/unblocked transitions only', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    let state: 'open' | 'closed' = 'open';
    const forgejo = forgejoStub(() => state);

    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    // Re-evaluating while still blocked must not duplicate the event.
    _clearDependencyCache();
    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );

    state = 'closed';
    _clearDependencyCache();
    await evaluateTaskDependencies(
      task,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );

    const events = getTaskEvents(task.id).map((e) => e.event_type);
    expect(events.filter((e) => e === 'dependencies_blocked')).toHaveLength(1);
    expect(events.filter((e) => e === 'dependencies_unblocked')).toHaveLength(1);
  });

  it('syncTaskDependencies parses the body and evaluates', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const summary = await syncTaskDependencies(
      task,
      `Do it\n\n## Dependencies\n- [ ] #5`,
      forgejoStub(() => 'closed'),
      log
    );
    expect(summary.blocked).toBe(false);
    expect(getTaskDependencies(task.id)).toHaveLength(1);
  });

  it('a task with no dependency section is never blocked', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const summary = await syncTaskDependencies(
      task,
      'Just a task',
      forgejoStub(() => 'open'),
      log
    );
    expect(summary.blocked).toBe(false);
    expect(summary.deps).toEqual([]);
    expect(getTaskEvents(task.id)).toEqual([]);
  });
});

describe('dependencyPathExists / validateDependencies', () => {
  it('follows persisted rows across tracked tasks', async () => {
    seedRepo(1);
    const a = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');
    // 10 → 11
    await evaluateTaskDependencies(
      a,
      [{ issue: 11, checked: false }],
      forgejo,
      log
    );
    expect(dependencyPathExists(1, 10, 11)).toBe(true);
    expect(dependencyPathExists(1, 11, 10)).toBe(false);
    // Untracked issues are leaves.
    expect(dependencyPathExists(1, 99, 10)).toBe(false);
  });

  it('rejects invalid numbers, duplicates, and self-references', async () => {
    const repo = seedRepo(1);
    const result = await validateDependencies(
      repo,
      [0, 2.5, 7, 7, 10],
      forgejoStub(() => 'open'),
      { selfIssueNumber: 10 }
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Invalid issue number: 0',
        'Invalid issue number: 2.5',
        'Duplicate dependency: #7',
        'Issue #10 cannot depend on itself',
      ])
    );
  });

  it('rejects nonexistent issues and unverifiable issues', async () => {
    const repo = seedRepo(1);
    let result = await validateDependencies(repo, [99], forgejoStub(() => 404));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Issue #99 not found');

    result = await validateDependencies(repo, [99], forgejoStub(() => 500));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Could not verify issue #99');
  });

  it('warns (not errors) on already-closed deps', async () => {
    const repo = seedRepo(1);
    const result = await validateDependencies(
      repo,
      [5],
      forgejoStub(() => 'closed')
    );
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain('already closed');
  });

  it('rejects a dependency that would create a cycle', async () => {
    const repo = seedRepo(1);
    const a = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });
    const forgejo = forgejoStub(() => 'open');
    // Task for issue 10 already depends on issue 11.
    await evaluateTaskDependencies(
      a,
      [{ issue: 11, checked: false }],
      forgejo,
      log
    );
    // Queue-existing intake on issue 11 declaring a dep on 10 → cycle.
    const result = await validateDependencies(repo, [10], forgejo, {
      selfIssueNumber: 11,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Circular dependency');
  });

  it('accepts a clean list', async () => {
    const repo = seedRepo(1);
    const result = await validateDependencies(
      repo,
      [5, 6],
      forgejoStub(() => 'open')
    );
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// Scheduler pass + launch gate
// ---------------------------------------------------------------------------

/** Stub that serves both the task's own issue (body) and dep issues
 *  (state). Unknown numbers 404. */
function passStub(
  issues: Record<
    number,
    { state?: 'open' | 'closed'; body?: string } | 404 | 500
  >
): DependencyForgejo & { getIssue: ReturnType<typeof vi.fn> } {
  return {
    getIssue: vi.fn(async (_repo: Repo, n: number) => {
      const spec = issues[n];
      if (spec === undefined || spec === 404) {
        throw new ForgejoApiError('not found', 404, '');
      }
      if (spec === 500) throw new ForgejoApiError('boom', 500, '');
      return { state: spec.state ?? 'open', body: spec.body ?? '' } as never;
    }),
  } as DependencyForgejo & { getIssue: ReturnType<typeof vi.fn> };
}

describe('runQueuedDependencyPass / dependencyGateAllows', () => {
  it('evaluates every queued task and the gate reflects the rows', async () => {
    seedRepo(1);
    const free = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const gated = insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });
    const forgejo = passStub({
      10: { body: 'no deps here' },
      11: { body: '## Dependencies\n- [ ] #5' },
      5: { state: 'open' },
    });
    const state = createDependencyPassState();

    await runQueuedDependencyPass(forgejo, log, state);

    expect(state.evaluatedTaskIds.has(free.id)).toBe(true);
    expect(state.evaluatedTaskIds.has(gated.id)).toBe(true);
    expect(dependencyGateAllows(free, state)).toBe(true);
    expect(dependencyGateAllows(gated, state)).toBe(false);
    expect(getTaskDependencies(gated.id)).toHaveLength(1);
  });

  it('skips non-queued tasks', async () => {
    seedRepo(1);
    const active = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    updateTask(active.id, { status: 'in-progress' });
    const forgejo = passStub({ 10: { body: '' } });
    const state = createDependencyPassState();

    await runQueuedDependencyPass(forgejo, log, state);
    expect(forgejo.getIssue).not.toHaveBeenCalled();
  });

  it('floors full passes but never floors a task it has not seen', async () => {
    seedRepo(1);
    const first = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = passStub({ 10: { body: '' }, 11: { body: '' } });
    const state = createDependencyPassState();
    const t0 = 1_000_000;

    await runQueuedDependencyPass(forgejo, log, state, { now: () => t0 });
    expect(forgejo.getIssue).toHaveBeenCalledTimes(1);

    // 5s later (inside the 15s floor): the standing task is skipped, but a
    // freshly-queued task is still evaluated.
    const fresh = insertTask({ issue_id: 11, repo_id: 1, status: 'queued' });
    await runQueuedDependencyPass(forgejo, log, state, {
      now: () => t0 + 5_000,
    });
    expect(forgejo.getIssue).toHaveBeenCalledTimes(2);
    expect(state.evaluatedTaskIds.has(fresh.id)).toBe(true);

    // Past the floor: everything is re-evaluated.
    await runQueuedDependencyPass(forgejo, log, state, {
      now: () => t0 + 20_000,
    });
    expect(
      forgejo.getIssue.mock.calls.filter(([, n]) => n === first.issue_id)
    ).toHaveLength(2);
  });

  it('a failed body fetch keeps the task gated and retries despite the floor', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const state = createDependencyPassState();
    const t0 = 1_000_000;

    await runQueuedDependencyPass(passStub({ 10: 500 }), log, state, {
      now: () => t0,
    });
    expect(state.evaluatedTaskIds.has(task.id)).toBe(false);
    expect(dependencyGateAllows(task, state)).toBe(false);

    // Forgejo recovers; even within the floor the unevaluated task retries.
    await runQueuedDependencyPass(passStub({ 10: { body: '' } }), log, state, {
      now: () => t0 + 1_000,
    });
    expect(state.evaluatedTaskIds.has(task.id)).toBe(true);
    expect(dependencyGateAllows(task, state)).toBe(true);
  });

  it('gate opens once a blocking dependency closes', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const state = createDependencyPassState();
    const body = '## Dependencies\n- [ ] #5';

    await runQueuedDependencyPass(
      passStub({ 10: { body }, 5: { state: 'open' } }),
      log,
      state,
      { now: () => 1_000_000 }
    );
    expect(dependencyGateAllows(task, state)).toBe(false);

    _clearDependencyCache();
    await runQueuedDependencyPass(
      passStub({ 10: { body }, 5: { state: 'closed' } }),
      log,
      state,
      { now: () => 2_000_000 }
    );
    expect(dependencyGateAllows(task, state)).toBe(true);
  });
});
