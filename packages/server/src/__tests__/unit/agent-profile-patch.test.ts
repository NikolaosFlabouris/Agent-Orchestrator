import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveAgentProfile,
  validateAgentProfile,
} from '../../routes/tasks.js';

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
});
