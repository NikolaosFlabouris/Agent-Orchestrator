import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentProfile,
  HarnessId,
  Model,
  Provider,
  ProviderKind,
} from '@orchestrator/shared';
import { listHarnesses } from '../../harnesses/index.js';
import {
  buildCases,
  decideCost,
  findUncoveredHarnesses,
  isLocalHost,
  parseBuiltinConfig,
  type SmokeConfigSource,
} from '../../smoke/cases.js';
import {
  classifyLiveAttempt,
  computePromotable,
  countToolCalls,
  makeRedactor,
  type CaseResult,
  type LiveObservation,
  type StaticCheckResult,
} from '../../smoke/outcome.js';
import {
  REQUIRED_FLAGS,
  PI_MODELS_JSON_FIELDS,
  PROBE_SENTINEL_FLAG,
  declaresField,
  helpHasFlag,
  staticChecksFor,
} from '../../smoke/static-checks.js';
import {
  VERIFY_SCRIPT,
  preflightUrl,
  runSmoke,
  type AgentLaunchOptions,
  type RunInImageOptions,
  type SmokeDriver,
} from '../../smoke/runner.js';
import { runCli, parseArgs, EXIT_FAIL, EXIT_OK, EXIT_RUNNER_ERROR } from '../../smoke/cli.js';
import { initDatabase, openDatabaseReadOnly, getDb } from '../../db.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DUMMY_OAUTH = 'sk-ant-oat01-DUMMYSECRETVALUE-0123456789';
const DUMMY_LOCAL_TOKEN = 'local-bearer-dummy-7f3a9c';
const DUMMY_ANTHROPIC = 'dummy-anthropic-api-key-4242';

function provider(id: string, kind: ProviderKind, extra: Partial<Provider> = {}): Provider {
  return {
    id,
    display_name: id,
    kind,
    concurrency_limit: 1,
    base_url: null,
    api_key_env_var: null,
    auth_token: null,
    notes: null,
    ...extra,
  };
}

function model(id: number, providerId: string, modelId: string): Model {
  return { id, provider_id: providerId, model_id: modelId, display_name: modelId, context_window: null };
}

function profile(id: string, harness: HarnessId, modelPk: number, extra: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    display_name: id,
    harness_id: harness,
    model_pk: modelPk,
    config_json: {},
    timeout_minutes: 60,
    effort_level: null,
    ...extra,
  };
}

/** Mirrors the production setup described in the task. */
function productionLikeSource(overrides: { profiles?: AgentProfile[] } = {}): SmokeConfigSource {
  const providers = [
    provider('claude-subscription', 'claude-subscription', { auth_token: DUMMY_OAUTH }),
    provider('llama-swap-local', 'openai-compatible', {
      base_url: 'http://llama-swap:8080',
      auth_token: DUMMY_LOCAL_TOKEN,
    }),
    provider('anthropic', 'anthropic', { auth_token: DUMMY_ANTHROPIC }),
  ];
  const models = [
    model(1, 'claude-subscription', 'claude-haiku-4-5'),
    model(2, 'claude-subscription', 'claude-sonnet-5'),
    model(3, 'llama-swap-local', 'qwen3.6-35b-a3b-fast'),
    model(4, 'anthropic', 'claude-sonnet-5'),
  ];
  const profiles = overrides.profiles ?? [
    profile('claude-haiku', 'claude-code', 1),
    profile('claude-sonnet', 'claude-code', 2, { effort_level: 'high' }),
    profile('pi-local-qwen36-35b', 'pi', 3),
    profile('default-claude-sdk', 'claude-sdk', 4),
  ];
  return {
    listProfiles: () => profiles,
    getModel: (pk) => models.find((m) => m.id === pk),
    getProvider: (id) => providers.find((p) => p.id === id),
    getModelByProviderAndId: (pid, mid) =>
      models.find((m) => m.provider_id === pid && m.model_id === mid),
  };
}

const BUILTINS = [
  { harness_id: 'opencode', provider_id: 'llama-swap-local', model_id: 'qwen3.6-35b-a3b-fast' },
  { harness_id: 'pi', provider_id: 'llama-swap-local', model_id: 'qwen3.6-35b-a3b-fast' },
];

const ALL_HARNESSES = listHarnesses().map((h) => h.id);

// ---------------------------------------------------------------------------
// Cost rule
// ---------------------------------------------------------------------------

