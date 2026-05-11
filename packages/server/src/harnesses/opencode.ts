import type {
  HarnessSpec,
  HarnessInputs,
  HarnessInvocation,
  HarnessConfigFile,
} from './types.js';
import { sq } from './shell.js';
import { assertOnlyKnownKeys } from './config.js';
import type { Provider, Model } from '@orchestrator/shared';

/** OpenCode CLI harness. The in-container `harness-cli.sh` bash-executes
 *  the agent_command. OpenCode reads its provider configuration from
 *  `/repo/opencode.json`; the harness generates that file from the
 *  resolved (provider, model) so operators never write JSON by hand.
 *
 *  Operator-tunable knobs (config_json): none for v1.
 *
 *  Provider-kind handling:
 *    - For cloud kinds (anthropic, openai, gemini, mistral, deepseek,
 *      openrouter): OpenCode reads the provider's standard env var
 *      (which the scheduler exports). The opencode.json declares which
 *      provider+model the binary should use; no URL/credential lives in
 *      the file.
 *    - For ollama: opencode.json declares the Ollama URL (from
 *      provider.base_url) and a sentinel apiKey value. The agent
 *      container substitutes the sentinel with `$OLLAMA_AUTH_TOKEN`
 *      at run-time (via jq) before launching the binary, so the
 *      operator's actual token never lives in the on-disk
 *      `/repo/opencode.json` (which would otherwise be visible to the
 *      agent's working tree, salvage logs, and worktree archives —
 *      H2b).
 *
 *  Output format: --format json + --print-logs gives the machine-
 *  readable event stream + log capture the harness expects. */
export const opencodeHarness: HarnessSpec = {
  id: 'opencode',
  display_name: 'OpenCode CLI',
  runtime: 'cli',
  supported_provider_kinds: [
    'anthropic',
    'openai',
    'gemini',
    'mistral',
    'deepseek',
    'openrouter',
    'ollama',
  ] as const,
  buildInvocation({ profile, model, provider, promptFilePath }: HarnessInputs): HarnessInvocation {
    if (!opencodeHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `OpenCode harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${opencodeHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'.`
      );
    }
    const configFiles: HarnessConfigFile[] = [];
    const opencodeConfig = buildOpencodeConfig(provider, model);
    if (opencodeConfig) {
      configFiles.push({
        path: '/repo/opencode.json',
        content: JSON.stringify(opencodeConfig, null, 2),
      });
    }
    // OpenCode expects `<provider>/<model>` form for the --model arg.
    const resolved_model = `${provider.kind}/${model.model_id}`;
    // For Ollama, prepend a jq step that swaps the sentinel apiKey in
    // /repo/opencode.json with the runtime value of OLLAMA_AUTH_TOKEN
    // (or the literal "ollama" placeholder when no token is set).
    // jq's `--arg` handles arbitrary string content safely. The
    // temp-file + mv pattern keeps the rewrite atomic so a crashed
    // launch can't leave the file half-written.
    const tokenSubstitution =
      provider.kind === 'ollama'
        ? `jq --arg token "\${OLLAMA_AUTH_TOKEN:-ollama}" ` +
          `'.provider.ollama.options.apiKey = $token' ` +
          `/repo/opencode.json > /repo/opencode.json.tmp && ` +
          `mv /repo/opencode.json.tmp /repo/opencode.json && `
        : '';
    // `model.model_id` and `promptFilePath` are external/operator-derived
    // strings — quote both for safe shell interpolation. The provider
    // kind is enum-validated so it doesn't need quoting on its own, but
    // the combined `resolved_model` ends up containing the model id, so
    // we quote the whole composite.
    return {
      agent_command:
        tokenSubstitution +
        `opencode run "$(cat ${sq(promptFilePath)})" ` +
        `--model ${sq(resolved_model)} ` +
        `--format json --dangerously-skip-permissions --print-logs`,
      config_files: configFiles,
      extra_env: {},
      resolved_model,
    };
  },
  validateConfig(config_json: Record<string, unknown>): void {
    // No tunable knobs for v1 — reject anything to catch typos early.
    assertOnlyKnownKeys(config_json, [], 'opencode');
  },
};

/** Sentinel value the orchestrator writes into the apiKey slot of the
 *  emitted /repo/opencode.json. The agent_command's first step swaps
 *  this for the runtime value of $OLLAMA_AUTH_TOKEN. The literal
 *  Ollama token NEVER appears in the file the orchestrator writes,
 *  which keeps it out of repo-side artifacts, salvage logs, and
 *  worktree archives. Should the runtime substitution somehow be
 *  skipped, opencode would fail with a recognizable auth error rather
 *  than silently leaking the placeholder. */
export const OLLAMA_TOKEN_SENTINEL = '__OLLAMA_AUTH_TOKEN_PLACEHOLDER__';

/** Build an opencode.json config object for the given provider+model.
 *  Returns null when the cloud-kind path is sufficient (OpenCode auto-
 *  detects the standard env vars and built-in provider defs). For Ollama
 *  we always emit the file because the URL is operator-specific. */
function buildOpencodeConfig(
  provider: Provider,
  model: Model
): Record<string, unknown> | null {
  if (provider.kind === 'ollama') {
    if (!provider.base_url) {
      throw new Error(
        `Ollama provider '${provider.id}' has no base_url. ` +
        `Configure the Ollama server URL under Settings → Providers.`
      );
    }
    // OpenCode talks to Ollama via its OpenAI-compatible /v1 endpoint.
    // apiKey is required by the schema; the value here is a sentinel
    // that agent_command rewrites at run-time using $OLLAMA_AUTH_TOKEN
    // (or "ollama" if unset). Keeps the actual credential out of the
    // file the orchestrator writes to disk.
    return {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: provider.display_name,
          options: {
            baseURL: provider.base_url.replace(/\/+$/, '') + '/v1',
            apiKey: OLLAMA_TOKEN_SENTINEL,
          },
          models: { [model.model_id]: { name: model.display_name } },
        },
      },
      permission: { '*': 'allow' },
    };
  }
  // For cloud kinds, OpenCode auto-detects the standard env var the
  // scheduler exports (ANTHROPIC_API_KEY etc.) and uses its built-in
  // provider definitions. No config file needed.
  return null;
}
