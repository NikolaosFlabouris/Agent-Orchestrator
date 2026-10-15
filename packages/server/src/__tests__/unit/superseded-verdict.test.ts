import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task, Repo } from '@orchestrator/shared';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { initDatabase, getDb, getTask, getTaskEvents } from '../../db.js';
import {
  processReviewVerdict,
  parseSupersededEvidence,
  findUnaccountedFiles,
} from '../../agents/review.js';
import { buildReviewPrompt } from '../../scheduler.js';
import type { ForgejoClient } from '../../forgejo.js';

/**
 * #224 — a normal PR review may conclude that the base branch has since made
 * the PR redundant (`no_change_superseded`). With evidence that accounts for
 * every file the PR still changes, the task ends as no-change; otherwise the
 * verdict is treated as unclear and nothing is deleted.
 */

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never;

const EVIDENCE = [
  {
    requirement: 'Retry the socket proxy on SIGPIPE',
    satisfied_by: 'PR #916 (commit abc123)',
    files: ['scripts/proxy.sh'],
  },
  {
    requirement: 'Test the retry',
    satisfied_by: 'PR #921 (commit def456)',
    files: ['./tests/test_docker_socket_proxy.sh'],
  },
];

function makeForgejo(opts: {
  labels?: string[];
  prFiles?: Array<{ filename: string; previous_filename?: string }>;
  changedFiles?: number;
  filesError?: boolean;
} = {}) {
  const labels = opts.labels ?? [];
  const prFiles = opts.prFiles ?? [];
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
    getBranch: async () => ({ name: 'b', commit: { id: 'sha', message: '' } }),
    getPullRequest: rec('getPullRequest', {
      changed_files: opts.changedFiles ?? prFiles.length,
      additions: 10,
      deletions: 2,
    }),
    listPullRequestFiles: async (...args: unknown[]) => {
      calls.push(['listPullRequestFiles', ...args]);
      if (opts.filesError) throw new Error('boom');
      return prFiles.map((f) => ({ status: 'modified', additions: 1, deletions: 0, ...f }));
    },
    commentOnIssue: rec('commentOnIssue'),
    commentOnPr: rec('commentOnPr'),
    deleteBranch: rec('deleteBranch'),
    closePullRequest: rec('closePullRequest'),
    replaceLabelByNames: rec('replaceLabelByNames'),
    closeIssue: rec('closeIssue'),
    mergePullRequest: rec('mergePullRequest'),
  } as unknown as ForgejoClient;
  const named = (n: string) => calls.filter((c) => c[0] === n);
  return { client, named };
}

