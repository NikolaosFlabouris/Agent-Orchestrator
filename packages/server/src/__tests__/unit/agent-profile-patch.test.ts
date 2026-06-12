import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveAgentProfile,
  resolveEffectiveReviewAgentProfile,
  validateAgentProfile,
  hasHumanReviewLabel,
} from '../../routes/tasks.js';
import type { Snapshot } from '../../forgejo-snapshot.js';

describe('resolveEffectiveAgentProfile', () => {
  it('returns the task override when set', () => {
    const result = resolveEffectiveAgentProfile(
      'task-profile',
      'repo-profile',
      'global-profile'
    );
    expect(result).toEqual({
      effective_agent_profile_id: 'task-profile',
      agent_profile_source: 'task',
    });
  });

  it('falls back to the repo default when task override is null', () => {
    const result = resolveEffectiveAgentProfile(
      null,
      'repo-profile',
      'global-profile'
    );
    expect(result).toEqual({
      effective_agent_profile_id: 'repo-profile',
      agent_profile_source: 'repo',
    });
  });

  it('falls back to the global default when task and repo are null', () => {
    const result = resolveEffectiveAgentProfile(null, null, 'global-profile');
    expect(result).toEqual({
      effective_agent_profile_id: 'global-profile',
      agent_profile_source: 'global',
    });
  });

  it('returns null with source "none" when every tier is null', () => {
    const result = resolveEffectiveAgentProfile(null, null, null);
    expect(result).toEqual({
      effective_agent_profile_id: null,
      agent_profile_source: 'none',
    });
  });
});

describe('resolveEffectiveReviewAgentProfile', () => {
  it('returns the task review override when set', () => {
    const result = resolveEffectiveReviewAgentProfile(
      'task-rev',
      'repo-rev',
      'global-rev',
      'impl-profile'
    );
    expect(result).toEqual({
      effective_review_agent_profile_id: 'task-rev',
      review_agent_profile_source: 'task',
    });
  });

  it('falls back to the repo review default', () => {
    const result = resolveEffectiveReviewAgentProfile(
      null,
      'repo-rev',
      'global-rev',
      'impl-profile'
    );
    expect(result).toEqual({
      effective_review_agent_profile_id: 'repo-rev',
      review_agent_profile_source: 'repo',
    });
  });

  it('falls back to the global review default', () => {
    const result = resolveEffectiveReviewAgentProfile(
      null,
      null,
      'global-rev',
      'impl-profile'
    );
    expect(result).toEqual({
      effective_review_agent_profile_id: 'global-rev',
      review_agent_profile_source: 'global',
    });
  });

  it('falls back to the effective implementation profile when no review tier is set', () => {
    const result = resolveEffectiveReviewAgentProfile(
      null,
      null,
      null,
      'impl-profile'
    );
    expect(result).toEqual({
      effective_review_agent_profile_id: 'impl-profile',
      review_agent_profile_source: 'implementation',
    });
  });

  it('returns null with source "none" when every tier including implementation is null', () => {
    const result = resolveEffectiveReviewAgentProfile(null, null, null, null);
    expect(result).toEqual({
      effective_review_agent_profile_id: null,
      review_agent_profile_source: 'none',
    });
  });
});

// ---------------------------------------------------------------------------
// Validation logic — tests for the exported validateAgentProfile used by PATCH
// ---------------------------------------------------------------------------

describe('validateAgentProfile (PATCH handler validation)', () => {
  const knownProfiles: Record<string, { id: string }> = {
    'claude-sdk-sonnet': { id: 'claude-sdk-sonnet' },
    'opencode-ollama': { id: 'opencode-ollama' },
  };

  const getAgentProfile = (id: string) => knownProfiles[id];

  it('accepts a valid existing profile id', () => {
    expect(validateAgentProfile('claude-sdk-sonnet', getAgentProfile)).toEqual({
      valid: true,
    });
  });

  it('accepts another valid existing profile id', () => {
    expect(validateAgentProfile('opencode-ollama', getAgentProfile)).toEqual({
      valid: true,
    });
  });

  it('rejects an unknown profile id with an error message', () => {
    const result = validateAgentProfile('nonexistent-profile', getAgentProfile);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('nonexistent-profile');
    }
  });

  it('accepts null (clears the override)', () => {
    expect(validateAgentProfile(null, getAgentProfile)).toEqual({ valid: true });
  });

  it('names the supplied field in the error message (review override)', () => {
    const result = validateAgentProfile(
      'nonexistent-profile',
      getAgentProfile,
      'review_agent_profile_id'
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe(
        'Unknown review_agent_profile_id: nonexistent-profile'
      );
    }
  });
});

describe('hasHumanReviewLabel', () => {
  function snap(labels: string[]): Snapshot {
    return {
      issue: { state: 'open', labels },
      pr: null,
      fetched_at: 0,
    };
  }

  it('returns true when the human-review label is present', () => {
    expect(hasHumanReviewLabel(snap(['status/in-review', 'human-review']))).toBe(
      true
    );
  });

  it('returns false when the label is absent', () => {
    expect(hasHumanReviewLabel(snap(['status/in-review', 'human-merge']))).toBe(
      false
    );
  });

  it('returns null (unknown) when no snapshot is available', () => {
    expect(hasHumanReviewLabel(null)).toBeNull();
  });
});
