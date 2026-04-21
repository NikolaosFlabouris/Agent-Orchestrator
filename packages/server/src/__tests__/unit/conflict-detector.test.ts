import { describe, it, expect } from 'vitest';
import { decideConflictAction } from '../../conflict-detector.js';

describe('decideConflictAction', () => {
  it('returns "none" when PR is still mergeable', () => {
    expect(decideConflictAction(true, 1, 3)).toBe('none');
  });

  it('returns "none" when mergeability is not yet determined (null)', () => {
    // Forgejo sometimes returns `mergeable: null` while recomputing after a
    // base-branch push. Acting on null would thrash — treat it as unknown.
    expect(decideConflictAction(null, 1, 3)).toBe('none');
    expect(decideConflictAction(undefined, 1, 3)).toBe('none');
  });

  it('returns "rebase" when PR is unmergeable and budget remains', () => {
    expect(decideConflictAction(false, 1, 3)).toBe('rebase');
    expect(decideConflictAction(false, 2, 3)).toBe('rebase');
  });

  it('returns "fail" when PR is unmergeable and the next attempt would exceed max_attempts', () => {
    // currentAttempt=3, maxAttempts=3 → next would be 4 → fail.
    expect(decideConflictAction(false, 3, 3)).toBe('fail');
    expect(decideConflictAction(false, 5, 1)).toBe('fail');
  });

  it('respects a max_attempts of 1 (single-shot policy)', () => {
    expect(decideConflictAction(false, 1, 1)).toBe('fail');
    // attempt=0 is unusual but the function should still behave sensibly.
    expect(decideConflictAction(false, 0, 1)).toBe('rebase');
  });
});
