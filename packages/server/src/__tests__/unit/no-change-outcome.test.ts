import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Task, Repo } from '@orchestrator/shared';
import {
  validateNoChangeClaim,
  parseNoChangeClaim,
  TERMINAL_STATUSES,
} from '@orchestrator/shared';
import {
  initDatabase,
  getDb,
  getTask,
  getTaskEvents,
  insertAttempt,
  updateAttempt,
  getReviewFeedbackHistory,
} from '../../db.js';
import {
  processReviewVerdict,
  normalizeNoChangeVerdict,
} from '../../agents/review.js';
import { readNoChangeClaim, clearNoChangeFile } from '../../agents/no-change.js';
import { finalizeNoChange } from '../../actions.js';
import { createTaskRoutes } from '../../routes/tasks.js';
import { deriveStatus } from '../../status-derivation.js';
import { buildDevPrompt, buildReviewPrompt } from '../../scheduler.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';
import type { Snapshot } from '../../forgejo-snapshot.js';

/**
 * #223 — a dev agent may conclude that no code change is required and say so
 * in /output/no-change.json. These tests cover the orchestrator side of that
 * outcome end to end against a real in-memory DB: the claim's validation,
 * the review agent's no-change verdicts, the human Accept/Reject actions, the
 * finalise step, and status derivation of the resulting closed issue.
 */

const CLAIM = {
  category: 'already_fixed',
  reason: 'Fixed on main by abc123 (PR #7)',
  evidence: ['git show abc123', 'src/x.ts:12 already guards null'],
  attempt: 1,
} as const;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** Fake Forgejo that records every call, with the issue's labels settable. */
function makeForgejo(labels: string[] = []) {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec =
    (name: string, ret?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return ret;
    };
  const client = {
    getIssue: async () => ({
      title: 'Issue',
      body: 'Do the thing',
      labels: labels.map((name, i) => ({ id: i + 1, name })),
    }),
    getPullRequest: rec('getPullRequest', { changed_files: 0, additions: 0, deletions: 0 }),
    commentOnIssue: rec('commentOnIssue'),
    commentOnPr: rec('commentOnPr'),
    deleteBranch: rec('deleteBranch'),
    closePullRequest: rec('closePullRequest'),
    replaceLabelByNames: rec('replaceLabelByNames'),
    closeIssue: rec('closeIssue'),
  } as unknown as ForgejoClient;
  const named = (n: string) => calls.filter((c) => c[0] === n);
  return { client, calls, named };
}

