import type { TaskEventResponse } from '../api.js';

const EVENT_ICONS: Record<string, string> = {
  task_created: 'plus',
  workspace_cloned: 'download',
  branch_created: 'git-branch',
  container_started: 'play',
  container_exited: 'stop',
  work_salvaged: 'save',
  pr_created: 'pull-request',
  pr_merged: 'merge',
  review_verdict: 'check',
  task_cancelled: 'x',
  task_reset: 'refresh',
  task_requeued: 'play',
  recovery: 'alert',
};

const EVENT_COLORS: Record<string, string> = {
  status_merged: 'bg-green-500',
  status_failed: 'bg-red-500',
  status_cancelled: 'bg-gray-500',
  pr_merged: 'bg-green-500',
  task_cancelled: 'bg-red-500',
  task_reset: 'bg-yellow-500',
  task_requeued: 'bg-blue-500',
  recovery: 'bg-orange-500',
  container_started: 'bg-blue-500',
  container_exited: 'bg-blue-400',
  // Structural / operator-actionable prep failures. Same red as a
  // status_failed so they pop in the timeline; the TaskDetail page
  // also surfaces them as a dedicated banner above the timeline.
  agent_image_missing: 'bg-red-600',
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
                {(EVENT_ICONS[event.event_type] ?? '').charAt(0).toUpperCase() || '\u2022'}
              </span>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 pb-1">
              <p className="text-sm text-gray-200">{event.message}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {formatTimestamp(event.created_at)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;

  return date.toLocaleString();
}
