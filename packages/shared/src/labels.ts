/** Status labels applied to Forgejo issues. */

export const STATUS_PREFIX = 'status/';

export const STATUS_LABELS = {
  QUEUED: 'status/queued',
  PREPARING: 'status/preparing',
  IN_PROGRESS: 'status/in-progress',
  IN_REVIEW: 'status/in-review',
  CHANGES_NEEDED: 'status/changes-needed',
  MERGED: 'status/merged',
  FAILED: 'status/failed',
  CANCELLED: 'status/cancelled',
  AWAITING_HUMAN_MERGE: 'status/awaiting-human-merge',
  AWAITING_HUMAN_REVIEW: 'status/awaiting-human-review',
  NEEDS_HUMAN_REVIEW: 'status/needs-human-review',
} as const;

/** Override labels (not scoped under status/). */
export const OVERRIDE_LABELS = {
  HUMAN_MERGE: 'human-merge',
  HUMAN_REVIEW: 'human-review',
} as const;

/** Terminal statuses — these free the active slot. */
export const TERMINAL_STATUSES = new Set([
  'merged',
  'failed',
  'cancelled',
  'reset',
  'awaiting-human-merge',
  'awaiting-human-review',
  'needs-human-review',
]);

/** Convert a DB status value to a Forgejo label. */
export function statusToLabel(status: string): string {
  return STATUS_PREFIX + status;
}

/** Extract the DB status from a Forgejo label. */
export function labelToStatus(label: string): string | null {
  if (label.startsWith(STATUS_PREFIX)) {
    return label.slice(STATUS_PREFIX.length);
  }
  return null;
}