describe('decideCost', () => {
  it('live-tests claude-subscription', () => {
    expect(decideCost(provider('s', 'claude-subscription'))).toEqual({ live: true, route: 'subscription' });
  });

  it.each(['anthropic', 'openai', 'gemini', 'mistral', 'deepseek', 'openrouter'] as ProviderKind[])(
    'never live-tests pay-per-use kind %s',
    (kind) => {
      expect(decideCost(provider('p', kind))).toEqual({ live: false, reason: 'paid_provider' });
      // Even with a base_url that looks local.
      expect(decideCost(provider('p', kind, { base_url: 'http://127.0.0.1:1' }))).toEqual({
        live: false,
        reason: 'paid_provider',
      });
    }
  );

  it.each([
    'http://127.0.0.1:8080',
    'http://127.5.5.5',
    'http://localhost:11434',
    'http://[::1]:8080',
    'http://10.0.0.5:8080',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.1.20:8080/',
    'http://169.254.10.10',
    'http://[fe80::1]:8080',
    'http://host.docker.internal:8080',
    'http://llama-swap:8080',
    'http://ollama',
  ])('live-tests openai-compatible at local %s', (base_url) => {
    expect(decideCost(provider('l', 'openai-compatible', { base_url }))).toEqual({
      live: true,
      route: 'local',
    });
  });

  it.each([
    'https://api.together.xyz',
    'https://llm.example.com:8080',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://172.15.0.1',
    'http://11.0.0.1',
    'http://[2001:db8::1]',
    'not a url',
  ])('treats openai-compatible at non-local %s as paid', (base_url) => {
    expect(decideCost(provider('l', 'openai-compatible', { base_url }))).toEqual({
      live: false,
      reason: 'paid_provider',
    });
  });

  it('treats openai-compatible without a base_url as paid', () => {
    expect(decideCost(provider('l', 'openai-compatible'))).toEqual({ live: false, reason: 'paid_provider' });
  });

  it('isLocalHost handles trailing dots and case', () => {
    expect(isLocalHost('LLAMA-SWAP')).toBe(true);
    expect(isLocalHost('example.com.')).toBe(false);
    expect(isLocalHost('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case building, dedup, coverage
// ---------------------------------------------------------------------------

describe('buildCases', () => {
  it('builds a case per profile plus uncovered built-ins, deduplicating identical triples', () => {
    const cases = buildCases(productionLikeSource(), BUILTINS, ALL_HARNESSES);
    const keys = cases.map((c) => c.key);
    expect(keys).toEqual([
      'claude-code|claude-subscription|claude-haiku-4-5',
      'claude-code|claude-subscription|claude-sonnet-5',
      'pi|llama-swap-local|qwen3.6-35b-a3b-fast',
      'claude-sdk|anthropic|claude-sonnet-5',
      'opencode|llama-swap-local|qwen3.6-35b-a3b-fast',
    ]);
    const pi = cases.find((c) => c.harness_id === 'pi')!;
    expect(pi.sources).toEqual(['profile', 'builtin']);
    expect(pi.profile_ids).toEqual(['pi-local-qwen36-35b']);
    const oc = cases.find((c) => c.harness_id === 'opencode')!;
    expect(oc.sources).toEqual(['builtin']);
    expect(oc.profile?.harness_id).toBe('opencode');
    expect(oc.provider?.id).toBe('llama-swap-local');
  });

  it('merges two profiles with the same triple into one case', () => {
    const source = productionLikeSource({
      profiles: [profile('a', 'claude-code', 1), profile('b', 'claude-code', 1)],
    });
    const cases = buildCases(source, [], ALL_HARNESSES);
    expect(cases).toHaveLength(1);
    expect(cases[0].profile_ids).toEqual(['a', 'b']);
  });

  it('deduplicates repeated built-in entries', () => {
    const cases = buildCases(productionLikeSource({ profiles: [] }), [...BUILTINS, ...BUILTINS], ALL_HARNESSES);
    expect(cases.map((c) => c.key)).toEqual([
      'opencode|llama-swap-local|qwen3.6-35b-a3b-fast',
      'pi|llama-swap-local|qwen3.6-35b-a3b-fast',
    ]);
  });

  it('records a resolution error for a built-in whose provider or model is missing', () => {
    const cases = buildCases(
      productionLikeSource({ profiles: [] }),
      [
        { harness_id: 'pi', provider_id: 'nope', model_id: 'x' },
        { harness_id: 'pi', provider_id: 'llama-swap-local', model_id: 'missing' },
      ],
      ALL_HARNESSES
    );
    expect(cases[0].resolution_error).toMatch(/provider 'nope'/);
    expect(cases[1].resolution_error).toMatch(/model 'missing'/);
    expect(cases[1].provider).toBeUndefined();
  });

  it('rejects a built-in naming an unknown harness', () => {
    expect(() =>
      buildCases(productionLikeSource(), [{ harness_id: 'aider', provider_id: 'p', model_id: 'm' }], ALL_HARNESSES)
    ).toThrow(/unknown harness 'aider'/);
  });

  it('parseBuiltinConfig validates shape and the checked-in file parses', () => {
    expect(() => parseBuiltinConfig({})).toThrow(/cases/);
    expect(() => parseBuiltinConfig({ cases: [{ harness_id: 'pi' }] })).toThrow(/provider_id/);
    const file = path.join(__dirname, '../../scripts/harness-smoke.config.json');
    const parsed = parseBuiltinConfig(JSON.parse(fs.readFileSync(file, 'utf-8')));
    expect(parsed).toEqual(BUILTINS);
  });
});

describe('coverage rule', () => {
  it('is satisfied by the production-like setup', () => {
    const cases = buildCases(productionLikeSource(), BUILTINS, ALL_HARNESSES);
    expect(findUncoveredHarnesses(ALL_HARNESSES, cases)).toEqual([]);
  });

  it('names every harness without a case', () => {
    const cases = buildCases(
      productionLikeSource({ profiles: [profile('h', 'claude-code', 1)] }),
      [],
      ALL_HARNESSES
    );
    expect(findUncoveredHarnesses(ALL_HARNESSES, cases).sort()).toEqual(
      ['claude-sdk', 'opencode', 'pi'].sort()
    );
  });

  it('counts a static-only (paid) case as coverage', () => {
    const cases = buildCases(
      productionLikeSource({ profiles: [profile('sdk', 'claude-sdk', 4)] }),
      [],
      ALL_HARNESSES
    );
    expect(findUncoveredHarnesses(['claude-sdk'], cases)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

function obs(o: Partial<LiveObservation> = {}): LiveObservation {
  return {
    reachable: true,
    timedOut: false,
    overallDeadlineHit: false,
    localProvider: false,
    result: { status: 'success', error_message: null },
    log: '',
    fixVerified: true,
    toolCalls: 2,
    ...o,
  };
}

describe('classifyLiveAttempt', () => {
  it('passes on success + verified fix + tool calls', () => {
    expect(classifyLiveAttempt(obs())).toEqual({ outcome: 'pass', reason: null });
  });

  it('passes when the stream exposes no tool calls (null)', () => {
    expect(classifyLiveAttempt(obs({ toolCalls: null })).outcome).toBe('pass');
  });

  it('skips an unreachable provider', () => {
    expect(classifyLiveAttempt(obs({ reachable: false }))).toMatchObject({
      outcome: 'skipped',
      reason: 'provider_unreachable',
    });
  });

  it('skips on the harness usage-limit marker', () => {
    const log = '[harness 2026-09-27T00:00:00Z] Provider usage limit detected (agent exit 1) — waiting';
    expect(classifyLiveAttempt(obs({ log, result: null }))).toMatchObject({
      outcome: 'skipped',
      reason: 'usage_limit',
    });
  });

  it('skips on a Claude Code 429 result event', () => {
    const log = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: 'x' });
    expect(classifyLiveAttempt(obs({ log, result: null })).reason).toBe('usage_limit');
  });

  it('skips on a rate-limit error in result.json', () => {
    const r = classifyLiveAttempt(
      obs({ result: { status: 'failure', error_message: '[API 429] Rate limit exceeded' } })
    );
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'usage_limit' });
  });

  it('skips a timeout on a local model, fails it elsewhere', () => {
    expect(classifyLiveAttempt(obs({ timedOut: true, localProvider: true, result: null }))).toMatchObject({
      outcome: 'skipped',
      reason: 'local_model_timeout',
    });
    expect(classifyLiveAttempt(obs({ timedOut: true, result: null }))).toMatchObject({
      outcome: 'fail',
      reason: 'timeout',
    });
    expect(
      classifyLiveAttempt(obs({ localProvider: true, result: { status: 'timeout' } })).reason
    ).toBe('local_model_timeout');
  });

  it('skips when the overall deadline cut the attempt', () => {
    expect(classifyLiveAttempt(obs({ overallDeadlineHit: true, result: null }))).toMatchObject({
      outcome: 'skipped',
      reason: 'overall_timeout',
    });
  });

  it('fails a rejected model', () => {
    const r = classifyLiveAttempt(
      obs({
        result: {
          status: 'failure',
          error_message: '[API 404] model: claude-opus-5-5 is not supported by this version',
        },
      })
    );
    expect(r).toMatchObject({ outcome: 'fail', reason: 'result_failure' });
    expect(r.detail).toMatch(/claude-opus-5-5/);
  });

  it('fails when no result.json was written', () => {
    expect(classifyLiveAttempt(obs({ result: null })).reason).toBe('no_result');
  });

  it('fails a success whose fix does not verify (pi exit-0 case)', () => {
    expect(classifyLiveAttempt(obs({ fixVerified: false }))).toMatchObject({
      outcome: 'fail',
      reason: 'fix_not_verified',
    });
    expect(classifyLiveAttempt(obs({ fixVerified: null })).reason).toBe('fix_not_verified');
  });

  it('fails a success without any tool call', () => {
    expect(classifyLiveAttempt(obs({ toolCalls: 0 }))).toMatchObject({
      outcome: 'fail',
      reason: 'no_tool_calls',
    });
  });

  it('fails a launch error', () => {
    expect(classifyLiveAttempt(obs({ launchError: 'no such image' })).reason).toBe('launch_error');
  });
});

describe('countToolCalls', () => {
  it('reads each harness stream shape', () => {
    const claude = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text' }, { type: 'tool_use' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
    ].join('\n');
    expect(countToolCalls('claude-code', claude)).toBe(2);
    const opencode = `INFO some log line\n${JSON.stringify({ type: 'tool_use', part: {} })}\n{broken`;
    expect(countToolCalls('opencode', opencode)).toBe(1);
    const pi = [
      JSON.stringify({ type: 'tool_execution_start' }),
      JSON.stringify({ type: 'tool_execution_end' }),
    ].join('\n');
    expect(countToolCalls('pi', pi)).toBe(1);
    expect(countToolCalls('claude-sdk', claude)).toBeNull();
  });
});

describe('static check helpers', () => {
  it('helpHasFlag matches whole tokens only', () => {
    const help = '  -p, --print   Print\n  --model <m>\n  --no-session-x';
    expect(helpHasFlag(help, '-p')).toBe(true);
    expect(helpHasFlag(help, '--print')).toBe(true);
    expect(helpHasFlag(help, '--model')).toBe(true);
    expect(helpHasFlag(help, '--no-session')).toBe(false);
    expect(helpHasFlag(help, '--mode')).toBe(false);
  });

  it('hidden_flags passes only when the sentinel, not a hidden flag, is rejected', () => {
    const check = staticChecksFor('claude-code').find((c) => c.name === 'hidden_flags')!;
    expect(check.script).toBe(`claude --max-turns 1 ${PROBE_SENTINEL_FLAG} < /dev/null 2>&1`);
    expect(
      check.evaluate({ exitCode: 1, output: `error: unknown option '${PROBE_SENTINEL_FLAG}'\n` })
    ).toEqual({ outcome: 'pass' });
    expect(
      check.evaluate({ exitCode: 1, output: "error: unknown option '--max-turns'\n" })
    ).toMatchObject({ outcome: 'fail', reason: 'flag_rejected', detail: 'claude rejects: --max-turns' });
    expect(check.evaluate({ exitCode: 0, output: 'hello' })).toMatchObject({
      outcome: 'fail',
      reason: 'probe_inconclusive',
    });
    expect(check.evaluate({ exitCode: 127, output: 'not found' })).toMatchObject({
      reason: 'cli_missing',
    });
  });

  it('declaresField matches property declarations', () => {
    const dts = 'baseUrl?: string;\n  api: Api;\n  compat?: { supportsDeveloperRole?: boolean }';
    expect(declaresField(dts, 'baseUrl')).toBe(true);
    expect(declaresField(dts, 'api')).toBe(true);
    expect(declaresField(dts, 'supportsDeveloperRole')).toBe(true);
    expect(declaresField(dts, 'apiKey')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Promotable
// ---------------------------------------------------------------------------

function caseResult(o: Partial<CaseResult>): CaseResult {
  return {
    key: 'k',
    harness_id: 'claude-code',
    profile_ids: [],
    sources: ['profile'],
    provider_id: 'p',
    provider_kind: 'claude-subscription',
    model_id: 'm',
    live_eligible: true,
    outcome: 'pass',
    reason: null,
    error_excerpt: null,
    attempts: 1,
    duration_ms: 0,
    ...o,
  };
}

describe('computePromotable', () => {
  const paidSdk = caseResult({
    harness_id: 'claude-sdk',
    live_eligible: false,
    outcome: 'not_live_tested',
    reason: 'paid_provider',
  });

  it('is promotable with passes plus paid-only harnesses', () => {
    expect(computePromotable([caseResult({}), paidSdk], []).promotable).toBe(true);
  });

  it('a fail blocks it', () => {
    const r = computePromotable(
      [caseResult({}), caseResult({ key: 'k2', outcome: 'fail', reason: 'result_failure' })],
      []
    );
    expect(r.promotable).toBe(false);
    expect(r.blockers[0]).toMatch(/k2 failed/);
  });

  it('a static-check fail blocks it', () => {
    const s: StaticCheckResult = {
      harness_id: 'pi',
      check: 'help_flags',
      outcome: 'fail',
      reason: 'missing_flag',
      error_excerpt: null,
    };
    expect(computePromotable([caseResult({})], [s]).promotable).toBe(false);
  });

  it('skip-only results for a harness with a free route block it', () => {
    const r = computePromotable(
      [
        caseResult({}),
        caseResult({ harness_id: 'pi', outcome: 'skipped', reason: 'provider_unreachable' }),
      ],
      []
    );
    expect(r.promotable).toBe(false);
    expect(r.blockers).toEqual(['harness pi has a free route but no passing live case']);
  });

  it('a dead provider is outweighed by a passing built-in case for the same harness', () => {
    const r = computePromotable(
      [
        caseResult({}),
        caseResult({ key: 'pi|dead', harness_id: 'pi', outcome: 'skipped', reason: 'provider_unreachable' }),
        caseResult({ key: 'pi|builtin', harness_id: 'pi', sources: ['builtin'], outcome: 'pass' }),
      ],
      []
    );
    expect(r).toEqual({ promotable: true, blockers: [] });
  });
});

describe('preflightUrl', () => {
  it('probes the models endpoint without doubling /v1', () => {
    expect(preflightUrl({ kind: 'openai-compatible', base_url: 'http://llama-swap:8080' })).toBe(
      'http://llama-swap:8080/v1/models'
    );
    expect(preflightUrl({ kind: 'openai-compatible', base_url: 'http://llama-swap:8080/v1/' })).toBe(
      'http://llama-swap:8080/v1/models'
    );
    expect(preflightUrl({ kind: 'claude-subscription', base_url: null })).toBe('https://api.anthropic.com/');
    expect(preflightUrl({ kind: 'anthropic', base_url: null })).toBeNull();
  });
});

describe('makeRedactor', () => {
  it('strips known secrets and token shapes', () => {
    const r = makeRedactor(['my-secret-value']);
    expect(r('x my-secret-value y')).toBe('x [REDACTED] y');
    expect(r('key sk-ant-api03-abc_DEF-123')).toBe('key [REDACTED]');
    expect(r('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Runner end-to-end with a fake Docker layer
// ---------------------------------------------------------------------------

interface FakeDriverOptions {
  /** Provider base URLs (or api.anthropic.com) the preflight should fail. */
  unreachable?: string[];
  /** Per-harness scripted behaviour for each successive launch. */
  behaviour?: Partial<Record<HarnessId, Array<'fix' | 'no-fix' | 'model-error'>>>;
  missingFlags?: string[];
  /** Hidden flags the CLI rejects as unknown in the hidden_flags probe. */
  rejectedFlags?: string[];
}

function fakeDriver(o: FakeDriverOptions = {}) {
  const launches: AgentLaunchOptions[] = [];
  const runs: RunInImageOptions[] = [];
  const counters = new Map<string, number>();
  const driver: SmokeDriver = {
    async runInImage(opts) {
      runs.push(opts);
      const s = opts.script;
      const preflightUrl = opts.env?.find((e) => e.startsWith('SMOKE_PREFLIGHT_URL='))?.slice(20);
      if (preflightUrl !== undefined) {
        const dead = (o.unreachable ?? []).some((u) => preflightUrl.startsWith(u));
        return { exitCode: dead ? 7 : 0, output: dead ? 'curl: (7) Failed to connect' : '' };
      }
      if (s === VERIFY_SCRIPT) {
        const calc = await fsp.readFile(path.join(opts.repoDir!, 'calc.py'), 'utf-8');
        return { exitCode: calc.includes('a + b') ? 0 : 1, output: '' };
      }
      if (s.includes('--version')) return { exitCode: 0, output: `1.2.3 ${DUMMY_OAUTH}\n` };
      if (s.includes(PROBE_SENTINEL_FLAG)) {
        const rejected = o.rejectedFlags?.find((f) => s.includes(`${f} `)) ?? PROBE_SENTINEL_FLAG;
        return { exitCode: 1, output: `error: unknown option '${rejected}'\n` };
      }
      if (s.includes('--help')) {
        const all = [...Object.values(REQUIRED_FLAGS).flat(), '--effort'].filter(
          (f) => !(o.missingFlags ?? []).includes(f)
        );
        return { exitCode: 0, output: all.map((f) => `  ${f} <x>`).join('\n') };
      }
      if (s.includes('model-config.d.ts')) {
        return { exitCode: 0, output: PI_MODELS_JSON_FIELDS.map((f) => `${f}?: x;`).join('\n') };
      }
      if (s.includes('claude-agent-sdk/package.json')) return { exitCode: 0, output: '0.3.283\n' };
      if (s.includes('tsc')) return { exitCode: 0, output: '' };
      throw new Error(`unexpected script: ${s}`);
    },
    async launchAgent(opts) {
      launches.push(opts);
      const meta = JSON.parse(await fsp.readFile(path.join(opts.taskDir, 'meta.json'), 'utf-8'));
      const harness = meta.harness_id as HarnessId;
      const n = counters.get(harness) ?? 0;
      counters.set(harness, n + 1);
      const mode = o.behaviour?.[harness]?.[n] ?? 'fix';
      // The "agent" leaks every env var into its log — the runner must
      // keep them out of everything it emits.
      const leak = opts.env.join(' ');
      const events =
        harness === 'claude-code'
          ? [{ type: 'system', env: leak }, { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }]
          : harness === 'pi'
            ? [{ type: 'session', env: leak }, { type: 'tool_execution_start' }]
            : [{ type: 'step_start', env: leak }, { type: 'tool_use', part: {} }];
      if (mode === 'fix') {
        await fsp.writeFile(path.join(opts.workdir, 'calc.py'), 'def add(a, b):\n    return a + b\n');
      }
      await fsp.writeFile(
        path.join(opts.outputDir, 'progress.log'),
        events.map((e) => JSON.stringify(e)).join('\n') + '\n'
      );
      await fsp.writeFile(
        path.join(opts.outputDir, 'result.json'),
        JSON.stringify(
          mode === 'model-error'
            ? { status: 'failure', exit_code: 1, error_message: `model rejected; env was ${leak}` }
            : { status: 'success', exit_code: 0, error_message: null }
        )
      );
      return { wait: async () => 0, dispose: async () => undefined };
    },
  };
  return { driver, launches, runs };
}

describe('runSmoke / runCli', () => {
  let tmp: string;
  let out: string;
  let err: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'harness-smoke-'));
    await fsp.mkdir(path.join(tmp, 'workspaces'));
    await fsp.mkdir(path.join(tmp, 'caches'));
    out = '';
    err = '';
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  function deps(driver: SmokeDriver, source = productionLikeSource()) {
    return {
      harnesses: listHarnesses(),
      openConfigSource: () => source,
      prepareDocker: async () => driver,
      workspacesRoot: path.join(tmp, 'workspaces'),
      cachesRoot: path.join(tmp, 'caches'),
      stdout: (t: string) => (out += t),
      stderr: (t: string) => (err += t),
    };
  }

  it('runs the full matrix, never launches paid cases, cleans up and leaks no credential', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { driver, launches } = fakeDriver();
    const jsonPath = path.join(tmp, 'report.json');
    const code = await runCli(['--image', 'orchestrator-agent:candidate', '--json', jsonPath], deps(driver));
    expect(err).not.toMatch(/runner error/);
    expect(code).toBe(EXIT_OK);

    const report = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
    expect(report.promotable).toBe(true);
    expect(report.versions).toEqual({
      'claude-code': '1.2.3 [REDACTED]',
      opencode: '1.2.3 [REDACTED]',
      pi: '1.2.3 [REDACTED]',
      'claude-agent-sdk': '0.3.283',
    });
    const byKey = Object.fromEntries(report.cases.map((c: CaseResult) => [c.key, c]));
    expect(byKey['claude-sdk|anthropic|claude-sonnet-5']).toMatchObject({
      outcome: 'not_live_tested',
      reason: 'paid_provider',
      attempts: 0,
    });
    expect(byKey['claude-code|claude-subscription|claude-haiku-4-5'].outcome).toBe('pass');
    expect(byKey['pi|llama-swap-local|qwen3.6-35b-a3b-fast'].outcome).toBe('pass');
    expect(byKey['opencode|llama-swap-local|qwen3.6-35b-a3b-fast'].outcome).toBe('pass');

    // Only free routes were launched, and every launch used the image
    // under test and smoke labels (invisible to the reaper).
    expect(launches.map((l) => l.env.join(' '))).not.toContainEqual(expect.stringContaining(DUMMY_ANTHROPIC));
    expect(launches).toHaveLength(4);
    for (const l of launches) {
      expect(l.labels['managed-by']).toBe('orchestrator-smoke');
      expect(l.image).toBe('orchestrator-agent:candidate');
    }
    // The launch env is exactly what real tasks get.
    const claudeLaunch = launches.find((l) => l.env.some((e) => e.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')));
    expect(claudeLaunch?.env).toEqual([`CLAUDE_CODE_OAUTH_TOKEN=${DUMMY_OAUTH}`]);
    // meta.json follows the scheduler's shape; the effort profile's flag
    // made it into the static help check.
    expect(report.static_checks.every((s: StaticCheckResult) => s.outcome === 'pass')).toBe(true);

    // Throwaway workspaces and caches are gone.
    expect(await fsp.readdir(path.join(tmp, 'workspaces'))).toEqual([]);
    expect(await fsp.readdir(path.join(tmp, 'caches'))).toEqual([]);

    // No credential anywhere the runner writes.
    const raw = await fsp.readFile(jsonPath, 'utf-8');
    for (const secret of [DUMMY_OAUTH, DUMMY_LOCAL_TOKEN, DUMMY_ANTHROPIC]) {
      expect(raw).not.toContain(secret);
      expect(out).not.toContain(secret);
      expect(err).not.toContain(secret);
    }
    // No Forgejo (or any other) HTTP call from the runner process.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toMatch(/Promotable: yes/);
  });

  it('retries a failing live case once and redacts the failure excerpt', async () => {
    const { driver } = fakeDriver({ behaviour: { 'claude-code': ['model-error', 'model-error', 'model-error', 'fix'] } });
    const jsonPath = path.join(tmp, 'report.json');
    const code = await runCli(['--image', 'img', '--json', jsonPath], deps(driver));
    expect(code).toBe(EXIT_FAIL);
    const report = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
    const haiku = report.cases.find((c: CaseResult) => c.key.endsWith('claude-haiku-4-5'));
    expect(haiku).toMatchObject({ outcome: 'fail', reason: 'result_failure', attempts: 2 });
    expect(haiku.error_excerpt).toContain('[REDACTED]');
    expect(haiku.error_excerpt).not.toContain(DUMMY_OAUTH);
    // Second profile: failed once, passed on the retry.
    const sonnet = report.cases.find((c: CaseResult) => c.key.endsWith('claude-sonnet-5') && c.harness_id === 'claude-code');
    expect(sonnet).toMatchObject({ outcome: 'pass', attempts: 2 });
    expect(report.promotable).toBe(false);
    expect(out + err).not.toContain(DUMMY_OAUTH);
  });

  it('fails a success run whose fix did not land', async () => {
    const { driver } = fakeDriver({ behaviour: { pi: ['no-fix', 'no-fix'] } });
    const report = await runSmoke({
      image: 'img',
      cases: buildCases(productionLikeSource(), BUILTINS, ALL_HARNESSES),
      harnesses: listHarnesses(),
      driver,
      workspacesRoot: path.join(tmp, 'workspaces'),
      cachesRoot: path.join(tmp, 'caches'),
      caseTimeoutMs: 60_000,
      overallTimeoutMs: 600_000,
      progress: () => undefined,
    });
    const pi = report.cases.find((c) => c.harness_id === 'pi')!;
    expect(pi).toMatchObject({ outcome: 'fail', reason: 'fix_not_verified', attempts: 2 });
  });

  it('skips cases on an unreachable provider without launching; exit 0 but not promotable', async () => {
    const { driver, launches } = fakeDriver({ unreachable: ['http://llama-swap:8080'] });
    const jsonPath = path.join(tmp, 'report.json');
    const code = await runCli(['--image', 'img', '--json', jsonPath], deps(driver));
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
    const local = report.cases.filter((c: CaseResult) => c.provider_id === 'llama-swap-local');
    expect(local.map((c: CaseResult) => [c.outcome, c.reason])).toEqual([
      ['skipped', 'provider_unreachable'],
      ['skipped', 'provider_unreachable'],
    ]);
    expect(launches.every((l) => !l.env.some((e) => e.startsWith('OPENAI_COMPAT_AUTH_TOKEN')))).toBe(true);
    expect(report.promotable).toBe(false);
  });

  it('blocks promotion when a built-in case cannot be resolved', async () => {
    const { driver, launches } = fakeDriver();
    const base = productionLikeSource();
    // The built-in provider was renamed/deleted: its model no longer resolves.
    const source: SmokeConfigSource = {
      ...base,
      getModelByProviderAndId: (pid, mid) =>
        pid === 'llama-swap-local' ? undefined : base.getModelByProviderAndId(pid, mid),
    };
    const jsonPath = path.join(tmp, 'report.json');
    const code = await runCli(['--image', 'img', '--json', jsonPath], deps(driver, source));
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
    const opencode = report.cases.find((c: CaseResult) => c.harness_id === 'opencode');
    expect(opencode).toMatchObject({ outcome: 'skipped', reason: 'not_configured', live_eligible: true });
    expect(launches.some((l) => l.env.some((e) => e.startsWith('OPENAI_COMPAT')))).toBe(true); // pi profile still runs
    expect(report.promotable).toBe(false);
    expect(report.promotable_blockers).toContain('harness opencode has a free route but no passing live case');
  });

  it('fails a static check when a flag disappears from --help', async () => {
    const { driver } = fakeDriver({ missingFlags: ['--effort'] });
    const jsonPath = path.join(tmp, 'report.json');
    const code = await runCli(['--image', 'img', '--json', jsonPath], deps(driver));
    expect(code).toBe(EXIT_FAIL);
    const report = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
    const help = report.static_checks.find(
      (s: StaticCheckResult) => s.harness_id === 'claude-code' && s.check === 'help_flags'
    );
    expect(help).toMatchObject({ outcome: 'fail', reason: 'missing_flag' });
    expect(help.error_excerpt).toMatch(/--effort/);
  });

  it('fails a static check when the CLI rejects a hidden flag', async () => {
    const { driver } = fakeDriver({ rejectedFlags: ['--max-turns'] });
    const jsonPath = path.join(tmp, 'report.json');
    const code = await runCli(['--image', 'img', '--json', jsonPath], deps(driver));
    expect(code).toBe(EXIT_FAIL);
    const report = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
    const hidden = report.static_checks.find(
      (s: StaticCheckResult) => s.harness_id === 'claude-code' && s.check === 'hidden_flags'
    );
    expect(hidden).toMatchObject({ outcome: 'fail', reason: 'flag_rejected' });
    expect(hidden.error_excerpt).toMatch(/--max-turns/);
  });

  it('exits 2 naming an uncovered harness', async () => {
    const { driver, launches } = fakeDriver();
    const emptyConfig = path.join(tmp, 'cfg.json');
    await fsp.writeFile(emptyConfig, JSON.stringify({ cases: [] }));
    const code = await runCli(['--image', 'img', '--config', emptyConfig], deps(driver));
    expect(code).toBe(EXIT_RUNNER_ERROR);
    expect(err).toMatch(/no smoke case for harness\(es\): opencode/);
    expect(launches).toHaveLength(0);
  });

  it('exits 2 on bad arguments', async () => {
    const { driver } = fakeDriver();
    expect(await runCli([], deps(driver))).toBe(EXIT_RUNNER_ERROR);
    expect(await runCli(['--image'], deps(driver))).toBe(EXIT_RUNNER_ERROR);
    expect(await runCli(['--image', 'x', '--bogus', '1'], deps(driver))).toBe(EXIT_RUNNER_ERROR);
    expect(await runCli(['--image', 'x', '--case-timeout', '0'], deps(driver))).toBe(EXIT_RUNNER_ERROR);
  });

  it('parseArgs applies defaults and minute conversion', () => {
    expect(parseArgs(['--image', 'x', '--case-timeout', '2'], {})).toEqual({
      image: 'x',
      jsonPath: null,
      configPath: null,
      caseTimeoutMs: 120_000,
      overallTimeoutMs: 3_600_000,
      dbPath: '/data/orchestrator.db',
    });
  });
});

describe('openDatabaseReadOnly', () => {
  it('reads an existing DB and rejects every write', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'smoke-db-'));
    try {
      const file = path.join(dir, 'o.db');
      initDatabase(file).close();
      openDatabaseReadOnly(file);
      expect(() => getDb().prepare('SELECT COUNT(*) FROM tasks').get()).not.toThrow();
      expect(() => getDb().prepare('DELETE FROM attempts').run()).toThrow(/readonly/i);
      getDb().close();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
