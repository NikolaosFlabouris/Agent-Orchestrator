/** Shared helpers for per-harness `validateConfig` implementations and
 *  for reading operator-supplied model fields into generated configs. */

import type { Model } from '@orchestrator/shared';

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
