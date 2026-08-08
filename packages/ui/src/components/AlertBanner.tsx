import { Link } from 'react-router-dom';
import type { OrchestratorAlert } from '@orchestrator/shared';

export function AlertBanner({
  alerts,
  onDismiss,
}: {
  alerts: OrchestratorAlert[];
  /** Hides the row until the server stops reporting that id — see
   *  `mergeAlerts` in store.ts for the re-fire rule. Optional so a caller
   *  that only wants to display alerts isn't forced to own the state. */
  onDismiss?: (id: string) => void;
}) {
  if (alerts.length === 0) return null;

  const colors = {
    info: 'bg-blue-900/50 border-blue-700 text-blue-200',
    warning: 'bg-yellow-900/50 border-yellow-700 text-yellow-200',
    error: 'bg-red-900/50 border-red-700 text-red-200',
  };

  return (
    <div className="px-6 pt-4 space-y-2">
      {alerts.map((alert) => (
        /* Keyed by the server's stable alert id, not the array index: the
           active set is recomputed every poll, so an index key would carry
           a dismissed row's identity onto whichever alert slid into its
           slot. `items-start` + `min-w-0` keep the ✕ pinned to the first
           line while a long message wraps beside it at 375px. */
        <div
          key={alert.id}
          className={`flex items-start gap-2 border rounded px-4 py-2 text-sm ${colors[alert.level]}`}
        >
          <div className="min-w-0 flex-1">
            {alert.task_id != null ? (
              /* Task-specific alerts are only actionable on the task page,
                 and the message quotes the ISSUE number while the route
                 takes the orchestrator task id — so the link is the only
                 way an operator gets from one to the other without
                 searching. */
              <Link
                to={`/tasks/${alert.task_id}`}
                className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >
                {alert.message}
              </Link>
            ) : (
              alert.message
            )}
          </div>
          {onDismiss && (
            /* `min-h-11 sm:min-h-0` per docs/06-web-ui.md — a bare ✕ glyph
               is far under the 44px touch target on a phone; the reset
               keeps the desktop banner the height it has always been.
               `-my-1` absorbs the extra height into the row's padding so
               the taller hit area doesn't grow the banner on mobile. */
            <button
              onClick={() => onDismiss(alert.id)}
              aria-label="Dismiss alert"
              title="Hide until this condition clears and fires again"
              className="min-h-11 sm:min-h-0 -my-1 shrink-0 px-2 opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
