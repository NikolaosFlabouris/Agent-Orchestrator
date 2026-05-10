import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';
import type { Provider, Model } from '@orchestrator/shared';

/** Pi (pi-coding-agent) CLI harness. Bash-executed in the container.
 *
 *  Pi reads provider/model configuration from `~/.pi/agent/models.json`
 *  (in the agent's HOME), NOT from /repo. The orchestrator can only
 *  write files to /repo via the bind mount; it has no way to drop a
 *  file at /home/agent/... before the agent container starts. So Pi's
 *  config file is created at run-time by the agent_command itself —
 *  the command begins with a mkdir + printf that lays the file down
 *  before invoking pi.
 *
 *  This keeps the HarnessInvocation contract clean: `config_files` only
 *  carries /repo-bound files; non-/repo paths are the harness's
 *  responsibility to bootstrap from its command.
 *
 *  Operator-tunable knobs (config_json): none for v1. */
export const piHarness: HarnessSpec = {
  id: 'pi',
  display_name: 'Pi CLI',
  runtime: 'cli',
  supported_provider_kinds: ['anthropic', 'ollama'] as const,
  buildInvocation({ profile, model, provider, promptFilePath }: HarnessInputs): HarnessInvocation {
    if (!piHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `Pi harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${piHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'.`
      );
    }
    const piProvider = provider.kind === 'ollama' ? 'ollama' : 'anthropic';
    const resolved_model = `${piProvider}/${model.model_id}`;
    const modelsJson = JSON.stringify(buildPiModelsJson(provider, model));
    // Single-quote-wrapped printf '%s' arg so JSON's double quotes don't
    // need escaping. The shell sees only the single-quoted literal.
    const escaped = modelsJson.replace(/'/g, `'\\''`);
    const agent_command =
      `mkdir -p ~/.pi/agent && printf '%s' '${escaped}' > ~/.pi/agent/models.json && ` +
      `pi -p --mode json --no-session --model ${resolved_model} @${promptFilePath}`;
    return {
      agent_command,
      config_files: [],
      extra_env: {},
      resolved_model,
    };
  },
};

function buildPiModelsJson(
  provider: Provider,
  model: Model
): Record<string, unknown> {
  if (provider.kind === 'ollama') {
    if (!provider.base_url) {
      throw new Error(
        `Ollama provider '${provider.id}' has no base_url. ` +
        `Configure the Ollama server URL under Settings → Providers.`
      );
    }
    return {
      providers: {
        ollama: {
          baseUrl: provider.base_url.replace(/\/+$/, '') + '/v1',
          api: 'openai-completions',
          // pi's schema requires apiKey; Ollama ignores unless front-door auth.
          apiKey: provider.auth_token ?? 'ollama',
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{ id: model.model_id }],
        },
      },
    };
  }
  // Anthropic: minimal entry; pi reads ANTHROPIC_API_KEY from env. We
  // emit the file anyway so pi's startup doesn't complain about a
  // missing config in the no-session container.
  return {
    providers: {
      anthropic: {
        models: [{ id: model.model_id }],
      },
    },
  };
}
