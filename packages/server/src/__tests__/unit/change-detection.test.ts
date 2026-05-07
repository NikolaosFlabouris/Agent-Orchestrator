import { describe, it, expect } from 'vitest';

/**
 * Change detection logic tests.
 *
 * The actual detectChanges function calls git via execFile (async),
 * so we test the logic patterns here against the three boolean signals:
 * hasUncommitted, hasUntracked, hasLocalCommits.
 *
 * This validates the decision matrix from doc 05's post_dev_agent:
 * - No changes at all → "no work produced"
 * - Any combination of changes → work exists, salvage eligible
 */

interface ChangeDetection {
  hasUncommitted: boolean;
  hasUntracked: boolean;
  hasLocalCommits: boolean;
}

function hasWork(changes: ChangeDetection): boolean {
  return changes.hasUncommitted || changes.hasUntracked || changes.hasLocalCommits;
}

function needsSalvageCommit(changes: ChangeDetection): boolean {
  return changes.hasUncommitted || changes.hasUntracked;
}

describe('change detection logic', () => {
  it('detects no work when everything is clean', () => {
    expect(
      hasWork({ hasUncommitted: false, hasUntracked: false, hasLocalCommits: false })
    ).toBe(false);
  });

  it('detects work from uncommitted changes only', () => {
    expect(
      hasWork({ hasUncommitted: true, hasUntracked: false, hasLocalCommits: false })
    ).toBe(true);
  });

  it('detects work from untracked files only', () => {
    expect(
      hasWork({ hasUncommitted: false, hasUntracked: true, hasLocalCommits: false })
    ).toBe(true);
  });

  it('detects work from local commits only', () => {
    expect(
      hasWork({ hasUncommitted: false, hasUntracked: false, hasLocalCommits: true })
    ).toBe(true);
  });

  it('detects work from all change types', () => {
    expect(
      hasWork({ hasUncommitted: true, hasUntracked: true, hasLocalCommits: true })
    ).toBe(true);
  });

  it('needs salvage commit for uncommitted changes', () => {
    expect(
      needsSalvageCommit({ hasUncommitted: true, hasUntracked: false, hasLocalCommits: false })
    ).toBe(true);
  });

  it('needs salvage commit for untracked files', () => {
    expect(
      needsSalvageCommit({ hasUncommitted: false, hasUntracked: true, hasLocalCommits: false })
    ).toBe(true);
  });

  it('does not need salvage commit for local commits only', () => {
    expect(
      needsSalvageCommit({ hasUncommitted: false, hasUntracked: false, hasLocalCommits: true })
    ).toBe(false);
  });

  it('needs salvage commit for commits + uncommitted', () => {
    expect(
      needsSalvageCommit({ hasUncommitted: true, hasUntracked: false, hasLocalCommits: true })
    ).toBe(true);
  });
});
