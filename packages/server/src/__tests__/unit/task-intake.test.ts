import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDatabase, getDb, getTask } from '../../db.js';
import {
  asPositiveInt,
  validateAgentProfileOverride,
  validateMaxAttemptsOverride,
  validateDependenciesInput,
  createTask,
  queueExistingIssue,
  listReposWithEffectiveProfile,
} from '../../services/task-intake.js';
import { ForgejoApiError } from '../../forgejo.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

/**
 * Unit tests for the task-intake service.
 *
 * The service is the single canonical task-creation path; both POST
 * /api/tasks and POST /api/tasks/queue route to it today, and the
 * forthcoming MCP `create_task` tool will too. These tests exercise
 * the service directly (no Fastify, no real Forgejo) so the validation
 * rules, override handling, label semantics, and broadcast/tick side
 * effects can never silently regress.
 *
 * Each test gets a fresh in-memory DB (seeded with the bootstrap
 * provider/model/profile rows by `initDatabase`) and a stubbed
 * ForgejoClient + scheduler.
 */

function insertRepo(opts: {
  owner?: string;
  name?: string;
  agent_profile_id?: string | null;
  review_agent_profile_id?: string | null;
} = {}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO repos (owner, name, base_branch, agent_profile_id, review_agent_profile_id, install_steps, allow_script_steps, container_memory_mb, container_cpu_cores, merge_strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.owner ?? 'acme',
      opts.name ?? 'frontend',
      'main',
      opts.agent_profile_id ?? null,
      opts.review_agent_profile_id ?? null,
      '[]',
      0,
      null,
      null,
      'squash'
    );
  return result.lastInsertRowid as number;
}

interface MockForgejo {
  createIssue: ReturnType<typeof vi.fn>;
  replaceLabelByNames: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  closeIssue: ReturnType<typeof vi.fn>;
}

function makeMocks(overrides: Partial<MockForgejo> = {}): {
  forgejo: ForgejoClient;
  scheduler: Pick<Scheduler, 'triggerTick'>;
  mocks: MockForgejo & { triggerTick: ReturnType<typeof vi.fn> };
} {
  const createIssue =
    overrides.createIssue ??
    vi.fn().mockResolvedValue({ number: 101, title: 'mock title' });
  const replaceLabelByNames =
    overrides.replaceLabelByNames ?? vi.fn().mockResolvedValue(undefined);
  const getIssue =
    overrides.getIssue ??
    vi.fn().mockResolvedValue({ number: 101, title: 'existing title' });
  const closeIssue =
    overrides.closeIssue ?? vi.fn().mockResolvedValue(undefined);
  const triggerTick = vi.fn();
  const forgejoStub = {
    createIssue,
    replaceLabelByNames,
    getIssue,
    closeIssue,
  } as unknown as ForgejoClient;
  return {
    forgejo: forgejoStub,
    scheduler: { triggerTick },
    mocks: { createIssue, replaceLabelByNames, getIssue, closeIssue, triggerTick },
  };
}

beforeEach(() => {
  initDatabase(':memory:');
});

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

describe('asPositiveInt', () => {
  it('accepts positive integers', () => {
    expect(asPositiveInt(1)).toBe(1);
    expect(asPositiveInt(42)).toBe(42);
  });

  it('accepts numeric strings', () => {
    expect(asPositiveInt('7')).toBe(7);
  });

  it('rejects zero, negative, fractional, NaN, and non-numeric', () => {
    expect(asPositiveInt(0)).toBeNull();
    expect(asPositiveInt(-3)).toBeNull();
    expect(asPositiveInt(1.5)).toBeNull();
    expect(asPositiveInt(NaN)).toBeNull();
    expect(asPositiveInt('abc')).toBeNull();
    expect(asPositiveInt('')).toBeNull();
    expect(asPositiveInt(undefined)).toBeNull();
    expect(asPositiveInt(null)).toBeNull();
    expect(asPositiveInt({})).toBeNull();
  });
});

