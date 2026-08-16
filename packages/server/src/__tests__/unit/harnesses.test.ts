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
    context_window: null,
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
        provider: mkProvider({
          kind: 'openai-compatible',
          base_url: 'http://localhost:11434',
        }),
        promptFilePath: '/task/prompt.md',
      })
    ).toThrow(/does not support provider kind 'openai-compatible'/);
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

  it('builds opencode.json at runtime in /tmp for openai-compatible providers (H3)', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'opencode' }),
      model: mkModel({ model_id: 'qwen2.5-coder:14b' }),
      provider: mkProvider({
        kind: 'openai-compatible',
        base_url: 'http://192.168.1.10:11434',
        api_key_env_var: null,
      }),
      promptFilePath: '/task/prompt.md',
    });
    // H3: orchestrator never writes a config file (would land under
    // /repo via the bind mount and persist into worktree archives).
    expect(inv.config_files).toEqual([]);
    // The agent_command builds the JSON at runtime in /tmp via jq -n.
    expect(inv.agent_command).toContain('jq -n');
    expect(inv.agent_command).toContain('/tmp/opencode.json');
    expect(inv.agent_command).not.toContain('/repo/opencode.json');
    // OpenCode is pointed at the /tmp file via --config.
    expect(inv.agent_command).toContain('--config /tmp/opencode.json');
    // The base_url and model id reach the config via jq --arg, not
    // direct shell interpolation.
    expect(inv.agent_command).toContain('http://192.168.1.10:11434/v1');
    expect(inv.agent_command).toContain('qwen2.5-coder:14b');
    expect(inv.resolved_model).toBe('openai-compatible/qwen2.5-coder:14b');
  });

  it('throws for openai-compatible providers without base_url', () => {
    expect(() =>
      h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel(),
        provider: mkProvider({ kind: 'openai-compatible', base_url: null }),
        promptFilePath: '/task/prompt.md',
      })
    ).toThrow(/base_url/);
  });

  // ---- Optional per-model context window. OpenCode's config schema
  // requires both keys of `limit` once the object is present, so the
  // harness pairs the operator's context with `output: 0` — OpenCode's
  // own default, which its maxOutputTokens() reads as "unset". ----
  describe('context_window', () => {
    const selfHosted = () =>
      mkProvider({
        kind: 'openai-compatible',
        base_url: 'http://192.168.1.10:11434',
        api_key_env_var: null,
      });

    it('emits the exact pre-column command when context_window is null', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({
          model_id: 'qwen2.5-coder:14b',
          display_name: 'Qwen',
          context_window: null,
        }),
        provider: selfHosted(),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toBe(
        "jq -n " +
          "--arg token \"${OPENAI_COMPAT_AUTH_TOKEN:-ollama}\" " +
          "--arg provider 'openai-compatible' " +
          "--arg url 'http://192.168.1.10:11434/v1' " +
          "--arg name 'P' " +
          "--arg model_id 'qwen2.5-coder:14b' " +
          "--arg model_name 'Qwen' " +
          "'{provider:{($provider):{npm:\"@ai-sdk/openai-compatible\",name:$name," +
          "options:{baseURL:$url,apiKey:$token}," +
          "models:{($model_id):{name:$model_name}}}}," +
          "permission:{\"*\":\"allow\"}}' " +
          "> /tmp/opencode.json && " +
          "opencode run \"$(cat '/task/prompt.md')\" " +
          "--config /tmp/opencode.json " +
          "--model 'openai-compatible/qwen2.5-coder:14b' " +
          "--format json --dangerously-skip-permissions --print-logs"
      );
      expect(inv.agent_command).not.toContain('limit');
      expect(inv.agent_command).not.toContain('--argjson');
    });

    it('writes limit.context (with output 0) into the model entry when set', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({ model_id: 'qwen2.5-coder:14b', context_window: 32768 }),
        provider: selfHosted(),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain('--argjson context_window 32768');
      expect(inv.agent_command).toContain(
        'models:{($model_id):{name:$model_name,limit:{context:$context_window,output:0}}}'
      );
    });

    it('emits no config file at all for cloud kinds, context window or not', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({ context_window: 200000 }),
        provider: mkProvider({ kind: 'anthropic' }),
        promptFilePath: '/task/prompt.md',
      });
      // OpenCode reads the built-in model's real limits from models.dev;
      // the orchestrator does not synthesise an override stanza for it.
      expect(inv.agent_command).not.toContain('jq');
      expect(inv.agent_command).not.toContain('limit');
      expect(inv.config_files).toEqual([]);
    });

    it('rejects a non-integer context_window from a hand-edited row', () => {
      expect(() =>
        h.buildInvocation({
          profile: mkProfile({ harness_id: 'opencode' }),
          model: mkModel({
            model_id: 'qwen2.5-coder:14b',
            context_window: 0 as unknown as number,
          }),
          provider: selfHosted(),
          promptFilePath: '/task/prompt.md',
        })
      ).toThrow(/invalid context_window/);
    });
  });

  // ---- H3 fix: the self-hosted auth_token never lands on disk in
  // /repo (previously the runtime jq+mv rewrote /repo/opencode.json
  // with the real token; now agent_command builds /tmp/opencode.json
  // from scratch using $OPENAI_COMPAT_AUTH_TOKEN at runtime). The
  // orchestrator emits no config file at all, so nothing the agent
  // could later archive contains the literal token. ----
  describe('H3: openai-compatible credential never written under /repo', () => {
    const SECRET = 'super-secret-bearer-zzz';

    it('emits no orchestrator-written config file', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({ model_id: 'qwen2.5-coder:14b' }),
        provider: mkProvider({
          kind: 'openai-compatible',
          base_url: 'http://192.168.1.10:11434',
          auth_token: SECRET,
        }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.config_files).toEqual([]);
    });

    it('agent_command references $OPENAI_COMPAT_AUTH_TOKEN, not the literal token, and writes to /tmp', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({ model_id: 'qwen2.5-coder:14b' }),
        provider: mkProvider({
          kind: 'openai-compatible',
          base_url: 'http://192.168.1.10:11434',
          auth_token: SECRET,
        }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain('OPENAI_COMPAT_AUTH_TOKEN');
      expect(inv.agent_command).toContain('/tmp/opencode.json');
      expect(inv.agent_command).not.toContain('/repo/opencode.json');
      expect(inv.agent_command).not.toContain(SECRET);
    });

    it('falls back to the "ollama" placeholder when no token is set', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel({ model_id: 'qwen2.5-coder:14b' }),
        provider: mkProvider({
          kind: 'openai-compatible',
          base_url: 'http://192.168.1.10:11434',
          auth_token: null,
          api_key_env_var: null,
        }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain(':-ollama');
    });

    it('skips the jq step for cloud providers', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'opencode' }),
        model: mkModel(),
        provider: mkProvider({ kind: 'anthropic' }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).not.toContain('jq');
      expect(inv.agent_command).not.toContain('OPENAI_COMPAT_AUTH_TOKEN');
      expect(inv.agent_command).not.toContain('/tmp/opencode.json');
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

  it('builds an openai-compatible-targeted models.json via jq', () => {
    const inv = h.buildInvocation({
      profile: mkProfile({ harness_id: 'pi' }),
      model: mkModel({ model_id: 'qwen2.5:7b' }),
      provider: mkProvider({
        kind: 'openai-compatible',
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
    expect(inv.resolved_model).toBe('openai-compatible/qwen2.5:7b');
  });

  // ---- Optional per-model context window. Pi defaults to 128,000 and
  // sizes compaction off `contextWindow`, so a local server started with
  // a smaller --ctx-size silently overflows and a larger one compacts
  // early. NULL must reproduce the pre-column output byte for byte. ----
  describe('context_window', () => {
    const selfHosted = () =>
      mkProvider({
        kind: 'openai-compatible',
        base_url: 'http://gpu:11434',
        api_key_env_var: null,
      });

    it('emits the exact pre-column command when context_window is null', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'pi' }),
        model: mkModel({ model_id: 'qwen2.5:7b', context_window: null }),
        provider: selfHosted(),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toBe(
        "mkdir -p ~/.pi/agent && jq -n " +
          "--arg token \"${OPENAI_COMPAT_AUTH_TOKEN:-ollama}\" " +
          "--arg provider 'openai-compatible' " +
          "--arg url 'http://gpu:11434/v1' " +
          "--arg model_id 'qwen2.5:7b' " +
          "'{providers:{($provider):{baseUrl:$url,api:\"openai-completions\",apiKey:$token," +
          "compat:{supportsDeveloperRole:false,supportsReasoningEffort:false}," +
          "models:[{id:$model_id}]}}}' " +
          "> ~/.pi/agent/models.json && " +
          "pi -p --mode json --no-session --model 'openai-compatible/qwen2.5:7b' @'/task/prompt.md'"
      );
      // Nothing context-window-shaped leaks in when the column is unset.
      expect(inv.agent_command).not.toContain('contextWindow');
      expect(inv.agent_command).not.toContain('--argjson');
    });

    it('writes contextWindow into the model entry when set', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'pi' }),
        model: mkModel({ model_id: 'qwen2.5:7b', context_window: 32768 }),
        provider: selfHosted(),
        promptFilePath: '/task/prompt.md',
      });
      // --argjson (not --arg) so jq emits a JSON number, not a string.
      expect(inv.agent_command).toContain('--argjson context_window 32768');
      expect(inv.agent_command).toContain(
        'models:[{id:$model_id,contextWindow:$context_window}]'
      );
    });

    it('honours context_window on cloud kinds too', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'pi' }),
        model: mkModel({ model_id: 'some-model-id', context_window: 200000 }),
        provider: mkProvider({ kind: 'anthropic' }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain('--argjson context_window 200000');
      expect(inv.agent_command).toContain(
        "'{providers:{($provider):{models:[{id:$model_id,contextWindow:$context_window}]}}}'"
      );
    });

    it('rejects a non-integer context_window from a hand-edited row', () => {
      expect(() =>
        h.buildInvocation({
          profile: mkProfile({ harness_id: 'pi' }),
          model: mkModel({
            model_id: 'qwen2.5:7b',
            // Route validation rejects this shape; a direct DB edit is
            // not bound by it, and the value reaches the command line
            // unquoted.
            context_window: '32768; rm -rf /' as unknown as number,
          }),
          provider: selfHosted(),
          promptFilePath: '/task/prompt.md',
        })
      ).toThrow(/invalid context_window/);
    });
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
        // No self-hosted-only fields leak into cloud-kind config.
        expect(inv.agent_command).not.toContain('baseUrl');
        expect(inv.agent_command).not.toContain('OPENAI_COMPAT_AUTH_TOKEN');
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

  // ---- H2 fix: pi's openai-compatible config is built by jq inside
  // the agent container, reading the auth_token from
  // $OPENAI_COMPAT_AUTH_TOKEN. The operator's actual token never
  // appears in agent_command or in any persisted artifact derived from
  // it (meta.json, scheduler logs). ----
  describe('H2: openai-compatible credential never inlined', () => {
    const SECRET = 'super-secret-bearer-zzz';

    it('agent_command references $OPENAI_COMPAT_AUTH_TOKEN, not the literal token', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'pi' }),
        model: mkModel({ model_id: 'qwen2.5:7b' }),
        provider: mkProvider({
          kind: 'openai-compatible',
          base_url: 'http://gpu:11434',
          auth_token: SECRET,
        }),
        promptFilePath: '/task/prompt.md',
      });
      expect(inv.agent_command).toContain('OPENAI_COMPAT_AUTH_TOKEN');
      expect(inv.agent_command).not.toContain(SECRET);
    });

    it('falls back to the "ollama" placeholder when no token is set', () => {
      const inv = h.buildInvocation({
        profile: mkProfile({ harness_id: 'pi' }),
        model: mkModel({ model_id: 'qwen2.5:7b' }),
        provider: mkProvider({
          kind: 'openai-compatible',
          base_url: 'http://gpu:11434',
          auth_token: null,
          api_key_env_var: null,
        }),
        promptFilePath: '/task/prompt.md',
      });
      // The shell parameter default `${OPENAI_COMPAT_AUTH_TOKEN:-ollama}`
      // is what produces "ollama" at runtime when the env var is unset.
      // Vanilla Ollama expects that exact placeholder string.
      expect(inv.agent_command).toContain(':-ollama');
    });
  });
});
