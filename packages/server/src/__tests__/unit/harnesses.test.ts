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
    // Model id and prompt path are shell-single-quoted as a
    // defence-in-depth measure against metacharacters in operator-
    // supplied DB rows. See packages/server/src/harnesses/shell.ts.
    expect(inv.agent_command).toContain("--model 'claude-sonnet-4-6'");
    expect(inv.agent_command).toContain("< '/task/prompt.md'");
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

  // ---- C2 fix: --bare is per-provider-kind, not always-on. ----
  // For anthropic (API key) we keep --bare for determinism + to skip
  // doomed keychain/CLAUDE.md/MCP lookups. For claude-subscription
  // (OAuth) we must drop --bare because it disables the OAuth code
  // path the CLI uses to read CLAUDE_CODE_OAUTH_TOKEN.
  describe('C2: --bare is conditional on provider kind', () => {
    it('includes --bare for the anthropic API-key provider', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'claude-code' }),
        model: mkModel(),
        provider: mkProvider({ kind: 'anthropic' }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain('--bare');
    });

    it('omits --bare for the claude-subscription OAuth provider', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'claude-code' }),
        model: mkModel(),
        provider: mkProvider({
          kind: 'claude-subscription',
          api_key_env_var: 'CLAUDE_CODE_OAUTH_TOKEN',
        }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).not.toContain('--bare');
      // The rest of the headless-mode flags should still be present —
      // we're only stripping --bare, not turning the CLI interactive.
      expect(inv.agent_command).toContain('--print');
      expect(inv.agent_command).toContain('--output-format stream-json');
      expect(inv.agent_command).toContain('--dangerously-skip-permissions');
    });
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
    // Shell-single-quoted (see harnesses/shell.ts).
    expect(inv.agent_command).toContain("--model 'anthropic/claude-sonnet-4-6'");
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

  // ---- H2 fix: Ollama auth_token never appears in the orchestrator-
  // generated /repo/opencode.json or in agent_command. The token is
  // exported as $OLLAMA_AUTH_TOKEN by the scheduler; agent_command
  // substitutes it into the on-disk config via jq before launching
  // opencode. ----
  describe('H2: ollama credential never inlined', () => {
    const SECRET = 'super-secret-bearer-zzz';

    it('writes a sentinel apiKey into opencode.json, not the auth_token', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({ model_id: 'qwen2.5-coder:14b' }),
        provider: mkProvider({
          kind: 'ollama',
          base_url: 'http://192.168.1.10:11434',
          auth_token: SECRET,
        }),
        promptFilePath: '/task/prompt.md',
      });
      const cfg = JSON.parse(inv.config_files[0].content);
      // Sentinel is present, secret is not.
      expect(cfg.provider.ollama.options.apiKey).not.toBe(SECRET);
      expect(inv.config_files[0].content).not.toContain(SECRET);
    });

    it('prepends a jq substitution step referencing $OLLAMA_AUTH_TOKEN', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({ model_id: 'qwen2.5-coder:14b' }),
        provider: mkProvider({
          kind: 'ollama',
          base_url: 'http://192.168.1.10:11434',
          auth_token: SECRET,
        }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain('jq');
      expect(inv.agent_command).toContain('OLLAMA_AUTH_TOKEN');
      expect(inv.agent_command).not.toContain(SECRET);
    });

    it('skips the jq substitution for non-ollama (cloud) providers', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel(),
        provider: mkProvider({ kind: 'anthropic' }),
        promptFilePath: '/task/prompt.md',
      });
      // No config file to rewrite, so no jq step.
      expect(inv.agent_command).not.toContain('jq');
      expect(inv.agent_command).not.toContain('OLLAMA_AUTH_TOKEN');
    });
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

  it('builds an ollama-targeted models.json via jq', () => {
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
    // JSON is built at runtime by jq; the agent_command carries the
    // URL and model id as `--arg` values, not the file contents
    // directly.
    expect(inv.agent_command).toContain('jq -n');
    expect(inv.agent_command).toContain('http://gpu:11434/v1');
    expect(inv.agent_command).toContain('qwen2.5:7b');
    expect(inv.resolved_model).toBe('ollama/qwen2.5:7b');
  });

  // ---- Cloud-kind support. Pi has built-in provider definitions for
  // each of these and reads the standard env var the orchestrator
  // exports (per ProviderKindSpec.container_env_name). The harness
  // writes a minimal stanza naming the pi-side provider so pi
  // recognises the --model argument. ----
  describe('cloud kinds', () => {
    // (orchestrator kind, expected pi-side provider name).
    const cases: ReadonlyArray<[
      'anthropic' | 'openai' | 'gemini' | 'mistral' | 'deepseek' | 'openrouter',
      string,
    ]> = [
      ['anthropic', 'anthropic'],
      ['openai', 'openai'],
      // Pi calls Gemini "google" internally even though the env var is
      // GEMINI_API_KEY. This is the one rename in PI_PROVIDER_NAMES.
      ['gemini', 'google'],
      ['mistral', 'mistral'],
      ['deepseek', 'deepseek'],
      ['openrouter', 'openrouter'],
    ];

    for (const [kind, piName] of cases) {
      it(`maps kind '${kind}' to pi provider '${piName}' and emits a matching --model`, () => {
        const inv = h.buildInvocation({
          profile: mkProfile({ harness_id: 'pi' }),
          model: mkModel({ model_id: 'some-model-id' }),
          provider: mkProvider({ kind }),
          promptFilePath: '/task/prompt.md',
        });
        expect(inv.resolved_model).toBe(`${piName}/some-model-id`);
        // resolved_model is shell-quoted as the --model arg.
        expect(inv.agent_command).toContain(`--model '${piName}/some-model-id'`);
        // models.json declaration uses the same pi-side name as the
        // provider key so the model id is reachable when pi resolves
        // the --model argument.
        expect(inv.agent_command).toContain(`--arg provider '${piName}'`);
        // No Ollama-only fields leak into cloud-kind config.
        expect(inv.agent_command).not.toContain('baseUrl');
        expect(inv.agent_command).not.toContain('OLLAMA_AUTH_TOKEN');
      });
    }

    it('throws for an unsupported kind like claude-subscription', () => {
      expect(() =>
        h.buildInvocation({
          profile: mkProfile({ harness_id: 'pi' }),
          model: mkModel(),
          provider: mkProvider({ kind: 'claude-subscription' }),
          promptFilePath: '/task/prompt.md',
        })
      ).toThrow(/does not support provider kind 'claude-subscription'/);
    });
  });

  // ---- H2 fix: pi's ollama config is built by jq inside the agent
  // container, reading the auth_token from $OLLAMA_AUTH_TOKEN. The
  // operator's actual token never appears in agent_command or in any
  // persisted artifact derived from it (meta.json, scheduler logs). ----
  describe('H2: ollama credential never inlined', () => {
    const SECRET = 'super-secret-bearer-zzz';

    it('agent_command references $OLLAMA_AUTH_TOKEN, not the literal token', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'pi' }),
        model: mkModel({ model_id: 'qwen2.5:7b' }),
        provider: mkProvider({
          kind: 'ollama',
          base_url: 'http://gpu:11434',
          auth_token: SECRET,
        }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain('OLLAMA_AUTH_TOKEN');
      expect(inv.agent_command).not.toContain(SECRET);
    });

    it('falls back to the "ollama" placeholder when no token is set', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'pi' }),
        model: mkModel({ model_id: 'qwen2.5:7b' }),
        provider: mkProvider({
          kind: 'ollama',
          base_url: 'http://gpu:11434',
          auth_token: null,
          api_key_env_var: null,
        }),
        promptFilePath: '/task/prompt.md',
      });
      // The shell parameter default `${OLLAMA_AUTH_TOKEN:-ollama}` is
      // what produces "ollama" at runtime when the env var is unset.
      expect(inv.agent_command).toContain(':-ollama');
    });
  });
});
