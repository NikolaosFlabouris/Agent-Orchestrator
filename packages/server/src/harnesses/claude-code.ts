import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';

/** Claude Code CLI harness. The in-container `harness-cli.sh` script
 *  bash-executes the agent_command produced here. Auth comes from the
 *  provider-derived env var the scheduler exports (ANTHROPIC_API_KEY for
 *  the `anthropic` kind, CLAUDE_CODE_OAUTH_TOKEN for the
 *  `claude-subscription` kind — both names the binary natively reads).
 *
 *  Operator-tunable knobs (config_json):
 *    - `max_turns: number` (default 100) — passed as `--max-turns N`.
 *      Must be a positive integer.
 *
 *  Notes:
 *    - `--bare -p` skips OAuth/keychain reads/CLAUDE.md loading/MCP
 *      discovery, forcing the binary to read the API key from env. This
 *      is required for headless container runs.
 *    - `--print --verbose --output-format stream-json` produces the
 *      machine-readable event stream the harness's progress.log
 *      consumer expects. */
export const claudeCodeHarness: HarnessSpec = {
  id: 'claude-code',
  display_name: 'Claude Code CLI',
  runtime: 'cli',
  supported_provider_kinds: ['anthropic', 'claude-subscription'] as const,
  buildInvocation({ profile, model, provider, promptFilePath }: HarnessInputs): HarnessInvocation {
    if (!claudeCodeHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `Claude Code harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${claudeCodeHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'.`
      );
    }
    const maxTurns = readPositiveInt(profile.config_json, 'max_turns', 100);
    return {
      agent_command:
        `claude --print --verbose --bare -p ` +
        `--dangerously-skip-permissions ` +
        `--output-format stream-json ` +
        `--max-turns ${maxTurns} ` +
        `--model ${model.model_id} < ${promptFilePath}`,
      config_files: [],
      extra_env: {},
      resolved_model: model.model_id,
    };
  },
  validateConfig(config_json: Record<string, unknown>): void {
    if ('max_turns' in config_json) {
      const v = config_json.max_turns;
      if (!Number.isInteger(v) || (v as number) < 1) {
        throw new Error('max_turns must be a positive integer');
      }
    }
  },
};

function readPositiveInt(
  cfg: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const v = cfg[key];
  return Number.isInteger(v) && (v as number) > 0 ? (v as number) : fallback;
}
