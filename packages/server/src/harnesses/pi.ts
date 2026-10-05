import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';
import { sq } from './shell.js';
import {
  assertOnlyKnownKeys,
  resolveContextWindow,
  resolveEffortLevel,
} from './config.js';
import type { Provider, Model, ProviderKind } from '@orchestrator/shared';

/** Pi (pi-coding-agent) CLI harness. Bash-executed in the container.
 *
 *  Pi reads provider/model configuration from `~/.pi/agent/models.json`
 *  (in the agent's HOME), NOT from /repo. The orchestrator can only
 *  write files to /repo via the bind mount; it has no way to drop a
 *  file at /home/agent/... before the agent container starts. So Pi's
 *  config file is created at run-time by the agent_command itself —
 *  the command begins with a `jq -n` invocation that constructs the
 *  JSON and writes it to ~/.pi/agent/models.json.
 *
 *  Provider-kind handling:
 *    - Cloud kinds (anthropic, openai, gemini, mistral, deepseek,
 *      openrouter): pi has built-in provider definitions and reads
 *      the standard env var (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 *      GEMINI_API_KEY, …) which the scheduler exports via
 *      buildProviderEnv. The orchestrator writes a minimal models.json
 *      that declares the provider + model so pi recognises the
 *      `--model <pi-provider>/<model_id>` argument; no credential
 *      lives in the file.
 *    - For openai-compatible: pi has no built-in definition for a
 *      self-hosted endpoint, so the JSON declares a custom provider
 *      with the OpenAI-completions API, the URL and an apiKey. The
 *      apiKey value is sourced at runtime from
 *      `$OPENAI_COMPAT_AUTH_TOKEN` (orchestrator-exported) so the
 *      literal token never lives in agent_command / meta.json (H2).
 *
 *  Pi internal names vs orchestrator ProviderKind names — pi names its
 *  built-in Gemini provider "google" while reading GEMINI_API_KEY. All
 *  other cloud kinds use the same name on both sides. PI_PROVIDER_NAMES
 *  below is the canonical mapping; bumping it requires re-verifying
 *  against the pi package's own docs (`docs/providers.md` in
 *  @earendil-works/pi-coding-agent — its environment-variable table maps
 *  each env var to the provider name, e.g. GEMINI_API_KEY → `google`),
 *  which superseded the old pi-mono/packages/ai/src/env-api-keys.ts
 *  source reference when the project moved to github.com/earendil-works/pi.
 *
 *  Upstream version: verified against @earendil-works/pi-coding-agent
 *  1.0.x (1.0.3), which is what images/agent/Dockerfile installs. No
 *  harness change was needed coming from 0.87.x (nor from 0.84.x to
 *  0.87.x before that). Verified on 1.0.3:
 *    - CLI contract: `-p/--print` + `--mode json` + `--no-session`,
 *      `@<file>` prompt arguments (rejected only in `--mode rpc`), and
 *      `--model <provider>/<model_id>` resolution for models.json
 *      providers. Since 1.0.0 `--provider` without `--model` is an
 *      error; the harness never passes `--provider`.
 *    - models.json schema (`dist/core/model-config.d.ts`) still accepts
 *      every field written below: `baseUrl`, `api`, `apiKey`,
 *      `compat.supportsDeveloperRole`, `compat.supportsReasoningEffort`,
 *      `models[].id`, `models[].contextWindow`. The only schema change
 *      since 0.87.1 is the additive `samplingParamsByThinkingLevel`.
 *    - The generated agent_command against a stub openai-compatible
 *      server produces the same json-mode event sequence as 0.87.1
 *      (event types listed below), sends the same default tool set
 *      (read, bash, edit, write — the codemode / tool_search / MCP
 *      built-in extensions added in 0.99 are not enabled by default),
 *      and exits 0. An unreachable baseUrl still exits 0 with a final
 *      `agent_end` whose last message has `stopReason: "error"`, which
 *      harness-cli.sh's pi_terminal_error relies on.
 *    - Minimal cloud stanzas for `anthropic` and `google` still resolve
 *      (`--model google/<id>` reads GEMINI_API_KEY).
 *    - Breaking changes in 0.99–1.0.3 touch the TUI, extension/SDK and
 *      codemode APIs, MCP, and the Azure provider's name
 *      (`azure-openai-responses` → `azure`) — none of which the
 *      orchestrator uses. From 1.0.1 the npm package no longer ships
 *      npm-shrinkwrap.json, so transitive dependencies float on rebuild.
 *  Pi's json mode starts with a `session` header and emits an event
 *  stream (`agent_start` / `message_end` / `agent_end` /
 *  `agent_settled`). Since 0.87 the system prompt also appears as a
 *  `message_end` with `role: "system"`; harmless, since progress.log is
 *  only stored, not parsed. There is no Claude-Code-style
 *  `{"type":"result"}` line that harness-cli.sh sums usage from — so pi
 *  attempts leave the usage columns NULL, exactly as they did before the
 *  package rename. 0.87 also defaults `cacheWarming: "streaming"`: for
 *  models that declare a prompt-cache lifetime, pi may send cache-refresh
 *  requests when it estimates ≥ $0.05 saved. That never applies to
 *  openai-compatible (local) models; on cloud kinds it can add requests.
 *
 *  Operator-tunable knobs (config_json): none for v1.
 *
 *  Effort level: unsupported by design (see PI_EFFORT_LEVEL_REASON). Pi's
 *  `--thinking` flag would cover the cloud kinds, but it stays unwired
 *  until there's real usage to validate it against. `resolveEffortLevel`
 *  still runs so a level that slipped past the save-time check fails the
 *  launch instead of being silently dropped. */

