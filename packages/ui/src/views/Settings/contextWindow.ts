/** Parsing for the optional per-model "context window" input in the
 *  Providers & Models tab.
 *
 *  The control is a free-text field rather than a number spinner so an
 *  operator can clear it back to "unset" by emptying it. Three outcomes:
 *
 *    number    — a positive whole token count to send as `context_window`
 *    null      — the field is empty: unset, harness uses its own default
 *    undefined — not a usable token count; the caller shows an error and
 *                does not submit
 *
 *  Kept as a pure function (no React) so the edge cases — blanks, zero,
 *  fractional and negative values, stray whitespace — stay unit-testable
 *  the same way buildProviderSavePayload is. */
export function parseContextWindowInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // `Number` (not parseInt) so trailing junk like "128000tokens" is
  // rejected outright instead of silently truncating to 128000.
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** Render a stored `context_window` back into the text input. */
export function formatContextWindowInput(value: number | null): string {
  return value === null ? '' : String(value);
}
