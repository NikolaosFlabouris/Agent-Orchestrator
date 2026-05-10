import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';

/** Claude Agent SDK harness. Programmatic streaming via the TypeScript
 *  SDK; the in-container `harness-sdk.ts` script reads the model from
 *  `meta.model` and authenticates via `ANTHROPIC_API_KEY` from the
 *  environment.
 *
 *  Operator-tunable knobs (config_json schema): none for v1. The form
 *  component is a no-op placeholder. If we add knobs later (e.g.
 *  `permission_mode`), they go here, in the matching React form, and in
 *  `validateConfig`. */
export const claudeSdkHarness: HarnessSpec = {
  id: 'claude-sdk',
  display_name: 'Claude SDK',
  runtime: 'sdk',
  supported_provider_kinds: ['anthropic'] as const,
  buildInvocation({ profile, model, provider }: HarnessInputs): HarnessInvocation {
    if (!claudeSdkHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `Claude SDK harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${claudeSdkHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'. ` +
        `Reconfigure the profile to use a compatible provider.`
      );
    }
    return {
      agent_command: null,
      config_files: [],
      extra_env: {},
      // Claude SDK accepts the bare model id (no `<provider>/...` prefix).
      resolved_model: model.model_id,
    };
  },
};
