import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses } from '../../harnesses/index.js';
import type { Provider, Model, AgentProfile } from '@orchestrator/shared';

function mkProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p',
    display_name: 'P',
    kind: 'anthropic',
    concurrency_limit: 5,
    base_url: null,
    auth_token: null,
    api_key_env_var: 'ANTHROPIC_API_KEY',
    notes: null,
    ...overrides,
  };
}
function mkModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 1,
    provider_id: 'p',
    model_id: 'claude-sonnet-4-6',
    display_name: 'Sonnet',
    ...overrides,
  };
}
function mkProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'pf',
    display_name: 'Profile',
    harness_id: 'claude-sdk',
    model_pk: 1,
    config_json: {},
    timeout_minutes: 120,
    ...overrides,
  };
}

describe('harness registry', () => {
  it('lists all four built-in harnesses', () => {
    const harnesses = listHarnesses();
    const ids = harnesses.map((h) => h.id).sort();
    expect(ids).toEqual(['claude-code', 'claude-sdk', 'opencode', 'pi']);
  });

  it('returns the same spec instance via getHarness', () => {
    expect(getHarness('claude-sdk').id).toBe('claude-sdk');
    expect(getHarness('claude-code').id).toBe('claude-code');
    expect(getHarness('opencode').id).toBe('opencode');
    expect(getHarness('pi').id).toBe('pi');
  });
});

describe('claude-sdk harness', () => {
  const h = getHarness('claude-sdk');

  it('builds an SDK invocation for an Anthropic provider', () => {
    const inv = h.buildInvocation({
      profile: mkProfile(),
      model: mkModel(),
      provider: mkProvider(),
      promptFilePath: '/task/prompt.md',
    });
    expect(h.runtime).toBe('sdk');
    expect(inv.agent_command).toBeNull();
    expect(inv.config_files).toEqual([]);
    expect(inv.resolved_model).toBe('claude-sonnet-4-6');
  });

  it('throws when paired with a non-Anthropic provider', () => {
    expect(() =>
      h.buildInvocation({
        profile: mkProfile(),
        model: mkModel(),
        provider: mkProvider({ kind: 'ollama', base_url: 'http://localhost:11434' }),
        promptFilePath: '/task/prompt.md',
      })
    ).toThrow(/does not support provider kind 'ollama'/);
  });
});

describe('claude-code harness', () => {
  const h = getHarness('claude-code');

  it('emits a CLI command with --max-turns from config_json', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'claude-code', config_json: { max_turns: 50 } }),
      model: mkModel(),
      provider: mkProvider(),
      promptFilePath: '/task/prompt.md',
    });
    expect(h.runtime).toBe('cli');
    expect(inv.agent_command).toContain('--max-turns 50');
    expect(inv.agent_command).toContain('--model claude-sonnet-4-6');
    expect(inv.agent_command).toContain('< /task/prompt.md');
    expect(inv.config_files).toEqual([]);
  });

  it('defaults max_turns to 100 when not set', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'claude-code' }),
      model: mkModel(),
      provider: mkProvider(),
      promptFilePath: '/task/prompt.md',
    });
    expect(inv.agent_command).toContain('--max-turns 100');
  });

  it('accepts the claude-subscription provider kind', () => {
    expect(() =>
      h.buildInvocation({
        profile: mkProfile({ harness_id: 'claude-code' }),
        model: mkModel(),
        provider: mkProvider({
          kind: 'claude-subscription',
          api_key_env_var: 'CLAUDE_CODE_OAUTH_TOKEN',
        }),
        promptFilePath: '/task/prompt.md',
      })
    ).not.toThrow();
  });

  it("validateConfig rejects non-positive-integer max_turns", () => {
    expect(() => h.validateConfig?.({ max_turns: 0 })).toThrow();
    expect(() => h.validateConfig?.({ max_turns: 1.5 })).toThrow();
    expect(() => h.validateConfig?.({ max_turns: 'a' })).toThrow();
    expect(() => h.validateConfig?.({ max_turns: 1 })).not.toThrow();
    expect(() => h.validateConfig?.({})).not.toThrow();
  });
});

describe('opencode harness', () => {
  const h = getHarness('opencode');

  it('emits no config file for cloud providers', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'opencode' }),
      model: mkModel(),
      provider: mkProvider(),
      promptFilePath: '/task/prompt.md',
    });
    expect(inv.config_files).toEqual([]);
    expect(inv.resolved_model).toBe('anthropic/claude-sonnet-4-6');
    expect(inv.agent_command).toContain('--model anthropic/claude-sonnet-4-6');
  });

  it('emits an opencode.json for ollama providers', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'opencode' }),
      model: mkModel({ model_id: 'qwen2.5-coder:14b' }),
      provider: mkProvider({
        kind: 'ollama',
        base_url: 'http://192.168.1.10:11434',
        api_key_env_var: null,
      }),
      promptFilePath: '/task/prompt.md',
    });
    expect(inv.config_files).toHaveLength(1);
    expect(inv.config_files[0].path).toBe('/repo/opencode.json');
    const cfg = JSON.parse(inv.config_files[0].content);
    expect(cfg.provider.ollama.options.baseURL).toBe(
      'http://192.168.1.10:11434/v1'
    );
    expect(inv.resolved_model).toBe('ollama/qwen2.5-coder:14b');
  });

  it('throws for ollama providers without base_url', () => {
    expect(() =>
      h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel(),
        provider: mkProvider({ kind: 'ollama', base_url: null }),
        promptFilePath: '/task/prompt.md',
      })
    ).toThrow(/base_url/);
  });
});

describe('pi harness', () => {
  const h = getHarness('pi');

  it('inlines models.json creation into the agent command', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'pi' }),
      model: mkModel(),
      provider: mkProvider(),
      promptFilePath: '/task/prompt.md',
    });
    expect(inv.config_files).toEqual([]);
    expect(inv.agent_command).toContain('mkdir -p ~/.pi/agent');
    expect(inv.agent_command).toContain('models.json');
    expect(inv.agent_command).toContain('pi -p --mode json');
    expect(inv.resolved_model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('builds an ollama-targeted models.json', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'pi' }),
      model: mkModel({ model_id: 'qwen2.5:7b' }),
      provider: mkProvider({
        kind: 'ollama',
        base_url: 'http://gpu:11434',
        api_key_env_var: null,
      }),
      promptFilePath: '/task/prompt.md',
    });
    // The JSON is single-quoted into a printf in agent_command; verify the
    // url and model id end up there as expected.
    expect(inv.agent_command).toContain('"baseUrl":"http://gpu:11434/v1"');
    expect(inv.agent_command).toContain('"id":"qwen2.5:7b"');
    expect(inv.resolved_model).toBe('ollama/qwen2.5:7b');
  });
});
