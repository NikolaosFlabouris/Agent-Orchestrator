import { describe, it, expect } from 'vitest';
import {
  buildPullRequestBody,
  ensureIssueLink,
  extractLinkedIssues,
  hasIssueLink,
} from '../../forgejo-linking.js';

describe('buildPullRequestBody', () => {
  it('includes Closes #N for the given issue', () => {
    const body = buildPullRequestBody({ issue_id: 42 });
    expect(body).toContain('Closes #42');
  });

  it('omits the attempt line on attempt 1', () => {
    const body = buildPullRequestBody({ issue_id: 42, attempt: 1 });
    expect(body).not.toMatch(/Attempt:/);
  });

  it('includes the attempt line for reworks', () => {
    const body = buildPullRequestBody({ issue_id: 42, attempt: 3 });
    expect(body).toMatch(/Attempt: 3/);
    expect(body).toContain('Closes #42');
  });

  it('produces a body that satisfies hasIssueLink', () => {
    const body = buildPullRequestBody({ issue_id: 7 });
    expect(hasIssueLink(body, 7)).toBe(true);
  });
});

describe('hasIssueLink', () => {
  it('matches Closes #N', () => {
    expect(hasIssueLink('Closes #42', 42)).toBe(true);
  });

  it('matches Fixes #N (case-insensitive)', () => {
    expect(hasIssueLink('fixes #42', 42)).toBe(true);
    expect(hasIssueLink('FIXES #42', 42)).toBe(true);
  });

  it('matches Resolves #N', () => {
    expect(hasIssueLink('Resolves #42', 42)).toBe(true);
  });

  it('matches past-tense variants', () => {
    expect(hasIssueLink('closed #42', 42)).toBe(true);
    expect(hasIssueLink('fixed #42', 42)).toBe(true);
    expect(hasIssueLink('resolved #42', 42)).toBe(true);
  });

  it('does not match bare #N without a closing keyword', () => {
    expect(hasIssueLink('See #42 for context', 42)).toBe(false);
  });

  it('does not match closing keyword for a different issue', () => {
    expect(hasIssueLink('Closes #7', 42)).toBe(false);
  });

  it('handles multi-line body with other content', () => {
    const body = 'Automated PR for #42\n\nSome description\n\nCloses #42';
    expect(hasIssueLink(body, 42)).toBe(true);
  });

  it('returns false for null or empty body', () => {
    expect(hasIssueLink(null, 42)).toBe(false);
    expect(hasIssueLink(undefined, 42)).toBe(false);
    expect(hasIssueLink('', 42)).toBe(false);
  });

  it('does not false-match embedded digits', () => {
    expect(hasIssueLink('Closes #420', 42)).toBe(false);
  });
});

describe('ensureIssueLink', () => {
  it('returns body unchanged when the link is already present', () => {
    const body = 'Automated PR for #42\n\nCloses #42';
    expect(ensureIssueLink(body, 42)).toBe(body);
  });

  it('appends Closes #N when missing', () => {
    const result = ensureIssueLink('Summary of changes', 42);
    expect(hasIssueLink(result, 42)).toBe(true);
    expect(result).toContain('Summary of changes');
  });

  it('is idempotent — calling twice produces the same body', () => {
    const first = ensureIssueLink('some body', 42);
    const second = ensureIssueLink(first, 42);
    expect(first).toBe(second);
  });

  it('preserves existing closing keyword for a DIFFERENT issue and appends the correct one', () => {
    const input = 'Closes #99';
    const out = ensureIssueLink(input, 42);
    expect(hasIssueLink(out, 99)).toBe(true);
    expect(hasIssueLink(out, 42)).toBe(true);
  });

  it('handles null body', () => {
    const out = ensureIssueLink(null, 42);
    expect(hasIssueLink(out, 42)).toBe(true);
  });

  it('handles empty string', () => {
    const out = ensureIssueLink('', 42);
    expect(hasIssueLink(out, 42)).toBe(true);
  });
});

describe('extractLinkedIssues', () => {
  it('returns every distinct issue referenced by a closing keyword', () => {
    const body =
      'Closes #1\n' +
      'Also fixes #2, and resolves #3.\n' +
      'See #4 for context (not a closing keyword).';
    expect(extractLinkedIssues(body).sort()).toEqual([1, 2, 3]);
  });

  it('deduplicates repeated references', () => {
    expect(extractLinkedIssues('Closes #7 Closes #7')).toEqual([7]);
  });

  it('returns empty for no closing keywords', () => {
    expect(extractLinkedIssues('Just a description')).toEqual([]);
  });

  it('returns empty for null/undefined/empty', () => {
    expect(extractLinkedIssues(null)).toEqual([]);
    expect(extractLinkedIssues(undefined)).toEqual([]);
    expect(extractLinkedIssues('')).toEqual([]);
  });
});