const PI_EFFORT_LEVEL_REASON =
  'Pi configures openai-compatible providers with ' +
  'supportsReasoningEffort: false, and reasoning on a self-hosted server ' +
  'is fixed server-side (select a different model entry instead). The ' +
  'cloud-kind --thinking path is not wired yet.';

/** Map orchestrator ProviderKind → pi's internal provider name. Pi
 *  expects the `--model` argument in `<pi-name>/<model_id>` form and
 *  models.json uses the same name as a key, so both must agree. Only
 *  populated for the kinds the harness actually supports;
 *  openai-compatible is handled by a custom (non-built-in) provider
 *  stanza so it's not in this map. */
const PI_PROVIDER_NAMES: Partial<Record<ProviderKind, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  // Pi's built-in provider for Gemini is named "google" (it reads
  // GEMINI_API_KEY for that provider — see the environment-variable
  // table in pi's docs/providers.md). Keep this mapping aligned with
  // upstream if a future pi version renames it.
  gemini: 'google',
  mistral: 'mistral',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
};

export const piHarness: HarnessSpec = {
  id: 'pi',
  display_name: 'Pi CLI',
  runtime: 'cli',
  // Mirrors PI_PROVIDER_NAMES (cloud kinds) plus openai-compatible
  // (custom provider via models.json). claude-subscription is excluded
  // — pi's subscription path uses an interactive /login OAuth flow that
  // doesn't work in the sealed agent container.
  supported_provider_kinds: [
    'anthropic',
    'openai',
    'gemini',
    'mistral',
    'deepseek',
    'openrouter',
    'openai-compatible',
  ] as const,
  effortLevelSupport: () => ({
    supported: false,
    reason: PI_EFFORT_LEVEL_REASON,
  }),
  buildInvocation(inputs: HarnessInputs): HarnessInvocation {
    const { profile, model, provider, promptFilePath } = inputs;
    if (!piHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `Pi harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${piHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'.`
      );
    }
    resolveEffortLevel(piHarness, inputs);
    const piProviderName = piProviderNameFor(provider.kind);
    const resolved_model = `${piProviderName}/${model.model_id}`;
    const writeConfig = buildPiConfigWriteCommand(provider, model, piProviderName);
    const agent_command =
      `mkdir -p ~/.pi/agent && ${writeConfig} && ` +
      `pi -p --mode json --no-session --model ${sq(resolved_model)} @${sq(promptFilePath)}`;
    return {
      agent_command,
      config_files: [],
      extra_env: {},
      resolved_model,
    };
  },
  validateConfig(config_json: Record<string, unknown>): void {
    // No tunable knobs for v1 — reject anything to catch typos early.
    assertOnlyKnownKeys(config_json, [], 'pi');
  },
};

