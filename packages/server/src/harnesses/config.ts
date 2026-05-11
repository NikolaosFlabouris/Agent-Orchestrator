/** Shared helpers for per-harness `validateConfig` implementations. */

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
