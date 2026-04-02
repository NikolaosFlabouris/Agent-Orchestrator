import { describe, it, expect } from 'vitest';
import { parseDependencies } from '../../queue.js';

describe('parseDependencies', () => {
  it('parses standard checklist items', () => {
    const body = `## Dependencies\n- [ ] #38\n- [ ] #39`;
    expect(parseDependencies(body)).toEqual([38, 39]);
  });

  it('handles checked items (still parses unchecked only)', () => {
    const body = `- [x] #10\n- [ ] #20\n- [ ] #30`;
    // Only unchecked items are dependencies
    expect(parseDependencies(body)).toEqual([20, 30]);
  });

  it('returns empty array for no dependencies', () => {
    expect(parseDependencies('Just a task description')).toEqual([]);
    expect(parseDependencies('')).toEqual([]);
  });

  it('handles extra whitespace in checklist', () => {
    const body = `-  [ ]  #42`;
    expect(parseDependencies(body)).toEqual([42]);
  });

  it('ignores non-checklist issue references', () => {
    const body = `Depends on #38 and see #39`;
    expect(parseDependencies(body)).toEqual([]);
  });

  it('handles dependencies mixed with other content', () => {
    const body = `## Task\nDo the thing\n\n## Dependencies\n- [ ] #1\nSome text\n- [ ] #2\n\n## Notes\nMore text`;
    expect(parseDependencies(body)).toEqual([1, 2]);
  });

  it('handles large issue numbers', () => {
    const body = `- [ ] #99999`;
    expect(parseDependencies(body)).toEqual([99999]);
  });
});
