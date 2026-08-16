import { describe, it, expect } from 'vitest';
import {
  formatContextWindowInput,
  parseContextWindowInput,
} from '../views/Settings/contextWindow.js';

describe('parseContextWindowInput', () => {
  it('reads a whole token count', () => {
    expect(parseContextWindowInput('32768')).toBe(32768);
    expect(parseContextWindowInput('  131072  ')).toBe(131072);
  });

  it('treats a blank field as "unset", not zero', () => {
    // NULL is what makes the harness emit its pre-column config; a 0 here
    // would be a real (and nonsensical) token budget.
    expect(parseContextWindowInput('')).toBeNull();
    expect(parseContextWindowInput('   ')).toBeNull();
  });

  it('rejects values that are not a positive whole number of tokens', () => {
    for (const bad of ['0', '-1', '1.5', 'lots', '32768tokens', '1e5x', 'NaN']) {
      expect(parseContextWindowInput(bad), bad).toBeUndefined();
    }
  });
});

describe('formatContextWindowInput', () => {
  it('round-trips a set value', () => {
    expect(parseContextWindowInput(formatContextWindowInput(32768))).toBe(32768);
  });

  it('renders an unset value as an empty field', () => {
    expect(formatContextWindowInput(null)).toBe('');
    expect(parseContextWindowInput(formatContextWindowInput(null))).toBeNull();
  });
});
