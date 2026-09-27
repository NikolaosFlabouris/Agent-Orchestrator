import type { HarnessSpec, ProviderKind } from '../../api.js';

/** Why the "Effort level" select in the Agent Profiles form is disabled,
 *  or null when it's usable.
 *
 *  Support is declared per (harness, provider kind), so with a model
 *  picked the answer is that model's provider kind. With no model picked
 *  yet, the select is disabled only if every kind the harness targets is
 *  unsupported (opencode and pi today) — otherwise it stays enabled and
 *  the server's save-time check has the final word.
 *
 *  Kept as a pure function (no React) so it's unit-testable the same way
 *  parseContextWindowInput is. */
export function effortLevelDisabledReason(
  harness: HarnessSpec,
  providerKind: ProviderKind | null
): string | null {
  const kinds = providerKind ? [providerKind] : harness.supported_provider_kinds;
  const entries = kinds
    .map((k) => harness.effort_level_support?.[k])
    .filter((e) => e !== undefined);
  // A server that predates the capability reports nothing: leave the
  // select enabled rather than guessing.
  if (entries.length === 0 || entries.some((e) => e.supported)) return null;
  const first = entries[0];
  return first.supported ? null : first.reason;
}
