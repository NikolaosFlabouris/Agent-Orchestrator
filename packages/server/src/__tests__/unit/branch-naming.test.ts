import { describe, it, expect } from 'vitest';
import { generateBranchName } from '../../workspace.js';

describe('generateBranchName', () => {
  it('generates standard branch name', () => {
    expect(generateBranchName(42, 'Add login validation')).toBe(
      'agent/issue-42-add-login-validation'
    );
  });

  it('lowercases the title', () => {
    expect(generateBranchName(1, 'Fix CRITICAL Bug')).toBe(
      'agent/issue-1-fix-critical-bug'
    );
  });

  it('replaces spaces with hyphens', () => {
    expect(generateBranchName(1, 'add new feature')).toBe(
      'agent/issue-1-add-new-feature'
    );
  });

  it('strips non-alphanumeric characters', () => {
    expect(generateBranchName(1, "Fix bug (issue #42) [urgent]")).toBe(
      'agent/issue-1-fix-bug-issue-42-urgent'
    );
  });

  it('collapses multiple hyphens', () => {
    expect(generateBranchName(1, 'fix---multiple---hyphens')).toBe(
      'agent/issue-1-fix-multiple-hyphens'
    );
  });

  it('truncates to 50 chars for the sanitized portion', () => {
    const longTitle = 'a'.repeat(100);
    const result = generateBranchName(1, longTitle);
    const sanitized = result.replace('agent/issue-1-', '');
    expect(sanitized.length).toBeLessThanOrEqual(50);
  });

  it('removes trailing hyphens after truncation', () => {
    // Create a title that would produce a trailing hyphen after truncation
    const title = 'word '.repeat(20);
    const result = generateBranchName(1, title);
    expect(result.endsWith('-')).toBe(false);
  });

  it('handles empty title', () => {
    expect(generateBranchName(1, '')).toBe('agent/issue-1-task');
  });

  it('handles title with only special characters', () => {
    expect(generateBranchName(1, '!@#$%^&*()')).toBe('agent/issue-1-task');
  });

  it('always starts with agent/ prefix', () => {
    expect(generateBranchName(42, 'anything').startsWith('agent/')).toBe(true);
  });
});
