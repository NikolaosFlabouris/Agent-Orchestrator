import { describe, it, expect } from 'vitest';
import type { HarnessSpec } from '../api.js';
import { effortLevelDisabledReason } from '../views/Settings/effortLevel.js';

const OPENCODE_REASON = '--variant names are provider-specific.';

const claudeCode: HarnessSpec = {
  id: 'claude-code',
  display_name: 'Claude Code CLI',
  runtime: 'cli',
  supported_provider_kinds: ['anthropic', 'claude-subscription'],
  effort_level_support: {
    anthropic: { supported: true },
    'claude-subscription': { supported: true },
  },
};

const opencode: HarnessSpec = {
  id: 'opencode',
  display_name: 'OpenCode CLI',
  runtime: 'cli',
  supported_provider_kinds: ['anthropic', 'openai-compatible'],
  effort_level_support: {
    anthropic: { supported: false, reason: OPENCODE_REASON },
    'openai-compatible': { supported: false, reason: OPENCODE_REASON },
  },
};

describe('effortLevelDisabledReason', () => {
  it('is enabled for a supporting harness, model picked or not', () => {
    expect(effortLevelDisabledReason(claudeCode, null)).toBeNull();
    expect(effortLevelDisabledReason(claudeCode, 'claude-subscription')).toBeNull();
  });

  it("returns the harness's reason when the picked provider kind is unsupported", () => {
    expect(effortLevelDisabledReason(opencode, 'openai-compatible')).toBe(
      OPENCODE_REASON
    );
  });

  it('is disabled before a model is picked when no kind is supported', () => {
    expect(effortLevelDisabledReason(opencode, null)).toBe(OPENCODE_REASON);
  });

  it('stays enabled before a model is picked when any kind is supported', () => {
    const mixed: HarnessSpec = {
      ...opencode,
      effort_level_support: {
        anthropic: { supported: true },
        'openai-compatible': { supported: false, reason: OPENCODE_REASON },
      },
    };
    expect(effortLevelDisabledReason(mixed, null)).toBeNull();
    expect(effortLevelDisabledReason(mixed, 'openai-compatible')).toBe(
      OPENCODE_REASON
    );
  });

  it('stays enabled when the server reports no capability at all', () => {
    const legacy = { ...claudeCode, effort_level_support: {} };
    expect(effortLevelDisabledReason(legacy, 'anthropic')).toBeNull();
  });
});
