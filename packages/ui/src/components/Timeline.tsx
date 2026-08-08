import type { TaskEventResponse } from '../api.js';

// NOTE: an `EVENT_ICONS` map used to live here purely to derive each dot's
// glyph from the first letter of an icon NAME ('download' → "D"), which read
// as a meaningless initial and silently fell back to "•" for every event type
// the map had never heard of. Every row now renders the same "•" and states
// its `event_type` verbatim in the chip beside the timestamp — the raw type
// is both more precise than an initial and impossible to fall out of date.

const EVENT_COLORS: Record<string, string> = {
  status_merged: 'bg-green-500',
  status_failed: 'bg-red-500',
  status_cancelled: 'bg-gray-500',
  pr_merged: 'bg-green-500',
  task_cancelled: 'bg-red-500',
  task_closed: 'bg-gray-500',
  task_reset: 'bg-yellow-500',
  task_requeued: 'bg-blue-500',
  recovery: 'bg-orange-500',
  container_started: 'bg-blue-500',
  container_exited: 'bg-blue-400',
  // Orchestrator took over a PR the agent had already opened (neutral, like
  // pr_created); amber when it had to close a mis-targeted PR and reopen.
  pr_recreated: 'bg-amber-500',
  // Structural / operator-actionable prep failures. Same red as a
  // status_failed so they pop in the timeline; the TaskDetail page
  // also surfaces them as a dedicated banner above the timeline.
  agent_image_missing: 'bg-red-600',
  harness_entrypoint_exec_failed: 'bg-red-600',
  // Known terminal-failure reasons. Amber for the benign "no work produced"
  // case; red for the operational failures that need a retry.
  no_changes: 'bg-amber-500',
  salvage_failed: 'bg-red-600',
  pr_creation_failed: 'bg-red-600',
  // Git-host outage handling. These are NOT task failures — the task is
  // waiting, and its work is intact — so they read amber (waiting) and
  // green (recovered) rather than red. `prep_failed` is the one red note:
  // it records the underlying git error behind whichever of the two follows.
  prep_failed: 'bg-red-600',
  prep_backoff: 'bg-amber-500',
  prep_recovered: 'bg-green-500',
  salvage_deferred: 'bg-amber-500',
  salvage_push_failed: 'bg-amber-500',
  // The scheduler killed a run that blew past its timeout. Red: the attempt
  // produced nothing and the task is worse off than before it started.
  container_timeout_kill: 'bg-red-600',
  // Orphan handling — the container vanished under a task that still looks
  // active. Detection and the recovery attempt are amber (the orchestrator
  // is handling it); exhaustion is red (it gave up, the task is dead).
  orphan_detected: 'bg-amber-500',
  orphan_recovery_triggered: 'bg-amber-500',
  orphan_recovery_exhausted: 'bg-red-600',
  // Status rows are written as `status_${status}` by state-sync, so the
  // awaiting-human transitions need their own entries or they render in the
  // default grey — the same orange the status badges use for "a person has
  // to do something now".
  'status_awaiting-human-merge': 'bg-orange-500',
  'status_awaiting-human-review': 'bg-orange-500',
  'status_needs-human-review': 'bg-orange-500',
};

export function Timeline({ events }: { events: TaskEventResponse[] }) {
  if (events.length === 0) {
    return <p className="text-gray-500 text-sm">No events recorded</p>;
  }

  return (
    <div className="relative">
      {/* Vertical line */}
      <div className="absolute left-3 top-2 bottom-2 w-px bg-gray-800" />

      <div className="space-y-3">
        {events.map((event) => (
          <div key={event.id} className="flex items-start gap-3 relative">
            {/* Dot */}
            <div
              className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center z-10 ${
                EVENT_COLORS[event.event_type] ?? 'bg-gray-700'
              }`}
            >
              <span className="text-[10px] text-white font-bold">
                {'\u2022'}
              </span>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 pb-1">
              <p className="text-sm text-gray-200">{event.message}</p>
              {/* The raw event_type beside the timestamp. Messages are prose
                  written per call site, so two rows can read alike while
                  being entirely different events (`prep_failed` vs
                  `salvage_push_failed`); the type is the thing to grep the
                  server for. Wraps rather than pushing the row wide at
                  375px \u2014 some types are long. */}
              <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-2">
                <span>{formatTimestamp(event.created_at)}</span>
                <span className="text-[10px] font-mono text-gray-600 break-all">
                  {event.event_type}
                </span>
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Format a server-emitted timestamp string as a human-readable "X ago"
 * relative to wallclock now, falling back to a locale string for older
 * events.
 *
 * The server is supposed to emit ISO 8601 UTC strings (e.g.
 * `"2026-05-12T12:31:59.123Z"`). However, legacy rows written before the fix
 * for issue #72 may still hold the naive SQLite `datetime('now')` format
 * (e.g. `"2026-05-12 12:31:59"`) which the JS `Date` constructor parses as
 * *local* time, producing an "X hours ago" offset equal to the viewer's UTC
 * offset. To stay correct for those legacy rows without a destructive DB
 * backfill, we normalize any string that lacks both a `T` separator and a
 * trailing timezone marker (`Z` or `±HH:MM`) by treating it as UTC.
 *
 * Pure function — no DOM / network access.
 */
export function formatTimestamp(ts: string): string {
  const date = new Date(normalizeTimestamp(ts));
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;

  return date.toLocaleString();
}

/**
 * If `ts` already has a `T` separator or an explicit timezone marker
 * (`Z` or `±HH:MM` at the end), return it unchanged. Otherwise assume it is
 * a SQLite-style naive UTC string like `"YYYY-MM-DD HH:MM:SS"` and rewrite
 * it to ISO 8601 UTC so `new Date(...)` interprets it as UTC.
 */
function normalizeTimestamp(ts: string): string {
  const hasT = ts.includes('T');
  const hasTzMarker = /(Z|[+-]\d{2}:?\d{2})$/.test(ts);
  if (hasT || hasTzMarker) return ts;
  return ts.replace(' ', 'T') + 'Z';
}
