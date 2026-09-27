import type { HarnessId } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Harness smoke test: static checks. Each runs a short shell script inside
// the image under test and inspects its output — no model/API calls. Keyed
// by HarnessId as a Record so adding a harness without static checks is a
// compile error.
// ---------------------------------------------------------------------------

export interface StaticCheckSpec {
  name: string;
  /** Bash script run inside the image under test. */
  script: string;
  /** Needs network (only for pulling type-check tooling from npm). */
  network?: boolean;
  timeoutMs?: number;
  /** Which report version slot this check's output fills, if any. */
  version?: 'claude-code' | 'opencode' | 'pi' | 'claude-agent-sdk';
  evaluate(run: { exitCode: number | null; output: string }): StaticVerdict;
}

export type StaticVerdict =
  | { outcome: 'pass'; version?: string }
  | { outcome: 'fail' | 'skipped'; reason: string; detail?: string };

/** Flags each harness module puts on its CLI's command line. `extraFlags`
 *  are flags emitted only for some profiles (e.g. claude's `--effort`),
 *  added by the runner when a case would emit them. */
export const REQUIRED_FLAGS: Record<'claude-code' | 'opencode' | 'pi', string[]> = {
  'claude-code': [
    '--print',
    '--verbose',
    '--output-format',
    '--max-turns',
    '--model',
    '--dangerously-skip-permissions',
    '--bare',
  ],
  opencode: [
    '--model',
    '--format',
    '--print-logs',
    '--config',
    '--dangerously-skip-permissions',
  ],
  pi: ['-p', '--print', '--mode', '--no-session', '--model'],
};

/** Fields of pi's `models.json` that harnesses/pi.ts writes, checked
 *  against the installed `dist/core/model-config.d.ts`. */
export const PI_MODELS_JSON_FIELDS = [
  'baseUrl',
  'api',
  'apiKey',
  'compat',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'contextWindow',
];

/** `true` when `flag` appears as a whole token in help output. */
export function helpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, 'm').test(help);
}

/** `true` when a `.d.ts` declares `field` as a property. */
export function declaresField(dts: string, field: string): boolean {
  return new RegExp(`(^|[^\\w$])${field}\\??\\s*:`, 'm').test(dts);
}

function versionCheck(
  bin: string,
  slot: NonNullable<StaticCheckSpec['version']>
): StaticCheckSpec {
  return {
    name: 'version',
    script: `${bin} --version 2>&1`,
    version: slot,
    evaluate({ exitCode, output }) {
      const first = output.trim().split('\n')[0]?.trim() ?? '';
      if (exitCode === 127) return { outcome: 'fail', reason: 'cli_missing', detail: output };
      if (exitCode !== 0 || !first) {
        return { outcome: 'fail', reason: 'version_unreadable', detail: output };
      }
      return { outcome: 'pass', version: first };
    },
  };
}

function helpFlagsCheck(helpCommand: string, flags: string[]): StaticCheckSpec {
  return {
    name: 'help_flags',
    script: `${helpCommand} 2>&1`,
    evaluate({ exitCode, output }) {
      if (exitCode === 127) return { outcome: 'fail', reason: 'cli_missing', detail: output };
      if (exitCode === null) return { outcome: 'fail', reason: 'help_timeout' };
      const missing = flags.filter((f) => !helpHasFlag(output, f));
      if (missing.length > 0) {
        return {
          outcome: 'fail',
          reason: 'missing_flag',
          detail: `${helpCommand} does not list: ${missing.join(', ')}`,
        };
      }
      return { outcome: 'pass' };
    },
  };
}

/** Exit code the type-check script uses for "couldn't fetch the tooling"
 *  — an environment problem, reported as skipped rather than fail. */
const TOOLING_UNAVAILABLE_EXIT = 90;

/** Type-check `harness-sdk.ts` (as installed in the image) against the
 *  image's global @anthropic-ai/claude-agent-sdk. TypeScript itself isn't
 *  in the agent image, so it's pulled from npm into a temp dir. */
