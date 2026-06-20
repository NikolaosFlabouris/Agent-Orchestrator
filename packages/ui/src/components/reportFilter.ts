/** Date-range helpers shared by the Reports page filter bar and the
 *  Dashboard KPI strip. Native `<input type="date">` works in `YYYY-MM-DD`,
 *  which the reports backend parses as UTC midnight, so we keep the filter
 *  state in that form and only convert to full ISO when deriving the
 *  previous comparison window. */

const MS_PER_DAY = 86_400_000;

/** Format a Date as a `YYYY-MM-DD` string (UTC) for a date input value. */
export function toDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Default `{ from, to }` range covering the last `days` up to today,
 *  as `YYYY-MM-DD` strings. Mirrors the backend default window. */
export function defaultRange(days: number): { from: string; to: string } {
  const now = Date.now();
  return {
    from: toDateInput(new Date(now - days * MS_PER_DAY)),
    to: toDateInput(new Date(now)),
  };
}

/** The equally-long window immediately before `[from, to)`, used for the
 *  KPI delta comparison. Returns ISO strings. Falls back to null when the
 *  bounds can't be parsed. */
export function previousRange(
  from: string,
  to: string
): { from: string; to: string } | null {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) return null;
  const span = toMs - fromMs;
  return {
    from: new Date(fromMs - span).toISOString(),
    to: new Date(fromMs).toISOString(),
  };
}
