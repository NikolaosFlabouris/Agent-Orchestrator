/** Shared helpers for per-harness `validateConfig` implementations and
 *  for reading operator-supplied model fields into generated configs. */

import { EFFORT_LEVELS } from '@orchestrator/shared';
import type { EffortLevel, Model } from '@orchestrator/shared';
import type { HarnessInputs, HarnessSpec } from './types.js';

/** Read `models.context_window` for embedding in a harness-generated
 *  config. Returns null when the operator left it unset, in which case
 *  the caller must emit exactly the config it emitted before the column
 *  existed and let the harness apply its own default.
 *
 *  The value reaches generated command strings as a bare (unquoted) JSON
 *  number, so it is re-validated here rather than trusted from the row:
 *  the POST/PATCH routes already reject anything that isn't a positive
 *  integer, but a hand-edited DB is not bound by that. A bad value fails
 *  loudly at launch instead of producing a malformed command line. */
export function resolveContextWindow(
  model: Model,
  harnessDisplayName: string
): number | null {
  const raw = model.context_window;
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `${harnessDisplayName}: model '${model.model_id}' has an invalid ` +
        `context_window (${String(raw)}). It must be a positive integer, ` +
        `or NULL to use the harness default.`
    );
  }
  return raw;
}

/** Read `agent_profiles.effort_level` for translation into a harness's
 *  invocation. Returns null when the operator left it unset, in which case
 *  the caller must emit exactly the invocation it emitted before the
 *  column existed and let the harness apply its own default.
 *
 *  Like `resolveContextWindow`, the stored value is re-validated rather
 *  than trusted: it reaches command lines unquoted, and a hand-edited DB
 *  isn't bound by the save-time checks. This is also the launch-time gate
 *  for `effortLevelSupport` — a level set on an unsupported harness/
 *  provider pair (hand edit, or a provider whose kind changed) throws here
 *  instead of being silently ignored. Every harness calls it, including
 *  the ones that support no level at all. */
export function resolveEffortLevel(
  harness: HarnessSpec,
  { profile, model, provider }: HarnessInputs
): EffortLevel | null {
  const raw = profile.effort_level;
  if (raw === null || raw === undefined) return null;
  if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(
      `${harness.display_name}: profile '${profile.id}' has an invalid ` +
        `effort_level (${JSON.stringify(raw)}). It must be one of ` +
        `${EFFORT_LEVELS.join(', ')}, or NULL to use the harness default.`
    );
  }
  const support = harness.effortLevelSupport(provider.kind);
  if (!support.supported) {
    throw new Error(
      `${harness.display_name} does not support an effort level on provider ` +
        `kind '${provider.kind}': ${support.reason} ` +
        `Profile '${profile.id}' uses model '${model.model_id}' on provider ` +
        `'${provider.id}' with effort_level '${raw}'; clear it to launch.`
    );
  }
  return raw;
}

/** Reject any operator-supplied config_json key not in the harness's
 *  declared schema. Catches camelCase typos (`maxTurns` vs `max_turns`)
 *  that would otherwise silently fall back to defaults — same severity
 *  as a misspelled flag in a launch config. Pass `allowed` as the
 *  canonical set of keys this harness understands. Pass an empty array
 *  for harnesses with no operator-tunable knobs. */
export function assertOnlyKnownKeys(
  config_json: Record<string, unknown>,
  allowed: readonly string[],
  harnessDisplayName: string
): void {
  const unknown = Object.keys(config_json).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return;
  throw new Error(
    `${harnessDisplayName}: unknown config key(s): ${unknown.join(', ')}. ` +
      `Known keys: ${allowed.length === 0 ? '(none)' : allowed.join(', ')}.`
  );
}