function seedTask(overrides: Record<string, unknown> = {}): Task {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
  const row = {
    status: 'in-review',
    branch_name: 'agent/issue-911-x',
    pr_number: 918,
    attempt: 3,
    max_attempts: 5,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, branch_name, pr_number, attempt, max_attempts)
     VALUES (1, 911, 1, @status, @branch_name, @pr_number, @attempt, @max_attempts)`
  ).run(row);
  return getTask(1)!;
}

async function review(
  task: Task,
  forgejo: ForgejoClient,
  verdict: Record<string, unknown>,
  launchDev = vi.fn(async () => {})
) {
  await processReviewVerdict(
    task,
    verdict as never,
    undefined,
    0,
    forgejo,
    noopLog,
    launchDev,
    async () => {}
  );
  return launchDev;
}

const eventTypes = () => getTaskEvents(1).map((e) => e.event_type);

beforeEach(() => {
  initDatabase(':memory:');
});

describe('processReviewVerdict — no_change_superseded', () => {
  it('with evidence covering every PR file → no-change: PR closed, branch deleted, issue closed, labels kept', async () => {
    const task = seedTask();
    const { client, named } = makeForgejo({
      labels: ['status/in-review', 'bug', 'human-merge'],
      prFiles: [
        { filename: 'scripts/proxy.sh' },
        { filename: 'tests/test_docker_socket_proxy.sh' },
      ],
    });

    const launchDev = await review(task, client, {
      verdict: 'no_change_superseded',
      summary: 'main merged the same fixes in #916 and #921',
      superseded_by: EVIDENCE,
    });

    const fresh = getTask(1)!;
    expect(fresh.status).toBe('no-change');
    expect(fresh.completed_at).not.toBeNull();
    expect(TERMINAL_STATUSES.has(fresh.status)).toBe(true);
    expect(launchDev).not.toHaveBeenCalled();
    expect(named('mergePullRequest')).toHaveLength(0);

    expect(named('closePullRequest')[0][2]).toBe(918);
    expect(named('deleteBranch')[0][2]).toBe('agent/issue-911-x');
    expect(named('closeIssue')).toHaveLength(1);
    expect(named('replaceLabelByNames').map((c) => c[3]).at(-1)).toEqual([
      'status/no-change',
      'bug',
      'human-merge',
    ]);

    const issueComments = named('commentOnIssue').map((c) => c[3] as string);
    const finalComment = issueComments.find((c) => c.includes('confirmed by review agent'))!;
    expect(finalComment).toContain('main merged the same fixes');
    expect(finalComment).toContain('PR #916 (commit abc123)');
    expect(finalComment).toContain('Test the retry');
    expect(named('commentOnPr').some((c) => (c[3] as string).includes('superseded'))).toBe(true);

    expect(eventTypes()).toEqual(
      expect.arrayContaining(['review_verdict', 'no_change_confirmed', 'status_no-change'])
    );
    expect(eventTypes()).not.toContain('status_awaiting-human-merge');
    const verdictEvent = getTaskEvents(1).find((e) => e.event_type === 'review_verdict')!;
    expect(verdictEvent.message).toContain('no_change_superseded');
  });

  it('an empty PR diff needs no file accounting', async () => {
    const task = seedTask();
    const { client, named } = makeForgejo({ changedFiles: 0 });
    await review(task, client, {
      verdict: 'no_change_superseded',
      summary: 'already on main',
      superseded_by: [{ requirement: 'Fix it', satisfied_by: 'PR #916' }],
    });
    expect(getTask(1)!.status).toBe('no-change');
    expect(named('listPullRequestFiles')).toHaveLength(0);
  });

  it('accepts a renamed file named by its old path', async () => {
    const task = seedTask();
    const { client } = makeForgejo({
      prFiles: [
        { filename: 'scripts/proxy2.sh', previous_filename: 'scripts/proxy.sh' },
        { filename: 'tests/test_docker_socket_proxy.sh' },
      ],
    });
    await review(task, client, { verdict: 'no_change_superseded', superseded_by: EVIDENCE });
    expect(getTask(1)!.status).toBe('no-change');
  });

  it('with substantive unaccounted-for changes → needs-human-review, nothing deleted', async () => {
    const task = seedTask();
    const { client, named } = makeForgejo({
      prFiles: [
        { filename: 'scripts/proxy.sh' },
        { filename: 'tests/test_docker_socket_proxy.sh' },
        { filename: 'src/new_feature.ts' },
      ],
    });

    const launchDev = await review(task, client, {
      verdict: 'no_change_superseded',
      summary: 'main has it',
      superseded_by: EVIDENCE,
    });

    const fresh = getTask(1)!;
    expect(fresh.status).toBe('needs-human-review');
    expect(fresh.attempt).toBe(3);
    expect(launchDev).not.toHaveBeenCalled();
    expect(named('deleteBranch')).toHaveLength(0);
    expect(named('closePullRequest')).toHaveLength(0);
    expect(named('closeIssue')).toHaveLength(0);
    const comment = named('commentOnIssue').map((c) => c[3] as string).join('\n');
    expect(comment).toContain('src/new_feature.ts');
    expect(comment).toContain('Nothing was closed or deleted');
    expect(eventTypes()).toContain('review_verdict');
    expect(eventTypes()).not.toContain('no_change_confirmed');
  });

  it.each([
    ['no evidence', undefined],
    ['empty evidence', []],
    ['entry without satisfied_by', [{ requirement: 'Fix it', files: ['a.ts'] }]],
  ])('%s → needs-human-review, nothing deleted', async (_name, superseded_by) => {
    const task = seedTask();
    const { client, named } = makeForgejo({ prFiles: [{ filename: 'a.ts' }] });
    await review(task, client, { verdict: 'no_change_superseded', superseded_by });
    expect(getTask(1)!.status).toBe('needs-human-review');
    expect(named('deleteBranch')).toHaveLength(0);
    expect(named('closePullRequest')).toHaveLength(0);
  });

  it('PR files that cannot be listed → needs-human-review', async () => {
    const task = seedTask();
    const { client, named } = makeForgejo({ prFiles: [{ filename: 'a.ts' }], filesError: true });
    await review(task, client, {
      verdict: 'no_change_superseded',
      superseded_by: [{ requirement: 'R', satisfied_by: 'PR #1', files: ['a.ts'] }],
    });
    expect(getTask(1)!.status).toBe('needs-human-review');
    expect(named('closePullRequest')).toHaveLength(0);
  });

  it('no PR on the task → needs-human-review', async () => {
    const task = seedTask({ pr_number: null });
    const { client, named } = makeForgejo();
    await review(task, client, {
      verdict: 'no_change_superseded',
      superseded_by: [{ requirement: 'R', satisfied_by: 'PR #1' }],
    });
    expect(getTask(1)!.status).toBe('needs-human-review');
    expect(named('deleteBranch')).toHaveLength(0);
  });
});

describe('superseded evidence helpers', () => {
  it('parseSupersededEvidence normalises paths and rejects incomplete entries', () => {
    expect(parseSupersededEvidence(EVIDENCE)).toEqual([
      EVIDENCE[0],
      { ...EVIDENCE[1], files: ['tests/test_docker_socket_proxy.sh'] },
    ]);
    expect(parseSupersededEvidence('PR #916')).toBeNull();
    expect(parseSupersededEvidence([{ requirement: ' ', satisfied_by: 'x' }])).toBeNull();
    expect(
      parseSupersededEvidence([{ requirement: 'r', satisfied_by: 's', files: [1, ' x.ts '] }])
    ).toEqual([{ requirement: 'r', satisfied_by: 's', files: ['x.ts'] }]);
  });

  it('findUnaccountedFiles requires exact file names (no directories)', () => {
    const evidence = parseSupersededEvidence([
      { requirement: 'r', satisfied_by: 's', files: ['src/', 'a.ts'] },
    ])!;
    expect(
      findUnaccountedFiles([{ filename: 'a.ts' }, { filename: 'src/b.ts' }], evidence)
    ).toEqual(['src/b.ts']);
  });
});

describe('review prompt', () => {
  it('describes the superseded verdict and its evidence', () => {
    const task = seedTask();
    const prompt = buildReviewPrompt(
      task,
      { owner: 'o', name: 'r', base_branch: 'main' } as Repo,
      { title: 'T', body: 'Do the thing' }
    );
    expect(prompt).toContain('"no_change_superseded"');
    expect(prompt).toContain('"superseded_by"');
    expect(prompt).toContain('NOT for "the PR is wrong or incomplete"');
    expect(prompt).toContain('git diff origin/main...HEAD --name-only`');
  });
});
