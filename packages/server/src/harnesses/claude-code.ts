import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';
import { sq } from './shell.js';
import { assertOnlyKnownKeys } from './config.js';

const CLAUDE_CODE_CONFIG_KEYS = ['max_turns'] as const;

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
 *    - `--bare` skips OAuth/keychain reads, CLAUDE.md loading, and MCP
 *      discovery. In an ephemeral agent container with no keychain, no
 *      saved login, no project-local CLAUDE.md the orchestrator
 *      controls, and no MCP setup, every one of those lookups is
 *      either a guaranteed miss or a prompt-injection vector via repo
 *      contents. `--bare` makes the run deterministic and depend only
 *      on env vars + flags + stdin.
 *    - But `--bare` ALSO disables the OAuth code path the CLI uses to
 *      read CLAUDE_CODE_OAUTH_TOKEN. For `claude-subscription`
 *      providers the orchestrator authenticates via that token, so
 *      `--bare` must NOT be set in that case. The flag is therefore
 *      conditional on `provider.kind`:
 *         - `anthropic` (API key) → `--bare` ON  (deterministic +
 *           reads ANTHROPIC_API_KEY from env)
 *         - `claude-subscription` (OAuth) → `--bare` OFF (OAuth path
 *           active so CLAUDE_CODE_OAUTH_TOKEN is honored)
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
    // See header comment: --bare is the sealed-container default but
    // it disables OAuth-token reads, so subscription auth needs it
    // off. Anthropic-API-key runs keep it on for determinism.
    const bareFlag = provider.kind === 'anthropic' ? '--bare ' : '';
    // `maxTurns` is an integer-validated value so it can be inlined
    // safely. `model.model_id` and `promptFilePath` are quoted via `sq`
    // because both are external/operator-derived inputs.
    return {
      agent_command:
        `claude --print --verbose ${bareFlag}` +
        `--dangerously-skip-permissions ` +
        `--output-format stream-json ` +
        `--max-turns ${maxTurns} ` +
        `--model ${sq(model.model_id)} < ${sq(promptFilePath)}`,
      config_files: [],
      extra_env: {},
      resolved_model: model.model_id,
    };
  },
  validateConfig(config_json: Record<string, unknown>): void {
    assertOnlyKnownKeys(config_json, CLAUDE_CODE_CONFIG_KEYS, 'claude-code');
    if ('max_turns' in config_json) {
      const v = config_json.max_turns;
      if (!Number.isInteger(v) || (v as number) < 1) {
        throw new Error('max_turns must be a positive integer');
      }
      // Sanity cap. A real run rarely needs more than a few hundred
      // turns; a misplaced extra zero would otherwise mask a real bug
      // until the wall-clock timeout kicks in hours later.
      if ((v as number) > 10000) {
        throw new Error('max_turns must be <= 10000');
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
