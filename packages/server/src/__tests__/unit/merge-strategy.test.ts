import { describe, it, expect } from 'vitest';
import { resolveMergeStrategy } from '../../merge-strategy.js';

describe('resolveMergeStrategy', () => {
  describe('exactly one allowed → use it', () => {
    it('returns the only allowed style with reason "only-allowed"', () => {
      expect(resolveMergeStrategy(['squash'], 'merge')).toEqual({
        strategy: 'squash',
        reason: 'only-allowed',
      });
    });

    it('does so even when the operator preferred something else', () => {
      expect(resolveMergeStrategy(['rebase'], 'squash')).toEqual({
        strategy: 'rebase',
        reason: 'only-allowed',
      });
    });

    it('handles a sole non-preferred fallback strategy', () => {
      expect(resolveMergeStrategy(['fast-forward-only'], 'merge')).toEqual({
        strategy: 'fast-forward-only',
        reason: 'only-allowed',
      });
    });
  });

  describe('multiple allowed AND preferred is in the set → use preferred', () => {
    it('picks the preferred squash when squash + merge are allowed', () => {
      expect(
        resolveMergeStrategy(['squash', 'merge'], 'squash')
      ).toEqual({ strategy: 'squash', reason: 'preferred' });
    });

    it('picks merge when merge is preferred and allowed', () => {
      expect(
        resolveMergeStrategy(['squash', 'merge', 'rebase'], 'merge')
      ).toEqual({ strategy: 'merge', reason: 'preferred' });
    });

    it('picks rebase when rebase is preferred and allowed', () => {
      expect(
        resolveMergeStrategy(['merge', 'rebase'], 'rebase')
      ).toEqual({ strategy: 'rebase', reason: 'preferred' });
    });
  });

  describe('multiple allowed but preferred not in set → first from PRIORITY_ORDER', () => {
    it('falls back to squash when preferred merge is disallowed', () => {
      // PRIORITY_ORDER = squash > merge > rebase > rebase-merge > fast-forward-only.
      // Allowed = [squash, rebase], preferred = 'merge'. Squash wins.
      expect(
        resolveMergeStrategy(['squash', 'rebase'], 'merge')
      ).toEqual({ strategy: 'squash', reason: 'fallback' });
    });

    it('falls back to merge when squash is disallowed and rebase preferred not in set', () => {
      // Allowed = [merge, rebase-merge], preferred = 'rebase'.
      // Squash not in allowed, merge in allowed → merge wins.
      expect(
        resolveMergeStrategy(['merge', 'rebase-merge'], 'rebase')
      ).toEqual({ strategy: 'merge', reason: 'fallback' });
    });

    it('falls back to rebase-merge when only rebase variants are allowed', () => {
      expect(
        resolveMergeStrategy(['rebase-merge', 'fast-forward-only'], 'squash')
      ).toEqual({ strategy: 'rebase-merge', reason: 'fallback' });
    });

    it('falls back to fast-forward-only as a last resort', () => {
      expect(
        resolveMergeStrategy(['fast-forward-only'], 'squash')
      ).toEqual({ strategy: 'fast-forward-only', reason: 'only-allowed' });
    });
  });

  describe('error cases', () => {
    it('throws when allowed is empty', () => {
      expect(() => resolveMergeStrategy([], 'squash')).toThrow(
        /no allowed merge strategies/i
      );
    });
  });
});
