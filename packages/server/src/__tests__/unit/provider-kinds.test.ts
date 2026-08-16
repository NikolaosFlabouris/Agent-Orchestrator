import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getProviderKindSpec,
  listProviderKinds,
  resolveProviderCredential,
  buildProviderEnv,
} from '../../providers/kinds.js';
import type { Provider } from '@orchestrator/shared';

function mkProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p',
    display_name: 'P',
    kind: 'anthropic',
    concurrency_limit: 5,
    base_url: null,
    auth_token: null,
    api_key_env_var: null,
    notes: null,
    ...overrides,
  };
}

describe('listProviderKinds / getProviderKindSpec', () => {
  it('lists all eight built-in kinds', () => {
    const ids = listProviderKinds().map((s) => s.kind).sort();
    expect(ids).toEqual([
      'anthropic',
      'claude-subscription',
      'deepseek',
      'gemini',
      'mistral',
      'openai',
      'openai-compatible',
      'openrouter',
    ]);
  });

  it("identifies openai-compatible as the only requires_base_url kind", () => {
    const requireUrl = listProviderKinds().filter((s) => s.requires_base_url);
    expect(requireUrl.map((s) => s.kind)).toEqual(['openai-compatible']);
  });

  it("identifies openai-compatible as the only auth_optional kind", () => {
    const optional = listProviderKinds().filter((s) => s.auth_optional);
    expect(optional.map((s) => s.kind)).toEqual(['openai-compatible']);
  });

  it('maps anthropic and claude-subscription to different env names', () => {
    expect(getProviderKindSpec('anthropic').container_env_name).toBe(
      'ANTHROPIC_API_KEY'
    );
    expect(getProviderKindSpec('claude-subscription').container_env_name).toBe(
      'CLAUDE_CODE_OAUTH_TOKEN'
    );
  });

  it('routes openai-compatible auth through OPENAI_COMPAT_AUTH_TOKEN at runtime', () => {
    // Previously null (config-file-driven) — moved into env so the
    // harness scripts can reference it without baking the literal
    // token into agent_command / opencode.json. See H2 fix.
    expect(getProviderKindSpec('openai-compatible').container_env_name).toBe(
      'OPENAI_COMPAT_AUTH_TOKEN'
    );
  });
});

describe('resolveProviderCredential', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('prefers inline auth_token when set', () => {
    const p = mkProvider({ auth_token: 'inline-key', api_key_env_var: 'X' });
    process.env.X = 'env-key';
    expect(resolveProviderCredential(p)).toBe('inline-key');
  });

  it('falls back to env var when auth_token is null', () => {
    const p = mkProvider({ api_key_env_var: 'MY_KEY' });
    process.env.MY_KEY = 'env-key-value';
    expect(resolveProviderCredential(p)).toBe('env-key-value');
  });

  it('returns null when neither is configured', () => {
    expect(resolveProviderCredential(mkProvider())).toBeNull();
  });

  it('returns null when env var is referenced but unset', () => {
    delete process.env.UNSET_KEY;
    expect(
      resolveProviderCredential(mkProvider({ api_key_env_var: 'UNSET_KEY' }))
    ).toBeNull();
  });
});

describe('buildProviderEnv', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('exports the credential under the kind\'s standard env name', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const env = buildProviderEnv(
      mkProvider({ kind: 'anthropic', api_key_env_var: 'ANTHROPIC_API_KEY' })
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
  });

  it('translates the operator-chosen env name to the kind standard name', () => {
    // Operator stores their team key under ANTHROPIC_API_KEY_TEAM but the
    // SDK reads ANTHROPIC_API_KEY — buildProviderEnv exports under the
    // standard name regardless of where the orchestrator read it from.
    process.env.ANTHROPIC_API_KEY_TEAM = 'sk-team';
    const env = buildProviderEnv(
      mkProvider({ kind: 'anthropic', api_key_env_var: 'ANTHROPIC_API_KEY_TEAM' })
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-team' });
  });

  it('returns an empty object for openai-compatible when no credential is configured', () => {
    // No auth_token, no api_key_env_var → no env var exported. The
    // harnesses fall back to the literal "ollama" placeholder.
    expect(buildProviderEnv(mkProvider({ kind: 'openai-compatible' }))).toEqual({});
  });

  it('exports OPENAI_COMPAT_AUTH_TOKEN when openai-compatible has an inline auth_token', () => {
    expect(
      buildProviderEnv(
        mkProvider({ kind: 'openai-compatible', auth_token: 'bearer-xyz' })
      )
    ).toEqual({ OPENAI_COMPAT_AUTH_TOKEN: 'bearer-xyz' });
  });

  it('exports OPENAI_COMPAT_AUTH_TOKEN from the operator-named env var when set', () => {
    process.env.MY_SELF_HOSTED_KEY = 'bearer-from-env';
    expect(
      buildProviderEnv(
        mkProvider({
          kind: 'openai-compatible',
          api_key_env_var: 'MY_SELF_HOSTED_KEY',
        })
      )
    ).toEqual({ OPENAI_COMPAT_AUTH_TOKEN: 'bearer-from-env' });
  });

  it('returns an empty object when no credential resolves', () => {
    expect(buildProviderEnv(mkProvider({ kind: 'anthropic' }))).toEqual({});
  });
});