/** Resolve the pi-side provider name for a given orchestrator
 *  ProviderKind. For openai-compatible we hardcode the kind id itself
 *  (custom provider declared in models.json, not in
 *  PI_PROVIDER_NAMES); for everything else we read the map and throw if
 *  the kind isn't covered, which would indicate
 *  supported_provider_kinds drifted from the map without updating
 *  both. */
function piProviderNameFor(kind: ProviderKind): string {
  if (kind === 'openai-compatible') return 'openai-compatible';
  const name = PI_PROVIDER_NAMES[kind];
  if (!name) {
    throw new Error(
      `Pi harness: no provider-name mapping for kind '${kind}'. ` +
      `Update PI_PROVIDER_NAMES in pi.ts.`
    );
  }
  return name;
}

/** Build the shell snippet that writes `~/.pi/agent/models.json` at
 *  agent-container runtime. Uses `jq -n` to construct the JSON from
 *  jq variables — guarantees correct JSON escaping regardless of
 *  input contents. */
function buildPiConfigWriteCommand(
  provider: Provider,
  model: Model,
  piProviderName: string
): string {
  // Optional per-model `contextWindow`. Pi defaults to 128,000 and sizes
  // compaction off this number, so against a local server started with a
  // smaller --ctx-size the default silently overflows the server, and
  // against a larger one pi compacts long before it has to. When the
  // operator left the column NULL both fragments stay empty and the
  // generated file is byte-identical to the pre-column output.
  const contextWindow = resolveContextWindow(model, 'Pi harness');
  const ctxArg =
    contextWindow === null ? '' : `--argjson context_window ${contextWindow} `;
  const ctxField = contextWindow === null ? '' : ',contextWindow:$context_window';

  if (provider.kind === 'openai-compatible') {
    if (!provider.base_url) {
      throw new Error(
        `OpenAI-compatible provider '${provider.id}' has no base_url. ` +
        `Configure the server URL under Settings → Providers.`
      );
    }
    const baseUrl = provider.base_url.replace(/\/+$/, '') + '/v1';
    // `${OPENAI_COMPAT_AUTH_TOKEN:-ollama}` falls back to the literal
    // "ollama" when the env var is unset: that exact string is the
    // no-auth placeholder vanilla Ollama expects, and every other
    // OpenAI-compatible server that ignores auth accepts it too, so an
    // unauthenticated local endpoint works with no credential
    // configured.
    return (
      `jq -n ` +
      `--arg token "\${OPENAI_COMPAT_AUTH_TOKEN:-ollama}" ` +
      `--arg provider ${sq(piProviderName)} ` +
      `--arg url ${sq(baseUrl)} ` +
      `--arg model_id ${sq(model.model_id)} ` +
      ctxArg +
      `'{providers:{($provider):{baseUrl:$url,api:"openai-completions",apiKey:$token,` +
      `compat:{supportsDeveloperRole:false,supportsReasoningEffort:false},` +
      `models:[{id:$model_id${ctxField}}]}}}' ` +
      `> ~/.pi/agent/models.json`
    );
  }

  // Cloud kinds: minimal stanza declaring the built-in provider name
  // and the model. Pi reads the standard env var the scheduler exports
  // (per ProviderKindSpec.container_env_name) for the actual credential.
  // The provider key is quoted in the jq filter so multi-word pi names
  // (none today, but a hedge against future additions like
  // "google-vertex") parse correctly.
  return (
    `jq -n ` +
    `--arg provider ${sq(piProviderName)} ` +
    `--arg model_id ${sq(model.model_id)} ` +
    ctxArg +
    `'{providers:{($provider):{models:[{id:$model_id${ctxField}}]}}}' ` +
    `> ~/.pi/agent/models.json`
  );
}
