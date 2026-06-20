import { describe, it, expect, beforeEach } from 'vitest';
import type { Task } from '@orchestrator/shared';
import {
  initDatabase,
  getDb,
  insertAttempt,
  getAttempts,
} from '../../db.js';
import { processReviewVerdict } from '../../agents/review.js';
import type { ForgejoClient } from '../../forgejo.js';

/** #116: the review/merge flow promotes the PR diff stats it already fetches
 *  for the verdict event ({ changed_files, additions, deletions }) onto the
 *  review attempt row as structured columns. This must reuse the in-hand
 *  `prStats` object — no second Forgejo round-trip — and must leave the
 *  existing `review_verdict` event message untouched. */

function seedReviewTask(): Task {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, branch_name, pr_number, attempt, max_attempts)
     VALUES (1, 100, 1, 'in-review', 'agent/issue-100', 42, 1, 7)`
  ).run();
  // A develop attempt followed by the review attempt — the review attempt is
  // the most-recently-inserted row, which is what the persistence targets.
  insertAttempt({ task_id: 1, attempt_number: 1, role: 'develop', status: 'completed' });
  insertAttempt({ task_id: 1, attempt_number: 1, role: 'review', status: 'completed' });
  return db.prepare('SELECT * FROM tasks WHERE id = 1').get() as Task;
}

/** Fake Forgejo client: serves the PR object once and counts how many times
 *  getPullRequest is called so the test can prove no extra round-trip. */
function makeForgejo(): { client: ForgejoClient; prCalls: () => number } {
  let prCalls = 0;
  const client = {
    async getPullRequest() {
      prCalls += 1;
      return { changed_files: 7, additions: 123, deletions: 45, mergeable: true, merged: false };
    },
    async commentOnIssue() {
      /* best effort no-op */
    },
  } as unknown as ForgejoClient;
  return { client, prCalls: () => prCalls };
}

const noopLog = { info() {}, warn() {}, error() {} } as never;

beforeEach(() => {
  initDatabase(':memory:');
});

describe('processReviewVerdict — PR diff stats persistence (#116)', () => {
  it('writes the already-fetched diff stats onto the review attempt with no extra Forgejo call', async () => {
    const task = seedReviewTask();
    const { client, prCalls } = makeForgejo();

    // 'unclear' verdict ends the task in a terminal state without entering
    // the merge path, keeping the test focused on the persistence step.
    await processReviewVerdict(
      task,
      { verdict: 'unclear', summary: 'ambiguous' },
      undefined, // preReviewSha → skip the branch-drift check (no getBranch)
      0,
      client,
      noopLog,
      async () => {},
      async () => {}
    );

    // Exactly one PR fetch — the verdict event's fetch is reused for the
    // persistence; no second round-trip was added.
    expect(prCalls()).toBe(1);

    const attempts = getAttempts(1);
    const review = attempts.find((a) => a.role === 'review')!;
    const develop = attempts.find((a) => a.role === 'develop')!;

    // Stats land on the review attempt…
    expect(review.changed_files).toBe(7);
    expect(review.additions).toBe(123);
    expect(review.deletions).toBe(45);
    // …and not on the develop attempt.
    expect(develop.changed_files).toBeNull();
    expect(develop.additions).toBeNull();
    expect(develop.deletions).toBeNull();

    // The existing review_verdict event message is unchanged: verdict +
    // the stats suffix + summary, exactly as before #116.
    const event = getDb()
      .prepare(
        "SELECT message FROM task_events WHERE task_id = 1 AND event_type = 'review_verdict'"
      )
      .get() as { message: string };
    expect(event.message).toBe(
      'Review verdict: unclear (changed_files=7, additions=123, deletions=45) — ambiguous'
    );
  });

  it('leaves the columns NULL when the PR fetch fails (no stats in hand)', async () => {
    const task = seedReviewTask();
    const client = {
      async getPullRequest() {
        throw new Error('forgejo down');
      },
      async commentOnIssue() {},
    } as unknown as ForgejoClient;

    await processReviewVerdict(
      task,
      { verdict: 'unclear' },
      undefined,
      0,
      client,
      noopLog,
      async () => {},
      async () => {}
    );

    const review = getAttempts(1).find((a) => a.role === 'review')!;
    expect(review.changed_files).toBeNull();
    expect(review.additions).toBeNull();
    expect(review.deletions).toBeNull();
  });
});