function seedTask(overrides: Record<string, unknown> = {}): Task {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
  const row = {
    status: 'in-review',
    branch_name: 'agent/issue-100-x',
    pr_number: null,
    attempt: 1,
    max_attempts: 3,
    no_change_claim: JSON.stringify(CLAIM),
    completed_at: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, branch_name, pr_number, attempt, max_attempts, no_change_claim, completed_at)
     VALUES (1, 100, 1, @status, @branch_name, @pr_number, @attempt, @max_attempts, @no_change_claim, @completed_at)`
  ).run(row);
  return getTask(1)!;
}

const eventTypes = () => getTaskEvents(1).map((e) => e.event_type);

beforeEach(() => {
  initDatabase(':memory:');
});

// ---------------------------------------------------------------------------
// Claim file
// ---------------------------------------------------------------------------

describe('no-change.json validation', () => {
  it('accepts a well-formed, evidenced claim and stamps the attempt', () => {
    const { attempt: _a, ...file } = CLAIM;
    expect(validateNoChangeClaim(file, 3)).toEqual({ ...file, attempt: 3 });
  });

  it.each([
    ['unknown category', { ...CLAIM, category: 'gave_up' }],
    ['empty reason', { ...CLAIM, reason: '  ' }],
    ['no evidence', { ...CLAIM, evidence: [] }],
    ['evidence not an array', { ...CLAIM, evidence: 'trust me' }],
    ['blank evidence only', { ...CLAIM, evidence: ['', '  '] }],
    ['not an object', ['already_fixed']],
  ])('rejects %s', (_label, raw) => {
    expect(validateNoChangeClaim(raw, 1)).toBeNull();
  });

  it('parseNoChangeClaim round-trips the stored column and tolerates junk', () => {
    expect(parseNoChangeClaim(JSON.stringify(CLAIM))).toEqual(CLAIM);
    expect(parseNoChangeClaim(null)).toBeNull();
    expect(parseNoChangeClaim('{oops')).toBeNull();
  });

  describe('readNoChangeClaim / clearNoChangeFile', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-read-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    // getOutputDir is stubbed to `dir`; only `attempt` matters here.
    const t = { repo_id: 1, issue_id: 1, attempt: 2 } as Task;

    it('reads none / invalid / valid, and clearing removes the file', async () => {
      const ws = await import('../../workspace.js');
      const spy = vi.spyOn(ws, 'getOutputDir').mockReturnValue(dir);
      try {
        expect(await readNoChangeClaim(t)).toEqual({ kind: 'none' });

        fs.writeFileSync(path.join(dir, 'no-change.json'), '{"category":"x"}');
        expect((await readNoChangeClaim(t)).kind).toBe('invalid');

        const { attempt: _a, ...file } = CLAIM;
        fs.writeFileSync(path.join(dir, 'no-change.json'), JSON.stringify(file));
        expect(await readNoChangeClaim(t)).toEqual({
          kind: 'valid',
          claim: { ...file, attempt: 2 },
        });

        await clearNoChangeFile(t);
        expect(fs.existsSync(path.join(dir, 'no-change.json'))).toBe(false);
        await clearNoChangeFile(t); // missing file is fine
      } finally {
        spy.mockRestore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Review agent verdicts in no-change mode
// ---------------------------------------------------------------------------

function review(
  task: Task,
  forgejo: ForgejoClient,
  verdict: Record<string, unknown>,
  launchDev = vi.fn(async () => {})
) {
  return processReviewVerdict(
    task,
    verdict as never,
    undefined,
    0,
    forgejo,
    noopLog,
    launchDev,
    async () => {}
  );
}

describe('processReviewVerdict — no-change review mode', () => {
  it('confirmed → no-change: issue closed with status/no-change, other labels kept, branch deleted, PR closed, slot freed', async () => {
    const task = seedTask({ pr_number: 42 });
    const { client, named } = makeForgejo(['status/in-review', 'ci-failure', 'human-merge']);

    await review(task, client, {
      verdict: 'no_change_confirmed',
      summary: 'abc123 on main already fixes it',
    });

    const fresh = getTask(1)!;
    expect(fresh.status).toBe('no-change');
    expect(fresh.completed_at).not.toBeNull();
    expect(fresh.container_id).toBeNull();
    expect(TERMINAL_STATUSES.has(fresh.status)).toBe(true); // frees the slot

    expect(named('deleteBranch')[0][2]).toBe('agent/issue-100-x');
    expect(named('closePullRequest')[0][2]).toBe(42);
    expect(named('closeIssue')).toHaveLength(1);
    // Label swap keeps every non-status label (incl. human-merge).
    const labelWrites = named('replaceLabelByNames').map((c) => c[3] as string[]);
    expect(labelWrites.at(-1)).toEqual(['status/no-change', 'ci-failure', 'human-merge']);

    const comments = named('commentOnIssue').map((c) => c[3] as string);
    expect(comments.some((c) => c.includes('confirmed by review agent') && c.includes('abc123 on main'))).toBe(true);
    expect(eventTypes()).toEqual(
      expect.arrayContaining(['review_verdict', 'no_change_confirmed', 'status_no-change'])
    );
  });

  it('confirmed on a human-merge task → still no-change, never awaiting-human-merge', async () => {
    const task = seedTask();
    const { client } = makeForgejo(['human-merge']);
    await review(task, client, { verdict: 'no_change_confirmed', summary: 'done already' });
    expect(getTask(1)!.status).toBe('no-change');
    expect(eventTypes()).not.toContain('status_awaiting-human-merge');
  });

  it('rejected → like changes_needed: attempt++, claim cleared, rework prompt carries the feedback', async () => {
    const task = seedTask();
    const { client, named } = makeForgejo();
    const launchDev = vi.fn(async () => {});

    await review(
      task,
      client,
      {
        verdict: 'no_change_rejected',
        summary: 'abc123 fixed the API but not the CLI path',
        feedback: [
          {
            file: 'src/cli.ts',
            line: 9,
            category: 'requirements',
            severity: 'blocker',
            comment: 'CLI still crashes on null',
            suggestion: 'Guard the null in parseArgs',
          },
        ],
      },
      launchDev
    );

    const fresh = getTask(1)!;
    expect(fresh.status).toBe('changes-needed');
    expect(fresh.attempt).toBe(2);
    expect(fresh.no_change_claim).toBeNull();
    expect(launchDev).toHaveBeenCalledTimes(1);
    const feedback = (launchDev.mock.calls[0] as unknown[])[1] as string;
    expect(feedback).toContain('No-change claim rejected');
    expect(feedback).toContain('CLI still crashes on null');
    expect(feedback).toContain('Guard the null in parseArgs');
    expect(
      named('commentOnIssue').some((c) => (c[3] as string).startsWith('Review rejected the no-change claim'))
    ).toBe(true);
    // The rejected claim's dev attempt chain resumes in the same slot.
    expect(named('closeIssue')).toHaveLength(0);
  });

  it('rejected with attempts exhausted → failed', async () => {
    const task = seedTask({ attempt: 3, max_attempts: 3 });
    const { client } = makeForgejo();
    const launchDev = vi.fn(async () => {});
    await review(task, client, { verdict: 'no_change_rejected', summary: 'nope' }, launchDev);
    expect(getTask(1)!.status).toBe('failed');
    expect(getTask(1)!.no_change_claim).toBeNull();
    expect(launchDev).not.toHaveBeenCalled();
  });

  it('unclear → needs-human-review with the claim kept for a human decision', async () => {
    const task = seedTask();
    const { client } = makeForgejo();
    await review(task, client, { verdict: 'unclear', summary: 'cannot tell' });
    const fresh = getTask(1)!;
    expect(fresh.status).toBe('needs-human-review');
    expect(parseNoChangeClaim(fresh.no_change_claim)).toEqual(CLAIM);
  });

  it('a later rework attempt still sees the rejected claim in its cumulative feedback', async () => {
    seedTask();
    const a = insertAttempt({ task_id: 1, attempt_number: 1, role: 'review', status: 'running' });
    updateAttempt(a.id, {
      status: 'completed',
      verdict: 'no_change_rejected',
      feedback: JSON.stringify('CLI still crashes'),
    });
    expect(getReviewFeedbackHistory(1)).toHaveLength(1);
  });

  it('normalizes LLM verdict aliases', () => {
    expect(normalizeNoChangeVerdict('approved')).toBe('no_change_confirmed');
    expect(normalizeNoChangeVerdict('changes_needed')).toBe('no_change_rejected');
    expect(normalizeNoChangeVerdict('maybe')).toBe('unclear');
  });
});

// ---------------------------------------------------------------------------
// Finalise
// ---------------------------------------------------------------------------

describe('finalizeNoChange', () => {
  it('writes the terminal status before closing the issue', async () => {
    const task = seedTask();
    const order: string[] = [];
    const { client } = makeForgejo();
    (client as unknown as Record<string, unknown>).closeIssue = async () => {
      order.push(`closeIssue while ${getTask(1)!.status}`);
    };
    const onFreed = vi.fn();
    await finalizeNoChange(task, client, noopLog, { confirmedBy: 'human reviewer', reason: 'dup of #5' }, onFreed);
    // The issues.closed webhook must see a terminal task, not cancel it.
    expect(order).toEqual(['closeIssue while no-change']);
    expect(onFreed).toHaveBeenCalledTimes(1);
  });

  it('works without a branch or PR', async () => {
    const task = seedTask({ branch_name: null, pr_number: null });
    const { client, named } = makeForgejo();
    await finalizeNoChange(task, client, noopLog, { confirmedBy: 'review agent', reason: 'obsolete' });
    expect(named('deleteBranch')).toHaveLength(0);
    expect(named('closePullRequest')).toHaveLength(0);
    expect(getTask(1)!.status).toBe('no-change');
  });
});

// ---------------------------------------------------------------------------
// Human Accept / Reject (PATCH /api/tasks/:id)
// ---------------------------------------------------------------------------

describe('PATCH /api/tasks/:id — accept_no_change / reject_no_change', () => {
  let app: FastifyInstance;
  let launchDevContainer: ReturnType<typeof vi.fn>;
  let fj: ReturnType<typeof makeForgejo>;

  async function build(): Promise<void> {
    fj = makeForgejo(['human-review', 'status/awaiting-human-review']);
    launchDevContainer = vi.fn(async () => {});
    const scheduler = { triggerTick: vi.fn(), launchDevContainer } as unknown as Scheduler;
    app = Fastify({ logger: false });
    await app.register(createTaskRoutes(fj.client, scheduler));
    await app.ready();
  }

  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/tasks/1', payload });

  it('Accept → no-change, issue closed, labels kept', async () => {
    seedTask({ status: 'awaiting-human-review', completed_at: '2026-10-01T00:00:00Z' });
    await build();

    const res = await patch({ action: 'accept_no_change' });

    expect(res.statusCode).toBe(200);
    expect(getTask(1)!.status).toBe('no-change');
    expect(fj.named('closeIssue')).toHaveLength(1);
    expect(fj.named('replaceLabelByNames').at(-1)![3]).toEqual(['status/no-change', 'human-review']);
    expect(
      fj.named('commentOnIssue').some((c) => (c[3] as string).includes('confirmed by human reviewer'))
    ).toBe(true);
    expect(launchDevContainer).not.toHaveBeenCalled();
  });

  it('Reject requires a comment', async () => {
    seedTask({ status: 'awaiting-human-review' });
    await build();
    const res = await patch({ action: 'reject_no_change', comment: '  ' });
    expect(res.statusCode).toBe(400);
    expect(getTask(1)!.status).toBe('awaiting-human-review');
  });

  it('Reject with a comment → rework attempt carrying that comment', async () => {
    seedTask({ status: 'awaiting-human-review', completed_at: '2026-10-01T00:00:00Z' });
    await build();

    const res = await patch({
      action: 'reject_no_change',
      comment: 'abc123 only fixed staging; prod config still broken',
    });

    expect(res.statusCode).toBe(200);
    const fresh = getTask(1)!;
    expect(fresh.status).toBe('changes-needed');
    expect(fresh.attempt).toBe(2);
    expect(fresh.no_change_claim).toBeNull();
    expect(fresh.completed_at).toBeNull();
    expect(launchDevContainer).toHaveBeenCalledTimes(1);
    expect(launchDevContainer.mock.calls[0][1]).toContain(
      'abc123 only fixed staging; prod config still broken'
    );
    expect(eventTypes()).toContain('no_change_rejected');
  });

  it('is refused without a pending claim, or outside a human-decision status', async () => {
    seedTask({ status: 'awaiting-human-review', no_change_claim: null });
    await build();
    expect((await patch({ action: 'accept_no_change' })).statusCode).toBe(400);

    getDb().prepare(`UPDATE tasks SET status = 'in-review', no_change_claim = ? WHERE id = 1`).run(JSON.stringify(CLAIM));
    expect((await patch({ action: 'accept_no_change' })).statusCode).toBe(400);
    // Nor can a no-change review be force-approved into a merge.
    expect((await patch({ action: 'force_approve' })).statusCode).toBe(400);
  });

  it('a no-change task can be reset but not closed', async () => {
    seedTask({ status: 'no-change' });
    await build();
    expect((await patch({ action: 'close' })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

describe('deriveStatus — no-change', () => {
  const mk = (overrides: Partial<Task>): Task =>
    ({ id: 1, status: 'failed', no_change_claim: null, ...overrides }) as Task;
  const snap = (issue: Partial<Snapshot['issue']>, pr: Snapshot['pr'] = null): Snapshot =>
    ({ issue: { state: 'open', labels: [], ...issue }, pr, fetchedAt: 0 }) as unknown as Snapshot;

  it('closed issue labelled status/no-change derives to no-change, not cancelled', () => {
    const r = deriveStatus(mk({ status: 'in-review' }), snap({ state: 'closed', labels: ['status/no-change'] }));
    expect(r.status).toBe('no-change');
  });

  it('stored no-change + closed issue stays no-change while the label write is in flight', () => {
    const r = deriveStatus(mk({ status: 'no-change' }), snap({ state: 'closed', labels: ['status/in-review'] }));
    expect(r.status).toBe('no-change');
  });

  it('a closed issue without the label is still cancelled', () => {
    const r = deriveStatus(mk({ status: 'failed' }), snap({ state: 'closed', labels: ['status/failed'] }));
    expect(r.status).toBe('cancelled');
  });

  it('a PR-less claim awaiting human review stays awaiting-human-review', () => {
    const r = deriveStatus(
      mk({ status: 'awaiting-human-review', no_change_claim: JSON.stringify(CLAIM) }),
      snap({ labels: ['human-review', 'human-merge'] })
    );
    expect(r.status).toBe('awaiting-human-review');
  });

  it('a claim under review with an empty PR is not relabelled by human-merge', () => {
    const r = deriveStatus(
      mk({ status: 'in-review', no_change_claim: JSON.stringify(CLAIM) }),
      snap({ labels: ['human-merge'] }, { number: 42, state: 'open', merged: false } as Snapshot['pr'])
    );
    expect(r.status).toBe('in-review');
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('prompts', () => {
  const repo = { owner: 'o', name: 'r', base_branch: 'main' } as Repo;
  const issue = { title: 'T', body: 'Fix the null crash' };
  const task = (claim: string | null = null) =>
    ({ attempt: 2, branch_name: 'agent/issue-1-x', no_change_claim: claim }) as Task;

  it('dev prompt offers the no-change exit on first and rework attempts', () => {
    for (const fb of [null, 'Missing null check']) {
      const p = buildDevPrompt(task(), repo, issue, fb);
      expect(p).toContain('/output/no-change.json');
      expect(p).toContain('"already_fixed" | "duplicate" | "not_reproducible" | "obsolete"');
      expect(p).toContain('do NOT make an empty');
      expect(p).toContain('It is not a way to give up');
    }
  });

  it('review prompt switches to no-change mode when a claim is pending', () => {
    const normal = buildReviewPrompt(task(), repo, issue);
    expect(normal).toContain('Review Rubric');
    expect(normal).not.toContain('no_change_confirmed');

    const nc = buildReviewPrompt(task(JSON.stringify(CLAIM)), repo, issue);
    expect(nc).toContain('No-change claim');
    expect(nc).toContain('Fix the null crash'); // original task
    expect(nc).toContain('Fixed on main by abc123 (PR #7)'); // the claim
    expect(nc).toContain('src/x.ts:12 already guards null'); // its evidence
    expect(nc).toContain('origin/main');
    expect(nc).toContain('"no_change_confirmed" | "no_change_rejected" | "unclear"');
  });
});

describe('deriveStatus — stale claim outside review', () => {
  it('a leftover claim on a non-review status does not mask driver labels', () => {
    const task = {
      id: 1,
      status: 'failed',
      no_change_claim: JSON.stringify(CLAIM),
    } as Task;
    const snapshot = {
      issue: { state: 'open', labels: ['human-merge'] },
      pr: { number: 42, state: 'open', merged: false },
      fetchedAt: 0,
    } as unknown as Snapshot;
    expect(deriveStatus(task, snapshot).status).toBe('awaiting-human-merge');
  });
});
