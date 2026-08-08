/** Canonical task-status → badge colour map, and the badge that renders it.
 *
 *  This map used to be copy-pasted into Dashboard, TaskDetail and Reports,
 *  and the three copies had drifted: `queued` was gray in TaskDetail but
 *  yellow in Reports, and the Dashboard copy was missing `queued` and
 *  `reset` entirely (so both fell through to the fallback). One map here
 *  is the fix — a new status now needs exactly one edit.
 *
 *  Colour decisions worth not re-litigating:
 *  - `queued` is gray. Yellow is reserved for `changes-needed`, the one
 *    status that wants an operator to look at it; a queued task is idle,
 *    not flagged.
 *  - `reset` and `cancelled` share the dimmer gray (`text-gray-400`) that
 *    reads as "no longer live" next to `preparing`'s `text-gray-300`.
 *
 *  Not to be confused with `STATUS_COLORS` in `views/Reports.tsx`: that is
 *  a hex map for Recharts bars, which need hues distinguishable from each
 *  other rather than the muted background/foreground pairs a badge wants.
 *  The two are deliberately separate and do not have to agree. */
export const STATUS_BADGE_COLORS: Record<string, string> = {
  queued: 'bg-gray-700 text-gray-300',
  preparing: 'bg-gray-700 text-gray-300',
  'in-progress': 'bg-blue-900 text-blue-300',
  'in-review': 'bg-purple-900 text-purple-300',
  'changes-needed': 'bg-yellow-900 text-yellow-300',
  merged: 'bg-green-900 text-green-300',
  failed: 'bg-red-900 text-red-300',
  cancelled: 'bg-gray-700 text-gray-400',
  reset: 'bg-gray-700 text-gray-400',
  'awaiting-human-merge': 'bg-orange-900 text-orange-300',
  'awaiting-human-review': 'bg-orange-900 text-orange-300',
  'needs-human-review': 'bg-orange-900 text-orange-300',
};

/** Used for any status the map doesn't know — a status added server-side
 *  before the UI catches up still renders as a legible badge. */
const STATUS_BADGE_FALLBACK = 'bg-gray-700 text-gray-300';

/** Background/foreground classes for a status. Exported for the unit test
 *  and for callers that need the colours without the badge element. */
export function statusBadgeColor(status: string): string {
  return STATUS_BADGE_COLORS[status] ?? STATUS_BADGE_FALLBACK;
}

/** `sm` is the row/table badge, `md` the larger one in the TaskDetail
 *  header. Both sizes predate this component — they are the two recipes
 *  that already existed, not a new scale. */
export type StatusBadgeSize = 'sm' | 'md';

const SIZE_CLASSES: Record<StatusBadgeSize, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2 py-1 text-sm',
};

export interface StatusBadgeProps {
  status: string;
  /** Display text; defaults to the raw status (the Dashboard passes a
   *  friendlier phase label for in-flight tasks). */
  label?: string;
  size?: StatusBadgeSize;
  /** Extra classes for the call site — e.g. `whitespace-nowrap` in the
   *  Reports table, whose cells are narrow enough to wrap a status. */
  className?: string;
}

export function StatusBadge({ status, label, size = 'sm', className = '' }: StatusBadgeProps) {
  return (
    <span
      className={`${SIZE_CLASSES[size]} rounded font-medium ${statusBadgeColor(status)}${
        className ? ` ${className}` : ''
      }`}
    >
      {label ?? status}
    </span>
  );
}
