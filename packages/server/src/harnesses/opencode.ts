import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';
import { sq } from './shell.js';
import { assertOnlyKnownKeys, resolveContextWindow } from './config.js';

/** OpenCode CLI harness. The in-container `harness-cli.sh` bash-executes
 *  the agent_command.
 *
 *  Operator-tunable knobs (config_json): none for v1.
 *
 *  Provider-kind handling:
 *    - For cloud kinds (anthropic, openai, gemini, mistral, deepseek,
 *      openrouter): OpenCode auto-detects the standard env var
 *      (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) which the scheduler
 *      exports via buildProviderEnv. No config file is needed; the
 *      built-in provider defs handle routing.
 *    - For openai-compatible: OpenCode needs an explicit provider
 *      stanza because the URL is operator-specific and there's no
 *      built-in adapter for a self-hosted endpoint. The stanza points
 *      at OpenCode's generic `@ai-sdk/openai-compatible` npm provider.
 *      The config is built INSIDE the agent container at
 *      runtime by a `jq -n` step in agent_command, written to
 *      `/tmp/opencode.json`, and passed to OpenCode via `--config`.
 *      The orchestrator never writes any opencode.json — that's the
 *      key property for H3.
 *
 *  Why /tmp and not /repo (H3): the orchestrator-side bind mount is
 *  /repo, so anything written there persists into the workspace,
 *  worktree archives, salvage logs, and `git add -A` sweeps. The
 *  previous design wrote a sentinel value to /repo/opencode.json and
 *  rewrote it in-place with the real token at runtime — but the
 *  rewritten file still contained the live token on disk under /repo
 *  for the duration of the agent run. /tmp is a container-internal
 *  tmpfs that's torn down with the container, so the token never
 *  touches a persistent location.
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
    'openai-compatible',
  ] as const,
  buildInvocation({ profile, model, provider, promptFilePath }: HarnessInputs): HarnessInvocation {
    if (!opencodeHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `OpenCode harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${opencodeHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'.`
      );
    }
    // OpenCode expects `<provider>/<model>` form for the --model arg.
    const resolved_model = `${provider.kind}/${model.model_id}`;

    if (provider.kind === 'openai-compatible') {
      if (!provider.base_url) {
        throw new Error(
          `OpenAI-compatible provider '${provider.id}' has no base_url. ` +
          `Configure the server URL under Settings → Providers.`
        );
      }
      // Build /tmp/opencode.json at runtime via `jq -n`. All operator-
      // controlled strings go through `--arg` so jq handles escaping;
      // nothing is interpolated into the JSON template directly. The
      // `${OPENAI_COMPAT_AUTH_TOKEN:-ollama}` parameter expansion is
      // bash, run by the in-container shell BEFORE jq sees its argv, so
      // the env var resolves to either the operator's bearer token
      // (when set) or the literal "ollama" fallback — the exact
      // placeholder vanilla Ollama expects when no auth is configured,
      // and an arbitrary ignored string for every other server.
      const baseUrl = provider.base_url.replace(/\/+$/, '') + '/v1';
      // Optional per-model context window. OpenCode expresses it as
      // `limit: {context, output}` and its config schema requires BOTH
      // keys once `limit` is present — so `output` is emitted as 0, the
      // exact value OpenCode itself defaults to for a custom-provider
      // model with no limit block (see its provider.ts), and which its
      // maxOutputTokens() reads as "unset" and replaces with the built-in
      // cap. Setting only `context` is therefore behaviour-preserving for
      // output while enabling auto-compaction, which OpenCode disables
      // entirely while `limit.context` is 0. Left NULL, no `limit` key is
      // emitted at all and the config is byte-identical to before.
      const contextWindow = resolveContextWindow(model, 'OpenCode harness');
      const limitArg =
        contextWindow === null ? '' : `--argjson context_window ${contextWindow} `;
      const limitField =
        contextWindow === null ? '' : ',limit:{context:$context_window,output:0}';
      const writeConfig =
        `jq -n ` +
        `--arg token "\${OPENAI_COMPAT_AUTH_TOKEN:-ollama}" ` +
        `--arg provider ${sq(provider.kind)} ` +
        `--arg url ${sq(baseUrl)} ` +
        `--arg name ${sq(provider.display_name)} ` +
        `--arg model_id ${sq(model.model_id)} ` +
        `--arg model_name ${sq(model.display_name)} ` +
        limitArg +
        `'{provider:{($provider):{npm:"@ai-sdk/openai-compatible",name:$name,` +
        `options:{baseURL:$url,apiKey:$token},` +
        `models:{($model_id):{name:$model_name${limitField}}}}},` +
        `permission:{"*":"allow"}}' ` +
        `> /tmp/opencode.json`;
      return {
        agent_command:
          `${writeConfig} && ` +
          `opencode run "$(cat ${sq(promptFilePath)})" ` +
          `--config /tmp/opencode.json ` +
          `--model ${sq(resolved_model)} ` +
          `--format json --dangerously-skip-permissions --print-logs`,
        config_files: [],
        extra_env: {},
        resolved_model,
      };
    }

    // Cloud kinds — no config file, OpenCode picks up the standard env
    // var the scheduler exports plus its built-in provider definitions.
    // A model's `context_window` is deliberately not honoured here:
    // expressing it would mean synthesising a whole provider stanza to
    // override a built-in model whose real limits OpenCode already pulls
    // from models.dev. The field exists for self-hosted endpoints, where
    // no catalog knows the operator's --ctx-size.
    return {
      agent_command:
        `opencode run "$(cat ${sq(promptFilePath)})" ` +
        `--model ${sq(resolved_model)} ` +
        `--format json --dangerously-skip-permissions --print-logs`,
      config_files: [],
      extra_env: {},
      resolved_model,
    };
  },
  validateConfig(config_json: Record<string, unknown>): void {
    // No tunable knobs for v1 — reject anything to catch typos early.
    assertOnlyKnownKeys(config_json, [], 'opencode');
  },
};