describe('validateAgentProfileOverride', () => {
  it('treats undefined / null / empty string as no-override', () => {
    expect(validateAgentProfileOverride(undefined)).toEqual({ ok: true, value: null });
    expect(validateAgentProfileOverride(null)).toEqual({ ok: true, value: null });
    expect(validateAgentProfileOverride('')).toEqual({ ok: true, value: null });
    expect(validateAgentProfileOverride('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts a non-empty id that resolves through the lookup', () => {
    const r = validateAgentProfileOverride('default-claude-sdk', () => ({ id: 'default-claude-sdk' }));
    expect(r).toEqual({ ok: true, value: 'default-claude-sdk' });
  });

  it('rejects a non-existent id with a descriptive error', () => {
    const r = validateAgentProfileOverride('nope', () => undefined);
    expect(r).toEqual({ ok: false, error: 'Unknown agent_profile_id: nope' });
  });

  it('rejects wrong types', () => {
    expect(validateAgentProfileOverride(7)).toMatchObject({ ok: false });
    expect(validateAgentProfileOverride({})).toMatchObject({ ok: false });
    expect(validateAgentProfileOverride([])).toMatchObject({ ok: false });
  });

  it('names the supplied field in error messages (review override)', () => {
    expect(
      validateAgentProfileOverride('nope', () => undefined, 'review_agent_profile_id')
    ).toEqual({ ok: false, error: 'Unknown review_agent_profile_id: nope' });
    expect(
      validateAgentProfileOverride(7, () => undefined, 'review_agent_profile_id')
    ).toEqual({
      ok: false,
      error: 'review_agent_profile_id must be a string or null',
    });
  });
});

describe('validateMaxAttemptsOverride', () => {
  it('treats undefined / null as no-override (returns undefined)', () => {
    expect(validateMaxAttemptsOverride(undefined)).toEqual({ ok: true, value: undefined });
    expect(validateMaxAttemptsOverride(null)).toEqual({ ok: true, value: undefined });
  });

  it('accepts a positive integer', () => {
    expect(validateMaxAttemptsOverride(5)).toEqual({ ok: true, value: 5 });
  });

  it('rejects zero, negative, fractional, junk', () => {
    expect(validateMaxAttemptsOverride(0)).toMatchObject({ ok: false });
    expect(validateMaxAttemptsOverride(-1)).toMatchObject({ ok: false });
    expect(validateMaxAttemptsOverride(1.5)).toMatchObject({ ok: false });
    expect(validateMaxAttemptsOverride('foo')).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

describe('createTask', () => {
  it('rejects a body missing required fields with invalid + a clear message', async () => {
    const { forgejo, scheduler, mocks } = makeMocks();

    const r = await createTask({}, { forgejo, scheduler });

    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: /Required: repo_id, title, description/ },
    });
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it('rejects a non-integer repo_id', async () => {
    const { forgejo, scheduler } = makeMocks();
    const r = await createTask(
      { repo_id: 'not-a-number', title: 't', description: 'd' },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: /positive integer/ },
    });
  });

  it('returns not_found when the repo id does not resolve', async () => {
    const { forgejo, scheduler, mocks } = makeMocks();
    const r = await createTask(
      { repo_id: 9999, title: 't', description: 'd' },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'not_found', message: 'Repo not found' },
    });
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it('rejects non-string title or description', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks();

    const r = await createTask(
      { repo_id: repoId, title: 42, description: 'd' },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: /title and description must be strings/ },
    });
  });

  it('rejects an unknown agent_profile_id override', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks();
    const r = await createTask(
      {
        repo_id: repoId,
        title: 't',
        description: 'd',
        agent_profile_id: 'no-such-profile',
      },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: /Unknown agent_profile_id/ },
    });
  });

  it('rejects a non-positive max_attempts override', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks();
    const r = await createTask(
      { repo_id: repoId, title: 't', description: 'd', max_attempts: 0 },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: /max_attempts must be a positive integer/ },
    });
  });

  it('surfaces a Forgejo issue-creation failure as forgejo_failure', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks({
      createIssue: vi.fn().mockRejectedValue(new Error('upstream down')),
    });
    const r = await createTask(
      { repo_id: repoId, title: 't', description: 'd' },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'forgejo_failure', message: /upstream down/ },
    });
  });

  it('closes the orphaned Forgejo issue when the task-row insert fails', async () => {
    const repoId = insertRepo();
    // Pre-occupy (repoId, issue 77) so the intake's insert on the same
    // (repo_id, issue_id) pair trips the UNIQUE constraint — simulating any
    // post-issue-creation DB failure.
    getDb()
      .prepare(
        `INSERT INTO tasks (issue_id, repo_id, status) VALUES (77, ?, 'queued')`
      )
      .run(repoId);
    const { forgejo, scheduler, mocks } = makeMocks({
      createIssue: vi.fn().mockResolvedValue({ number: 77, title: 'dup' }),
    });

    const r = await createTask(
      { repo_id: repoId, title: 'dup', description: 'd' },
      { forgejo, scheduler }
    );

    // Surfaced as a failure rather than a phantom success.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('forgejo_failure');

    // The just-created Forgejo issue was closed so it can't orphan.
    expect(mocks.closeIssue).toHaveBeenCalledTimes(1);
    expect(mocks.closeIssue.mock.calls[0][1]).toBe(77);

    // No second task row leaked from the failed insert.
    const count = getDb()
      .prepare(
        'SELECT COUNT(*) AS n FROM tasks WHERE issue_id = 77 AND repo_id = ?'
      )
      .get(repoId) as { n: number };
    expect(count.n).toBe(1);

    // The failed insert didn't kick the scheduler.
    expect(mocks.triggerTick).not.toHaveBeenCalled();
  });

  it('two repos can hold a task for the same issue number without colliding', async () => {
    const repoA = insertRepo({ owner: 'a', name: 'repo-a' });
    const repoB = insertRepo({ owner: 'b', name: 'repo-b' });
    const { forgejo: forgejoA, scheduler: schedulerA } = makeMocks({
      createIssue: vi.fn().mockResolvedValue({ number: 5, title: 'shared #5' }),
    });
    const { forgejo: forgejoB, scheduler: schedulerB } = makeMocks({
      createIssue: vi.fn().mockResolvedValue({ number: 5, title: 'shared #5' }),
    });

    const ra = await createTask(
      { repo_id: repoA, title: 'shared #5', description: 'd' },
      { forgejo: forgejoA, scheduler: schedulerA }
    );
    const rb = await createTask(
      { repo_id: repoB, title: 'shared #5', description: 'd' },
      { forgejo: forgejoB, scheduler: schedulerB }
    );

    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(ra.value.task.issue_id).toBe(5);
    expect(rb.value.task.issue_id).toBe(5);
    expect(ra.value.task.repo_id).toBe(repoA);
    expect(rb.value.task.repo_id).toBe(repoB);
    expect(ra.value.task.id).not.toBe(rb.value.task.id);
  });

  it('happy path: creates issue, applies status/queued, inserts the task, kicks scheduler, returns issue + task', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler, mocks } = makeMocks({
      createIssue: vi.fn().mockResolvedValue({ number: 42, title: 'Add login validation' }),
    });

    const r = await createTask(
      { repo_id: repoId, title: 'Add login validation', description: 'do the thing' },
      { forgejo, scheduler }
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.issue).toEqual({ number: 42, title: 'Add login validation' });
    expect(r.value.task.issue_id).toBe(42);
    expect(r.value.task.repo_id).toBe(repoId);
    expect(r.value.task.status).toBe('queued');
    expect(r.value.task.issue_title).toBe('Add login validation');

    // Forgejo call shape
    expect(mocks.createIssue).toHaveBeenCalledTimes(1);
    expect(mocks.createIssue.mock.calls[0][1]).toEqual({
      title: 'Add login validation',
      body: 'do the thing',
    });

    // Only status/queued, no human-* (neither override set)
    expect(mocks.replaceLabelByNames).toHaveBeenCalledTimes(1);
    expect(mocks.replaceLabelByNames.mock.calls[0][2]).toEqual(['status/queued']);

    // Scheduler kicked
    expect(mocks.triggerTick).toHaveBeenCalledTimes(1);

    // Row really exists
    expect(getTask(r.value.task.id)?.issue_id).toBe(42);
  });

  it('adds human-merge / human-review labels when those options are set', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler, mocks } = makeMocks();

    const r = await createTask(
      {
        repo_id: repoId,
        title: 't',
        description: 'd',
        human_merge: true,
        human_review: true,
      },
      { forgejo, scheduler }
    );

    expect(r.ok).toBe(true);
    expect(mocks.replaceLabelByNames.mock.calls[0][2]).toEqual([
      'status/queued',
      'human-merge',
      'human-review',
    ]);
  });

  it('label-application failure is best-effort — the task is still inserted', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler, mocks } = makeMocks({
      replaceLabelByNames: vi.fn().mockRejectedValue(new Error('label api down')),
    });

    const r = await createTask(
      { repo_id: repoId, title: 't', description: 'd' },
      { forgejo, scheduler }
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Row is in the DB; scheduler still kicked.
    expect(getTask(r.value.task.id)?.status).toBe('queued');
    expect(mocks.triggerTick).toHaveBeenCalledTimes(1);
  });

  it('persists the agent_profile_id and max_attempts overrides on the inserted row', async () => {
    // Seed an authentic profile (the bootstrap already seeded several;
    // pick the default).
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks();

    const r = await createTask(
      {
        repo_id: repoId,
        title: 't',
        description: 'd',
        agent_profile_id: 'default-claude-sdk',
        max_attempts: 3,
      },
      { forgejo, scheduler }
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const persisted = getTask(r.value.task.id)!;
    expect(persisted.agent_profile_id).toBe('default-claude-sdk');
    expect(persisted.max_attempts).toBe(3);
  });

  it('persists the review_agent_profile_id override on the inserted row', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks();

    const r = await createTask(
      {
        repo_id: repoId,
        title: 't',
        description: 'd',
        agent_profile_id: 'default-claude-sdk',
        review_agent_profile_id: 'default-claude-code-subscription',
      },
      { forgejo, scheduler }
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const persisted = getTask(r.value.task.id)!;
    expect(persisted.agent_profile_id).toBe('default-claude-sdk');
    expect(persisted.review_agent_profile_id).toBe(
      'default-claude-code-subscription'
    );
  });

  it('rejects an unknown review_agent_profile_id naming the field', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler, mocks } = makeMocks();

    const r = await createTask(
      {
        repo_id: repoId,
        title: 't',
        description: 'd',
        review_agent_profile_id: 'no-such-profile',
      },
      { forgejo, scheduler }
    );

    expect(r).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid',
        message: 'Unknown review_agent_profile_id: no-such-profile',
      },
    });
    // Validation failure happens before the Forgejo issue is created.
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// queueExistingIssue
// ---------------------------------------------------------------------------

