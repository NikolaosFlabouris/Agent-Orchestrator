import type {
  HarnessSpec,
  HarnessInputs,
  HarnessInvocation,
  HarnessConfigFile,
} from './types.js';
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
 *      provider.base_url) and a placeholder apiKey since OpenCode's
 *      schema requires the field. The orchestrator-side `auth_token` (if
 *      set) is passed through as well.
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
    const resolved_model = `${provider.kind === 'ollama' ? 'ollama' : provider.kind}/${model.model_id}`;
    return {
      agent_command:
        `opencode run "$(cat ${promptFilePath})" ` +
        `--model ${resolved_model} ` +
        `--format json --dangerously-skip-permissions --print-logs`,
      config_files: configFiles,
      extra_env: {},
      resolved_model,
    };
  },
};

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
    // apiKey is required by the schema but ignored by Ollama unless the
    // operator's setup has front-door auth (auth_token).
    return {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: provider.display_name,
          options: {
            baseURL: provider.base_url.replace(/\/+$/, '') + '/v1',
            ...(provider.auth_token ? { apiKey: provider.auth_token } : { apiKey: 'ollama' }),
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
