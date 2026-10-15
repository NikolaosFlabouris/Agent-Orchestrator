import type { HarnessSpec, HarnessInputs, HarnessInvocation } from './types.js';
import { sq } from './shell.js';
import { assertOnlyKnownKeys, resolveEffortLevel } from './config.js';

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
 *    - The command is the same for both provider kinds; only the auth
 *      env var differs. The CLI reads ANTHROPIC_API_KEY without any
 *      flag (`apiKeySource: "ANTHROPIC_API_KEY"` in its init event).
 *    - No `--bare`. It used to be added for `anthropic` (API key) runs,
 *      for determinism and to skip CLAUDE.md / keychain / MCP lookups
 *      (it can't be used for `claude-subscription`, because it also
 *      disables the OAuth path that reads CLAUDE_CODE_OAUTH_TOKEN). On
 *      Claude Code 2.1.301 it also cuts the toolset to Bash, Edit and
 *      Read (3 tools vs 24 — no Write, Task, WebFetch/WebSearch or
 *      Skill), sets CLAUDE_CODE_SIMPLE=1 and skips the repo's CLAUDE.md,
 *      so API-key runs were far weaker agents than subscription runs of
 *      the same model. The repos are the operator's own and the agent
 *      runs their code under --dangerously-skip-permissions anyway, so
 *      skipping CLAUDE.md bought no real isolation, and the ephemeral
 *      container has no user settings or keychain to make lookups
 *      non-deterministic. Without the flag the CLI loads the repo's
 *      CLAUDE.md and .claude/settings.json, keeps auto-memory in the
 *      throwaway HOME and adds commit attribution — exactly what the
 *      subscription runs have always done.
 *    - `--print --verbose --output-format stream-json` produces the
 *      machine-readable event stream the harness's progress.log
 *      consumer expects.
 *    - `profile.effort_level` maps 1:1 onto `--effort <level>` (the CLI
 *      accepts exactly EFFORT_LEVELS) on both provider kinds. Unset →
 *      no flag, and the command is byte-identical to before. */
export const claudeCodeHarness: HarnessSpec = {
  id: 'claude-code',
  display_name: 'Claude Code CLI',
  runtime: 'cli',
  supported_provider_kinds: ['anthropic', 'claude-subscription'] as const,
  effortLevelSupport: () => ({ supported: true }),
  buildInvocation(inputs: HarnessInputs): HarnessInvocation {
    const { profile, model, provider, promptFilePath } = inputs;
    if (!claudeCodeHarness.supported_provider_kinds.includes(provider.kind)) {
      throw new Error(
        `Claude Code harness does not support provider kind '${provider.kind}'. ` +
        `Supported: ${claudeCodeHarness.supported_provider_kinds.join(', ')}. ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider '${provider.id}'.`
      );
    }
    const maxTurns = readPositiveInt(profile.config_json, 'max_turns', 100);
    // Validated against EFFORT_LEVELS by the resolver, so safe to inline.
    const effortLevel = resolveEffortLevel(claudeCodeHarness, inputs);
    const effortFlag = effortLevel === null ? '' : `--effort ${effortLevel} `;
    // `maxTurns` is an integer-validated value so it can be inlined
    // safely. `model.model_id` and `promptFilePath` are quoted via `sq`
    // because both are external/operator-derived inputs.
    return {
      agent_command:
        `claude --print --verbose ` +
        `--dangerously-skip-permissions ` +
        `--output-format stream-json ` +
        `--max-turns ${maxTurns} ` +
        effortFlag +
        `--model ${sq(model.model_id)} < ${sq(promptFilePath)}`,
      config_files: [],
      extra_env: {},
      resolved_model: model.model_id,
      ...(effortLevel === null ? {} : { effort_level: effortLevel }),
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