const SDK_TYPECHECK_SCRIPT = `
set -u
d=$(mktemp -d) && cd "$d" || exit ${TOOLING_UNAVAILABLE_EXIT}
g=$(npm root -g)
if [ ! -d "$g/@anthropic-ai/claude-agent-sdk" ]; then
  echo "@anthropic-ai/claude-agent-sdk is not installed globally"; exit 1
fi
echo '{"type":"module","private":true}' > package.json
if ! npm install --no-save --no-audit --no-fund --silent typescript@5 @types/node@22 > npm.log 2>&1; then
  tail -5 npm.log; exit ${TOOLING_UNAVAILABLE_EXIT}
fi
mkdir -p node_modules/@anthropic-ai
ln -s "$g/@anthropic-ai/claude-agent-sdk" node_modules/@anthropic-ai/claude-agent-sdk
cp /usr/local/bin/harness-sdk.ts .
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target es2022 \\
  --module nodenext --moduleResolution nodenext --types node harness-sdk.ts
`;

/** The static checks for each harness. `extraFlags` lets the runner add
 *  profile-dependent flags (see REQUIRED_FLAGS). */
export function staticChecksFor(
  harnessId: HarnessId,
  extraFlags: string[] = []
): StaticCheckSpec[] {
  return STATIC_CHECKS[harnessId](extraFlags);
}

const STATIC_CHECKS: Record<HarnessId, (extraFlags: string[]) => StaticCheckSpec[]> = {
  'claude-code': (extra) => [
    versionCheck('claude', 'claude-code'),
    helpFlagsCheck('claude --help', [...REQUIRED_FLAGS['claude-code'], ...extra]),
  ],
  opencode: (extra) => [
    versionCheck('opencode', 'opencode'),
    helpFlagsCheck('opencode run --help', [...REQUIRED_FLAGS.opencode, ...extra]),
  ],
  pi: (extra) => [
    versionCheck('pi', 'pi'),
    helpFlagsCheck('pi --help', [...REQUIRED_FLAGS.pi, ...extra]),
    {
      name: 'models_json_schema',
      script:
        'cat "$(npm root -g)/@earendil-works/pi-coding-agent/dist/core/model-config.d.ts" 2>&1',
      evaluate({ exitCode, output }) {
        if (exitCode !== 0) {
          return { outcome: 'fail', reason: 'schema_file_missing', detail: output };
        }
        const missing = PI_MODELS_JSON_FIELDS.filter((f) => !declaresField(output, f));
        if (missing.length > 0) {
          return {
            outcome: 'fail',
            reason: 'schema_field_missing',
            detail: `model-config.d.ts no longer declares: ${missing.join(', ')}`,
          };
        }
        return { outcome: 'pass' };
      },
    },
  ],
  'claude-sdk': () => [
    {
      name: 'version',
      script:
        'jq -r .version "$(npm root -g)/@anthropic-ai/claude-agent-sdk/package.json" 2>&1',
      version: 'claude-agent-sdk',
      evaluate({ exitCode, output }) {
        const v = output.trim();
        if (exitCode !== 0 || !v || v === 'null') {
          return { outcome: 'fail', reason: 'sdk_missing', detail: output };
        }
        return { outcome: 'pass', version: v };
      },
    },
    {
      name: 'typecheck',
      script: SDK_TYPECHECK_SCRIPT,
      network: true,
      timeoutMs: 5 * 60_000,
      evaluate({ exitCode, output }) {
        if (exitCode === 0) return { outcome: 'pass' };
        if (exitCode === null) {
          return { outcome: 'skipped', reason: 'typecheck_timeout' };
        }
        if (exitCode === TOOLING_UNAVAILABLE_EXIT) {
          return { outcome: 'skipped', reason: 'typecheck_tooling_unavailable', detail: output };
        }
        return { outcome: 'fail', reason: 'type_error', detail: output };
      },
    },
  ],
};
