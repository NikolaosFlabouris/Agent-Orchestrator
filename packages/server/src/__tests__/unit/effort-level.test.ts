import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses } from '../../harnesses/index.js';
import {
  EFFORT_LEVELS,
  type AgentProfile,
  type EffortLevel,
  type HarnessId,
  type Model,
  type Provider,
  type ProviderKind,
} from '@orchestrator/shared';

/** Orchestrator-managed effort level (#196). One stored value on the
 *  profile, a shared resolver (`resolveEffortLevel`), per-harness
 *  translation — and NULL must reproduce the pre-feature invocation
 *  byte for byte. */

function mkInputs(
  harness_id: HarnessId,
  kind: ProviderKind,
  effort_level: EffortLevel | null
): {
  profile: AgentProfile;
  model: Model;
  provider: Provider;
  promptFilePath: string;
} {
  return {
    profile: {
      id: 'pf',
      display_name: 'Profile',
      harness_id,
      model_pk: 1,
      config_json: {},
      timeout_minutes: 120,
      effort_level,
    },
    model: {
      id: 1,
      provider_id: 'p',
      model_id: 'm-1',
      display_name: 'M',
      context_window: null,
    },
    provider: {
      id: 'p',
      display_name: 'P',
      kind,
      concurrency_limit: 5,
      base_url: kind === 'openai-compatible' ? 'http://192.168.1.10:11434' : null,
      auth_token: null,
      api_key_env_var: null,
      notes: null,
    },
    promptFilePath: '/task/prompt.md',
  };
}

// Captured verbatim from the harnesses on main, before effort_level existed.
// A NULL effort level must keep producing exactly these objects — no new
// flags, no new keys (`effort_level` is absent, not null).
const PRE_FEATURE_INVOCATIONS: Record<string, unknown> = {
  'claude-code/anthropic': {
    agent_command: "claude --print --verbose --bare --dangerously-skip-permissions --output-format stream-json --max-turns 100 --model 'm-1' < '/task/prompt.md'",
    config_files: [],
    extra_env: {},
    resolved_model: "m-1",
  },
  'claude-code/claude-subscription': {
    agent_command: "claude --print --verbose --dangerously-skip-permissions --output-format stream-json --max-turns 100 --model 'm-1' < '/task/prompt.md'",
    config_files: [],
    extra_env: {},
    resolved_model: "m-1",
  },
  'claude-sdk/anthropic': {
    agent_command: null,
    config_files: [],
    extra_env: {},
    resolved_model: "m-1",
  },
  'opencode/anthropic': {
    agent_command: "opencode run \"$(cat '/task/prompt.md')\" --model 'anthropic/m-1' --format json --auto --print-logs",
    config_files: [],
    extra_env: {},
    resolved_model: "anthropic/m-1",
  },
  'opencode/openai-compatible': {
    agent_command: "jq -n --arg token \"${OPENAI_COMPAT_AUTH_TOKEN:-ollama}\" --arg provider 'openai-compatible' --arg url 'http://192.168.1.10:11434/v1' --arg name 'P' --arg model_id 'm-1' --arg model_name 'M' '{provider:{($provider):{npm:\"@ai-sdk/openai-compatible\",name:$name,options:{baseURL:$url,apiKey:$token},models:{($model_id):{name:$model_name}}}},permission:{\"*\":\"allow\"}}' > /tmp/opencode.json && OPENCODE_CONFIG=/tmp/opencode.json opencode run \"$(cat '/task/prompt.md')\" --model 'openai-compatible/m-1' --format json --auto --print-logs",
    config_files: [],
    extra_env: {},
    resolved_model: "openai-compatible/m-1",
  },
  'pi/anthropic': {
    agent_command: "mkdir -p ~/.pi/agent && jq -n --arg provider 'anthropic' --arg model_id 'm-1' '{providers:{($provider):{models:[{id:$model_id}]}}}' > ~/.pi/agent/models.json && pi -p --mode json --no-session --model 'anthropic/m-1' @'/task/prompt.md'",
    config_files: [],
    extra_env: {},
    resolved_model: "anthropic/m-1",
  },
  'pi/openai-compatible': {
    agent_command: "mkdir -p ~/.pi/agent && jq -n --arg token \"${OPENAI_COMPAT_AUTH_TOKEN:-ollama}\" --arg provider 'openai-compatible' --arg url 'http://192.168.1.10:11434/v1' --arg model_id 'm-1' '{providers:{($provider):{baseUrl:$url,api:\"openai-completions\",apiKey:$token,compat:{supportsDeveloperRole:false,supportsReasoningEffort:false},models:[{id:$model_id}]}}}' > ~/.pi/agent/models.json && pi -p --mode json --no-session --model 'openai-compatible/m-1' @'/task/prompt.md'",
    config_files: [],
    extra_env: {},
    resolved_model: "openai-compatible/m-1",
  },
};