describe('queueExistingIssue', () => {
  it('rejects a body missing required fields', async () => {
    const { forgejo, scheduler } = makeMocks();
    const r = await queueExistingIssue({}, { forgejo, scheduler });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: /Required: issue_id, repo_id/ },
    });
  });

  it('returns not_found when the repo id does not resolve', async () => {
    const { forgejo, scheduler } = makeMocks();
    const r = await queueExistingIssue(
      { repo_id: 9999, issue_id: 1 },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    });
  });

  it('rejects a non-integer issue_id', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks();
    const r = await queueExistingIssue(
      { repo_id: repoId, issue_id: 'nope' },
      { forgejo, scheduler }
    );
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid', message: /issue_id must be a positive integer/ },
    });
  });

  it('happy path: fetches title, applies labels, inserts row', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler, mocks } = makeMocks({
      getIssue: vi.fn().mockResolvedValue({ number: 11, title: 'Pre-existing issue' }),
    });

    const r = await queueExistingIssue(
      { repo_id: repoId, issue_id: 11 },
      { forgejo, scheduler }
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.task.issue_id).toBe(11);
    expect(r.value.task.issue_title).toBe('Pre-existing issue');
    expect(mocks.getIssue).toHaveBeenCalledTimes(1);
    expect(mocks.replaceLabelByNames).toHaveBeenCalledTimes(1);
    expect(mocks.triggerTick).toHaveBeenCalledTimes(1);
  });

  it("title fetch failure is non-fatal — task is inserted with null title (caller renders 'Issue #N')", async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks({
      getIssue: vi.fn().mockRejectedValue(new Error('404')),
    });

    const r = await queueExistingIssue(
      { repo_id: repoId, issue_id: 11 },
      { forgejo, scheduler }
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.task.issue_id).toBe(11);
    expect(r.value.task.issue_title).toBeNull();
    // The service still reports a synthetic title in the returned issue
    // shape so callers can render something useful straight away.
    expect(r.value.issue.title).toBe('Issue #11');
  });
});

