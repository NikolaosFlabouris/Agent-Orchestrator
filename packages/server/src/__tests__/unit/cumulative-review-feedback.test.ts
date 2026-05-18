import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabase,
  insertAttempt,
  updateAttempt,
  getReviewFeedbackHistory,
} from '../../db.js';
import {
  assembleCumulativeReviewFeedback,
  renderPersistedAttemptFeedback,
  formatReviewForRework,
} from '../../agents/review.js';

// Isolated in-memory DB per test, mirroring attempts-snapshot.test.ts.
beforeEach(() => {
  const db = initDatabase(':memory:');
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count)
     VALUES (1, 100, 1, 'in-progress', 1, 7, 0)`
  ).run();
});

/** Mirror completeAttempt: insert a review row then persist verdict +
 *  JSON.stringify(review.feedback). `feedback === undefined` means
 *  completeAttempt would have stored NULL (no review.feedback). */
function recordReviewAttempt(
  attemptNumber: number,
  verdict: string,
  feedback?: unknown
): void {
  const a = insertAttempt({
    task_id: 1,
    attempt_number: attemptNumber,
    role: 'review',
    status: 'running',
  });
  updateAttempt(a.id, {
    status: 'completed',
    verdict,
    feedback: feedback === undefined ? null : JSON.stringify(feedback),
  });
}

describe('getReviewFeedbackHistory', () => {
  it('returns only completed changes_needed review rows with feedback, attempt ASC', () => {
    // A dev attempt (role develop, no verdict) must be excluded.
    insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
    });
    recordReviewAttempt(1, 'changes_needed', [
      { file: 'a.ts', line: 1, comment: 'first' },
    ]);
    recordReviewAttempt(2, 'changes_needed', [
      { file: 'b.ts', line: 2, comment: 'second' },
    ]);
    // Excluded: approved verdict, and a changes_needed with NULL feedback.
    recordReviewAttempt(3, 'approved', [{ file: 'c.ts', line: 3, comment: 'x' }]);
    recordReviewAttempt(4, 'changes_needed');

    const history = getReviewFeedbackHistory(1);
    expect(history.map((h) => h.attempt_number)).toEqual([1, 2]);
    expect(history[0].feedback).toContain('first');
    expect(history[1].feedback).toContain('second');
  });

  it('returns [] when there are no qualifying attempts', () => {
    insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
    });
    expect(getReviewFeedbackHistory(1)).toEqual([]);
  });
});

describe('renderPersistedAttemptFeedback — defensive parse', () => {
  it('renders the persisted JSON feedback through the shared renderer', () => {
    const raw = JSON.stringify([
      { file: 'src/x.ts', line: 9, comment: 'missing null check' },
    ]);
    const md = renderPersistedAttemptFeedback(raw);
    expect(md).toContain('src/x.ts:9');
    expect(md).toContain('missing null check');
  });

  it('treats a non-JSON payload as a bare string instead of throwing', () => {
    expect(renderPersistedAttemptFeedback('just fix it')).toContain(
      'just fix it'
    );
  });

  it('returns "" for null/empty/whitespace and JSON that renders empty', () => {
    expect(renderPersistedAttemptFeedback(null)).toBe('');
    expect(renderPersistedAttemptFeedback('')).toBe('');
    expect(renderPersistedAttemptFeedback('   ')).toBe('');
    expect(renderPersistedAttemptFeedback('[]')).toBe('');
    expect(renderPersistedAttemptFeedback('null')).toBe('');
  });
});

describe('assembleCumulativeReviewFeedback', () => {
  const currentReview = {
    verdict: 'changes_needed' as const,
    rubric: { requirements: { status: 'fail', note: 'missing X' } },
    feedback: [
      {
        file: 'src/now.ts',
        line: 3,
        category: 'requirements',
        severity: 'blocker',
        comment: 'still broken',
      },
    ],
  };
  const currentFeedback = formatReviewForRework(currentReview);

  it('single review attempt → byte-identical to legacy formatReviewForRework', () => {
    // The current attempt's persisted row is in history but is rendered
    // from the live `review`, so the result must equal today's output.
    const history = [
      { attempt_number: 1, feedback: JSON.stringify(currentReview.feedback) },
    ];
    const out = assembleCumulativeReviewFeedback(history, 1, currentFeedback);
    expect(out).toBe(currentFeedback);
    expect(out).not.toContain('### Attempt');
  });

  it('multi-attempt → all prior + current, oldest→newest, attributed', () => {
    const history = [
      {
        attempt_number: 1,
        feedback: JSON.stringify([
          { file: 'a.ts', line: 1, comment: 'issue one' },
        ]),
      },
      {
        attempt_number: 2,
        feedback: JSON.stringify([
          { file: 'b.ts', line: 2, comment: 'issue two' },
        ]),
      },
      // Current attempt's persisted row — skipped in favour of live review.
      { attempt_number: 3, feedback: JSON.stringify(currentReview.feedback) },
    ];
    const out = assembleCumulativeReviewFeedback(history, 3, currentFeedback);

    expect(out).toContain('### Attempt 1');
    expect(out).toContain('issue one');
    expect(out).toContain('### Attempt 2');
    expect(out).toContain('issue two');
    expect(out).toContain('### Attempt 3');
    expect(out).toContain('still broken');
    // Oldest → newest ordering.
    expect(out.indexOf('### Attempt 1')).toBeLessThan(
      out.indexOf('### Attempt 2')
    );
    expect(out.indexOf('### Attempt 2')).toBeLessThan(
      out.indexOf('### Attempt 3')
    );
    // Current attempt section preserves the rubric (live review only).
    expect(out).toContain('### Rubric');
  });

  it('skips prior attempts whose feedback is empty/unparsable, never throws', () => {
    const history = [
      { attempt_number: 1, feedback: '[]' }, // renders empty → skipped
      { attempt_number: 2, feedback: null }, // null → skipped
      {
        attempt_number: 3,
        feedback: JSON.stringify([
          { file: 'keep.ts', line: 7, comment: 'real issue' },
        ]),
      },
    ];
    const out = assembleCumulativeReviewFeedback(history, 4, currentFeedback);
    expect(out).not.toContain('### Attempt 1');
    expect(out).not.toContain('### Attempt 2');
    expect(out).toContain('### Attempt 3');
    expect(out).toContain('real issue');
    expect(out).toContain('### Attempt 4');
    expect(out).toContain('still broken');
  });

  it('collapses to bare current feedback when every prior row degrades', () => {
    const history = [
      { attempt_number: 1, feedback: 'null' },
      { attempt_number: 2, feedback: null },
      { attempt_number: 3, feedback: JSON.stringify(currentReview.feedback) },
    ];
    const out = assembleCumulativeReviewFeedback(history, 3, currentFeedback);
    expect(out).toBe(currentFeedback);
    expect(out).not.toContain('### Attempt');
  });

  it('round-trips through the DB accessor (persisted shape) end to end', () => {
    recordReviewAttempt(1, 'changes_needed', [
      { file: 'one.ts', line: 1, comment: 'older problem' },
    ]);
    recordReviewAttempt(2, 'changes_needed', currentReview.feedback);

    const out = assembleCumulativeReviewFeedback(
      getReviewFeedbackHistory(1),
      2,
      currentFeedback
    );
    expect(out).toContain('### Attempt 1');
    expect(out).toContain('older problem');
    expect(out).toContain('### Attempt 2');
    expect(out).toContain('still broken');
    expect(out).toContain('### Rubric');
  });
});