describe('effort_level NULL is byte-identical to the pre-feature invocation', () => {
  for (const [key, expected] of Object.entries(PRE_FEATURE_INVOCATIONS)) {
    const [harnessId, kind] = key.split('/') as [HarnessId, ProviderKind];
    it(key, () => {
      const inv = getHarness(harnessId).buildInvocation(
        mkInputs(harnessId, kind, null)
      );
      expect(inv).toStrictEqual(expected);
      expect(JSON.stringify(inv)).toBe(JSON.stringify(expected));
      expect('effort_level' in inv).toBe(false);
    });
  }

  it('covers all four harnesses', () => {
    const covered = new Set(
      Object.keys(PRE_FEATURE_INVOCATIONS).map((k) => k.split('/')[0])
    );
    expect([...covered].sort()).toEqual(
      listHarnesses().map((h) => h.id).sort()
    );
  });
});

describe('claude-code effort level', () => {
  const h = getHarness('claude-code');

  for (const kind of ['anthropic', 'claude-subscription'] as const) {
    it(`appends --effort for every level on ${kind}`, () => {
      for (const level of EFFORT_LEVELS) {
        const inv = h.buildInvocation(mkInputs('claude-code', kind, level));
        expect(inv.agent_command).toContain(`--max-turns 100 --effort ${level} --model 'm-1'`);
        expect(inv.effort_level).toBe(level);
      }
    });
  }

  it('produces exactly the pre-feature command plus --effort high', () => {
    const inv = h.buildInvocation(mkInputs('claude-code', 'anthropic', 'high'));
    expect(inv.agent_command).toBe(
      "claude --print --verbose --bare --dangerously-skip-permissions " +
        "--output-format stream-json --max-turns 100 --effort high " +
        "--model 'm-1' < '/task/prompt.md'"
    );
  });
});

describe('claude-sdk effort level', () => {
  const h = getHarness('claude-sdk');

  it('carries the level on the invocation for meta.effort_level', () => {
    const inv = h.buildInvocation(mkInputs('claude-sdk', 'anthropic', 'high'));
    expect(inv.agent_command).toBeNull();
    expect(inv.effort_level).toBe('high');
    expect(inv.resolved_model).toBe('m-1');
  });
});

describe('effortLevelSupport declarations', () => {
  it('claude-code and claude-sdk support every provider kind they target', () => {
    for (const id of ['claude-code', 'claude-sdk'] as const) {
      const spec = getHarness(id);
      for (const kind of spec.supported_provider_kinds) {
        expect(spec.effortLevelSupport(kind)).toEqual({ supported: true });
      }
    }
  });

  it('opencode declares it unsupported with the --variant reason', () => {
    const spec = getHarness('opencode');
    for (const kind of spec.supported_provider_kinds) {
      const s = spec.effortLevelSupport(kind);
      expect(s.supported).toBe(false);
      if (s.supported) return;
      expect(s.reason).toMatch(/--variant/);
      expect(s.reason).toMatch(/openai-compatible/);
    }
  });

  it('pi declares it unsupported with the supportsReasoningEffort reason', () => {
    const spec = getHarness('pi');
    for (const kind of spec.supported_provider_kinds) {
      const s = spec.effortLevelSupport(kind);
      expect(s.supported).toBe(false);
      if (s.supported) return;
      expect(s.reason).toMatch(/supportsReasoningEffort: false/);
      expect(s.reason).toMatch(/--thinking/);
    }
  });
});

describe('launch-time effort level gate (resolveEffortLevel)', () => {
  for (const [id, kind] of [
    ['opencode', 'anthropic'],
    ['opencode', 'openai-compatible'],
    ['pi', 'anthropic'],
    ['pi', 'openai-compatible'],
  ] as const) {
    it(`${id} on ${kind} throws with the reason and the offending ids`, () => {
      const spec = getHarness(id);
      const reason = (
        spec.effortLevelSupport(kind) as { supported: false; reason: string }
      ).reason;
      expect(() =>
        spec.buildInvocation(mkInputs(id, kind, 'high'))
      ).toThrow(
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `does not support an effort level.*` +
                `${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*` +
                `Profile 'pf' uses model 'm-1' on provider 'p'`
            )
          ),
        })
      );
    });
  }

  it('rejects a hand-edited value outside EFFORT_LEVELS', () => {
    const inputs = mkInputs('claude-code', 'anthropic', null);
    inputs.profile.effort_level = 'extreme' as EffortLevel;
    expect(() => getHarness('claude-code').buildInvocation(inputs)).toThrow(
      /profile 'pf' has an invalid effort_level \("extreme"\)/
    );
  });

  it('never lets an unvalidated value reach the command line', () => {
    const inputs = mkInputs('claude-code', 'anthropic', null);
    inputs.profile.effort_level = 'high; rm -rf /' as EffortLevel;
    expect(() => getHarness('claude-code').buildInvocation(inputs)).toThrow(
      /invalid effort_level/
    );
  });
});