// ---------------------------------------------------------------------------
// Dependencies through intake
// ---------------------------------------------------------------------------

describe('validateDependenciesInput', () => {
  it('treats missing/null as empty', () => {
    expect(validateDependenciesInput(undefined)).toEqual({ ok: true, value: [] });
    expect(validateDependenciesInput(null)).toEqual({ ok: true, value: [] });
  });

  it('accepts arrays of positive integers (and numeric strings)', () => {
    expect(validateDependenciesInput([5, '6'])).toEqual({
      ok: true,
      value: [5, 6],
    });
  });

  it('rejects non-arrays and bad members', () => {
    expect(validateDependenciesInput(5).ok).toBe(false);
    expect(validateDependenciesInput(['x']).ok).toBe(false);
    expect(validateDependenciesInput([0]).ok).toBe(false);
    expect(validateDependenciesInput([1.5]).ok).toBe(false);
  });
});

describe('createTask with dependencies', () => {
  it('writes the canonical section into the created issue body', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler, mocks } = makeMocks({
      getIssue: vi.fn().mockResolvedValue({ state: 'open' }),
    });

    const result = await createTask(
      {
        repo_id: repoId,
        title: 'T',
        description: 'Do the thing.',
        dependencies: [5, 6],
      },
      { forgejo, scheduler }
    );

    expect(result.ok).toBe(true);
    const body = mocks.createIssue.mock.calls[0][1].body as string;
    expect(body).toContain('Do the thing.');
    expect(body).toContain('## Dependencies');
    expect(body).toContain('- [ ] #5');
    expect(body).toContain('- [ ] #6');
  });

  it('leaves the body untouched when no dependencies are given', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler, mocks } = makeMocks();

    await createTask(
      { repo_id: repoId, title: 'T', description: 'Plain.' },
      { forgejo, scheduler }
    );
    expect(mocks.createIssue.mock.calls[0][1].body).toBe('Plain.');
    expect(mocks.getIssue).not.toHaveBeenCalled();
  });

  it('accepts already-closed dependencies (satisfied from the start)', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks({
      getIssue: vi.fn().mockResolvedValue({ state: 'closed' }),
    });

    const result = await createTask(
      { repo_id: repoId, title: 'T', description: 'D', dependencies: [5] },
      { forgejo, scheduler }
    );
    expect(result.ok).toBe(true);
  });

  it('rejects nonexistent dependency issues, fail-closed on fetch errors', async () => {
    const repoId = insertRepo();
    const notFound = makeMocks({
      getIssue: vi.fn().mockRejectedValue(new ForgejoApiError('nf', 404, '')),
    });

    let result = await createTask(
      { repo_id: repoId, title: 'T', description: 'D', dependencies: [99] },
      { forgejo: notFound.forgejo, scheduler: notFound.scheduler }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'invalid' },
    });
    expect(notFound.mocks.createIssue).not.toHaveBeenCalled();

    const flaky = makeMocks({
      getIssue: vi.fn().mockRejectedValue(new ForgejoApiError('boom', 500, '')),
    });
    result = await createTask(
      { repo_id: repoId, title: 'T', description: 'D', dependencies: [5] },
      { forgejo: flaky.forgejo, scheduler: flaky.scheduler }
    );
    expect(result.ok).toBe(false);
  });

  it('rejects malformed dependency input', async () => {
    const repoId = insertRepo();
    const { forgejo, scheduler } = makeMocks();
    const result = await createTask(
      {
        repo_id: repoId,
        title: 'T',
        description: 'D',
        dependencies: 'nope',
      },
      { forgejo, scheduler }
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });
});

