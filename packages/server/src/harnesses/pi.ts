import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';
import { sq } from './shell.js';
import { assertOnlyKnownKeys, resolveContextWindow } from './config.js';
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
 *  against the provider table in the pi package's own docs
 *  (`docs/providers.md` in @earendil-works/pi-coding-agent — the
 *  "auth.json key" column is the provider name), which superseded the
 *  old pi-mono/packages/ai/src/env-api-keys.ts source reference when
 *  the project moved to github.com/earendil-works/pi.
 *
 *  Upstream version: verified against @earendil-works/pi-coding-agent
 *  0.84.x, which is what images/agent/Dockerfile installs. Still current
 *  there: `-p/--print` + `--mode json` + `--no-session`, `@<file>` prompt
 *  arguments (rejected only in `--mode rpc`), `<provider>/<model_id>`
 *  resolution for custom models.json providers, and the models.json
 *  fields written below (`baseUrl`, `api`, `apiKey`, `compat`,
 *  `models[].id`, `models[].contextWindow`). Pi's json mode emits an
 *  event stream (`agent_start` / `message_end` / `agent_end`), not the
 *  Claude-Code-style `{"type":"result"}` line that harness-cli.sh sums
 *  usage from — so pi attempts leave the usage columns NULL, exactly as
 *  they did before the package rename.
 *
 *  Operator-tunable knobs (config_json): none for v1. */

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
  // GEMINI_API_KEY internally for that provider — see pi-mono's
  // env-api-keys.ts). Keep this mapping aligned with the upstream
  // source if a future pi version renames it.
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
  buildInvocation({ profile, model, provider, promptFilePath }: HarnessInputs): HarnessInvocation {
    if (!piHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `Pi harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${piHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'.`
      );
    }
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
