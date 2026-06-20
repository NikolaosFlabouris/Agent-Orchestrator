/** Shared formatting helpers for the reporting UI (KPI cards, charts, the
 *  leaderboard, and CSV export). Duration metrics returned by the
 *  `/api/reports/*` endpoints are in SECONDS; ratios (success rate) are
 *  0..1. Every helper renders a non-numeric "—" placeholder for null /
 *  non-finite input so empty-range responses never surface `NaN`. */

const EMPTY = '—';

/** Compact human duration from a second count (e.g. 42s, 7.5m, 3.2h, 1.4d). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return EMPTY;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${trim(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${trim(hours)}h`;
  return `${trim(hours / 24)}d`;
}

/** One decimal under 10, whole numbers above — keeps cards from getting noisy. */
function trim(n: number): string {
  return n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

/** Ratio (0..1) → percentage string. */
export function formatPercent(
  ratio: number | null | undefined,
  digits = 0
): string {
  if (ratio == null || !Number.isFinite(ratio)) return EMPTY;
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Integer-ish count with thousands separators. */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EMPTY;
  return n.toLocaleString();
}

/** Rework factor (avg develop attempts per task) → e.g. "1.4×". */
export function formatRework(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EMPTY;
  return `${n.toFixed(1)}×`;
}

/** Signed relative change between two values, or null when it can't be
 *  computed (missing data or a zero baseline, which would divide by zero). */
export function relativeDelta(
  current: number | null | undefined,
  previous: number | null | undefined
): number | null {
  if (current == null || previous == null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}