describe('queueExistingIssue with dependencies', () => {
  function queueMocks(opts: { issueBody?: string; depState?: string } = {}) {
    const updateIssueBody = vi.fn().mockResolvedValue(undefined);
    const getIssue = vi.fn(async (_repo: unknown, n: number) => {
      if (n === 101) {
        return { number: 101, title: 'existing title', body: opts.issueBody ?? 'Original body.' };
      }
      return { number: n, title: `dep ${n}`, state: opts.depState ?? 'open' };
    });
    const base = makeMocks({ getIssue });
    (base.forgejo as unknown as Record<string, unknown>).updateIssueBody =
      updateIssueBody;
    return { ...base, updateIssueBody };
  }

  it('unions the section into the existing issue body on Forgejo', async () => {
    const repoId = insertRepo();
    const m = queueMocks({ issueBody: 'Original body.' });

    const result = await queueExistingIssue(
      { repo_id: repoId, issue_id: 101, dependencies: [5] },
      { forgejo: m.forgejo, scheduler: m.scheduler }
    );

    expect(result.ok).toBe(true);
    expect(m.updateIssueBody).toHaveBeenCalledTimes(1);
    const written = m.updateIssueBody.mock.calls[0][2] as string;
    expect(written).toContain('Original body.');
    expect(written).toContain('## Dependencies');
    expect(written).toContain('- [ ] #5');
  });

  it('does not rewrite the body when the deps are already listed', async () => {
    const repoId = insertRepo();
    const m = queueMocks({
      issueBody: 'Body\n\n## Dependencies\n- [ ] #5\n',
    });

    const result = await queueExistingIssue(
      { repo_id: repoId, issue_id: 101, dependencies: [5] },
      { forgejo: m.forgejo, scheduler: m.scheduler }
    );
    expect(result.ok).toBe(true);
    expect(m.updateIssueBody).not.toHaveBeenCalled();
  });

  it('rejects a self-dependency', async () => {
    const repoId = insertRepo();
    const m = queueMocks();
    const result = await queueExistingIssue(
      { repo_id: repoId, issue_id: 101, dependencies: [101] },
      { forgejo: m.forgejo, scheduler: m.scheduler }
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(m.updateIssueBody).not.toHaveBeenCalled();
  });

  it('fails when dependencies are requested but the issue cannot be fetched', async () => {
    const repoId = insertRepo();
    const m = makeMocks({
      getIssue: vi.fn().mockRejectedValue(new Error('down')),
    });
    const result = await queueExistingIssue(
      { repo_id: repoId, issue_id: 101, dependencies: [5] },
      { forgejo: m.forgejo, scheduler: m.scheduler }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'forgejo_failure' },
    });
  });

  it('fails when the body write fails', async () => {
    const repoId = insertRepo();
    const m = queueMocks();
    m.updateIssueBody.mockRejectedValue(new Error('write failed'));
    const result = await queueExistingIssue(
      { repo_id: repoId, issue_id: 101, dependencies: [5] },
      { forgejo: m.forgejo, scheduler: m.scheduler }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'forgejo_failure' },
    });
    expect(getTask(1)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listReposWithEffectiveProfile
// ---------------------------------------------------------------------------

describe('listReposWithEffectiveProfile', () => {
  it("uses the repo's own override when set, source = 'repo'", () => {
    insertRepo({ owner: 'acme', name: 'a', agent_profile_id: 'default-claude-sdk' });

    const rows = listReposWithEffectiveProfile();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner: 'acme',
      name: 'a',
      repo_agent_profile_id: 'default-claude-sdk',
      effective_agent_profile_id: 'default-claude-sdk',
      agent_profile_source: 'repo',
    });
    expect(rows[0].effective_profile?.id).toBe('default-claude-sdk');
    // Joined-through metadata is present.
    expect(rows[0].effective_profile?.harness_id).toBe('claude-sdk');
    expect(rows[0].effective_profile?.provider_id).toBe('anthropic');
    expect(rows[0].effective_profile?.model_id).toBe('claude-sonnet-4-6');
  });

  it("falls back to the global default when the repo has no override, source = 'global'", () => {
    insertRepo({ owner: 'acme', name: 'b', agent_profile_id: null });

    const rows = listReposWithEffectiveProfile();
    expect(rows).toHaveLength(1);
    // Bootstrap seeds default_agent_profile_id = 'default-claude-sdk'.
    expect(rows[0]).toMatchObject({
      repo_agent_profile_id: null,
      effective_agent_profile_id: 'default-claude-sdk',
      agent_profile_source: 'global',
    });
  });

  it("reports source = 'none' when neither the repo nor the global default is set", () => {
    // Clear the global default seeded by bootstrap.
    getDb()
      .prepare("DELETE FROM settings WHERE key = 'default_agent_profile_id'")
      .run();
    insertRepo({ owner: 'acme', name: 'c', agent_profile_id: null });

    const rows = listReposWithEffectiveProfile();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      effective_agent_profile_id: null,
      agent_profile_source: 'none',
      effective_profile: null,
    });
  });

  it('falls back gracefully when the resolved profile id points at a deleted profile (effective_profile = null)', () => {
    // Point settings.default_agent_profile_id at a profile id that
    // doesn't exist. The settings row is a plain key/value with no FK
    // (unlike `repos.agent_profile_id`, which is RESTRICT-FK'd), so
    // this dangling-pointer state is reachable via the normal
    // `updateSetting` path — and the listing must not blow up on it.
    // Resolution still returns the id, but `effective_profile` is null.
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('default_agent_profile_id', 'ghost-profile-id')"
      )
      .run();
    insertRepo({ owner: 'acme', name: 'd', agent_profile_id: null });

    const rows = listReposWithEffectiveProfile().filter((r) => r.name === 'd');
    expect(rows).toHaveLength(1);
    expect(rows[0].effective_agent_profile_id).toBe('ghost-profile-id');
    expect(rows[0].agent_profile_source).toBe('global');
    expect(rows[0].effective_profile).toBeNull();
  });

  it("review: uses the repo's review override when set, source = 'repo'", () => {
    insertRepo({
      owner: 'acme',
      name: 'e',
      review_agent_profile_id: 'default-claude-code-subscription',
    });

    const rows = listReposWithEffectiveProfile();
    expect(rows[0]).toMatchObject({
      repo_review_agent_profile_id: 'default-claude-code-subscription',
      effective_review_agent_profile_id: 'default-claude-code-subscription',
      review_agent_profile_source: 'repo',
    });
    expect(rows[0].effective_review_profile?.harness_id).toBe('claude-code');
  });

  it("review: falls back to the global review default, source = 'global'", () => {
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('default_review_agent_profile_id', 'default-claude-code-subscription')"
      )
      .run();
    insertRepo({ owner: 'acme', name: 'f' });

    const rows = listReposWithEffectiveProfile();
    expect(rows[0]).toMatchObject({
      repo_review_agent_profile_id: null,
      effective_review_agent_profile_id: 'default-claude-code-subscription',
      review_agent_profile_source: 'global',
    });
  });

  it("review: falls back to the implementation profile when no review tier is set, source = 'implementation'", () => {
    insertRepo({ owner: 'acme', name: 'g' });

    const rows = listReposWithEffectiveProfile();
    // Implementation resolves to the seeded global default; review
    // inherits it.
    expect(rows[0]).toMatchObject({
      effective_agent_profile_id: 'default-claude-sdk',
      effective_review_agent_profile_id: 'default-claude-sdk',
      review_agent_profile_source: 'implementation',
    });
    expect(rows[0].effective_review_profile?.id).toBe('default-claude-sdk');
  });

  it("review: source = 'none' when nothing resolves anywhere", () => {
    getDb()
      .prepare("DELETE FROM settings WHERE key = 'default_agent_profile_id'")
      .run();
    insertRepo({ owner: 'acme', name: 'h' });

    const rows = listReposWithEffectiveProfile();
    expect(rows[0]).toMatchObject({
      effective_review_agent_profile_id: null,
      review_agent_profile_source: 'none',
      effective_review_profile: null,
    });
  });
});
