import { useEffect, useId, useLayoutEffect, useState, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type {
  TaskDetailResponse,
  TaskDependencyResponse,
  AttemptResponse,
  TaskEventResponse,
  TaskAction,
} from '../api.js';
import { connectOutputWs } from '../ws.js';
import type { DashboardWsEvent, OutputWsEvent } from '../ws.js';
import { AppHeader } from '../components/AppHeader.js';
import { useDashboardEvents } from '../components/LiveData.js';
import { Timeline } from '../components/Timeline.js';
import { Elapsed, RetryIn, useTicker } from '../components/LiveTime.js';
import { filterLogLine } from '../logFilter.js';
import { useStore } from '../store.js';

const ACTIVE_STATUSES = new Set([
  'preparing', 'in-progress', 'in-review', 'changes-needed',
]);
const RESETTABLE_STATUSES = new Set([
  'failed', 'cancelled', 'awaiting-human-merge', 'awaiting-human-review', 'needs-human-review',
]);
const REQUEUEABLE_STATUSES = new Set(['reset', 'cancelled']);
const EXTENDABLE_STATUSES = new Set(['failed']);
// max_attempts is editable in any non-terminal state. Terminal tasks should
// use 'extend' (failed) or 'requeue' (cancelled/reset) instead.
const MAX_ATTEMPTS_EDITABLE_STATUSES = new Set([
  'queued', 'preparing', 'in-progress', 'in-review', 'changes-needed',
]);

/** What TaskDetail does with one frame off the shared dashboard stream.
 *  Split out of the component (and exported) so the routing is testable
 *  without a DOM:
 *
 *  - `task_event` — a single timeline row for this task. Folded straight
 *    into local state; deliberately NOT a refetch, because these fire
 *    continuously while a task runs and each one would otherwise cost a
 *    `GET /api/tasks/:id`.
 *  - `task_updated` — the task row changed. The event carries the task but
 *    not its attempts/events, so this one does refetch.
 *  - everything else (`task_created`, `status_changed`, `snapshot`) is for
 *    the dashboard store, not for this view.
 */
export function handleDashboardEvent(
  event: DashboardWsEvent,
  handlers: {
    taskId: number | undefined;
    refetch: (id: number) => void;
    appendEvent: (row: TaskEventResponse) => void;
  }
): void {
  const { taskId, refetch, appendEvent } = handlers;
  if (taskId === undefined) return;
  if (event.type === 'task_event' && event.taskId === taskId) {
    appendEvent(event.event);
  } else if (event.type === 'task_updated' && event.task.id === taskId) {
    refetch(taskId);
  }
}

/** Append a streamed timeline row, ignoring one we already hold.
 *
 *  The same row can arrive twice: a `task_updated` refetch racing the
 *  `task_event` frame returns the full `events` array, which already
 *  contains it. Dedupe is by row id — the only stable identity here.
 *
 *  Rows are appended in arrival order, matching the server's
 *  `ORDER BY created_at ASC, id ASC`; timestamps are normalized at render
 *  time by `Timeline`, so a streamed row and a refetched one display
 *  identically even for the legacy naive-timestamp format (issue #72). */
export function appendTaskEvent(
  events: TaskEventResponse[] | undefined,
  row: TaskEventResponse
): TaskEventResponse[] {
  const current = events ?? [];
  if (current.some((e) => e.id === row.id)) return current;
  return [...current, row];
}

/** Fold one streamed timeline row into the loaded task — the `setTask`
 *  updater, lifted out of the component so the state transition is testable
 *  without a DOM.
 *
 *  Returns the SAME object when the row is a duplicate (or nothing is loaded
 *  yet), which is load-bearing: React bails out of the re-render when the
 *  updater returns the current state. */
export function applyTaskEvent(
  prev: TaskDetailResponse | null,
  row: TaskEventResponse
): TaskDetailResponse | null {
  if (!prev) return prev;
  const events = appendTaskEvent(prev.events, row);
  return events === prev.events ? prev : { ...prev, events };
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskDetailResponse | null>(null);
  // `error` is LOAD failures only. It replaces the entire page with an
  // error line, which is right when there is no task to show — and was
  // very wrong for a rejected action PATCH, which used to blank a fully
  // loaded page because the operator clicked Cancel on an already-cancelled
  // task. Action failures go to `actionError` and render inline instead.
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agentProfileError, setAgentProfileError] = useState<string | null>(null);
  const [reviewProfileError, setReviewProfileError] = useState<string | null>(null);
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  const [extendAmount, setExtendAmount] = useState(1);
  const [extendError, setExtendError] = useState<string | null>(null);
  const [editingMaxAttempts, setEditingMaxAttempts] = useState(false);
  const [maxAttemptsDraft, setMaxAttemptsDraft] = useState<number | null>(null);
  const [maxAttemptsError, setMaxAttemptsError] = useState<string | null>(null);
  const [maxAttemptsPending, setMaxAttemptsPending] = useState(false);
  const profiles = useStore((s) => s.agentProfiles);
  const setAgentProfiles = useStore((s) => s.setAgentProfiles);
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);
  // The button that opens the Extend modal, so focus can be handed back to
  // it when the modal closes (it is the only way in, so it is always the
  // element the user came from).
  const extendTriggerRef = useRef<HTMLButtonElement>(null);
  // One id root for this view's label/control pairs and the dialog title.
  const uid = useId();
  const agentProfileSelectId = `${uid}-agent-profile`;
  const reviewProfileSelectId = `${uid}-review-profile`;
  const extendTitleId = `${uid}-extend-title`;

  useEffect(() => {
    if (!id) return;
    api
      .getTask(parseInt(id, 10))
      .then(setTask)
      .catch((err) => setError(err.message));
  }, [id]);

  // Live-refresh: listen on the app-wide /ws/dashboard stream (owned by
  // <LiveData>, not opened here — a second socket would receive full
  // snapshots of every task purely so we could filter for one id). See
  // `handleDashboardEvent` for what each event type does.
  const taskId = task?.id;
  useDashboardEvents((event) =>
    handleDashboardEvent(event, {
      taskId,
      refetch: (target) => {
        api.getTask(target).then(setTask).catch(() => {});
      },
      appendEvent: (row) => setTask((prev) => applyTaskEvent(prev, row)),
    })
  );

  // Escape closes the Extend modal, matching the Cancel button (including
  // the focus hand-back). Bound on the document rather than the panel so it
  // fires wherever focus sits inside the dialog.
  useEffect(() => {
    if (!extendModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      closeExtendModal();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [extendModalOpen]);

  // Load agent profiles into store if not already cached
  useEffect(() => {
    if (profiles.length === 0) {
      api
        .getAgentProfiles()
        .then((res) => setAgentProfiles(res.profiles))
        .catch(() => {});
    }
  }, [profiles.length, setAgentProfiles]);

  async function handleAction(action: TaskAction) {
    if (!task || actionPending) return;
    // The TaskAction union has variants without an `action` discriminator
    // (the per-task field-edit shapes), so narrow before reading it.
    const actionName = 'action' in action ? action.action : null;
    // Confirmation for destructive actions
    if (actionName === 'cancel') {
      if (!confirm('Cancel this task? Container will be stopped and branch/PR cleaned up.')) return;
    } else if (actionName === 'close') {
      // An open PR means real changes are about to be discarded — warn
      // explicitly. Without a PR, a lighter confirm is enough.
      const message = task.pr_number != null
        ? `Close this task? Its open PR #${task.pr_number} has changes that will be closed and discarded, the branch deleted, and the Forgejo issue closed. Continue?`
        : 'Close this task? The Forgejo issue will be closed and the task marked cancelled.';
      if (!confirm(message)) return;
    } else if (actionName === 'reset') {
      if (!confirm('This will delete the branch, PR, and all agent work. The issue will return to an unqueued state. Continue?')) return;
    } else if (actionName === 'force_fail') {
      if (!confirm('Force-fail this task?')) return;
    } else if (actionName === 'requeue') {
      if (!confirm('Requeue this task? It will be placed at the end of the queue.')) return;
    }

    setActionPending(true);
    // Clear on start, not only on success: leaving the previous failure up
    // while a new action runs makes it look like the new one failed too.
    setActionError(null);
    try {
      await api.patchTask(task.id, action);
      // Reload task
      const updated = await api.getTask(task.id);
      setTask(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionPending(false);
    }
  }

  /** The single exit from the Extend modal: unmount it and return focus to
   *  the button that opened it, so keyboard users are not dropped onto
   *  <body> when the panel (and whatever held focus inside it) disappears. */
  function closeExtendModal() {
    setExtendModalOpen(false);
    setExtendError(null);
    extendTriggerRef.current?.focus();
  }

  async function handleExtend() {
    if (!task || actionPending) return;
    setActionPending(true);
    setExtendError(null);
    try {
      await api.patchTask(task.id, { action: 'extend', additional_attempts: extendAmount });
      const updated = await api.getTask(task.id);
      setTask(updated);
      closeExtendModal();
    } catch (err) {
      setExtendError(err instanceof Error ? err.message : 'Extend failed');
    } finally {
      setActionPending(false);
    }
  }

  async function handleAgentProfileChange(newProfileId: string) {
    if (!task) return;
    const newProfile = newProfileId || null; // empty string → null (inherit)

    // Capture the FULL pre-PATCH source-of-truth fields so rollback
    // restores exactly what the server told us last, instead of
    // reconstructing the source label from local state (which might
    // drift if global/repo defaults changed since the last refetch).
    const prevSnapshot = {
      agent_profile_id: task.agent_profile_id,
      effective_agent_profile_id: task.effective_agent_profile_id,
      agent_profile_source: task.agent_profile_source,
    };

    // Optimistic update — sync derived fields so the select label stays
    // consistent before the getTask refetch resolves.
    setTask((prev) => {
      if (!prev) return prev;
      const inherited = prev.repo_agent_profile_id ?? prev.global_agent_profile_id;
      return {
        ...prev,
        agent_profile_id: newProfile,
        effective_agent_profile_id: newProfile ?? inherited,
        agent_profile_source: newProfile !== null
          ? 'task'
          : prev.repo_agent_profile_id !== null
            ? 'repo'
            : prev.global_agent_profile_id !== null
              ? 'global'
              : 'none',
      };
    });
    setAgentProfileError(null);

    try {
      await api.patchTask(task.id, { agent_profile_id: newProfile });
    } catch (err) {
      // Server didn't persist the change — restore the exact captured
      // snapshot. No source-label reconstruction; we're trusting what
      // the server reported originally.
      setTask((prev) => (prev ? { ...prev, ...prevSnapshot } : prev));
      setAgentProfileError(err instanceof Error ? err.message : 'Failed to update agent profile');
      return;
    }
    try {
      const updated = await api.getTask(task.id);
      setTask(updated);
    } catch {
      // PATCH was confirmed; leave optimistic state — WS push will correct it.
    }
  }

  async function handleReviewProfileChange(newProfileId: string) {
    if (!task) return;
    const newProfile = newProfileId || null; // empty string → null (inherit)

    // Same optimistic-update + exact-snapshot-rollback pattern as
    // handleAgentProfileChange, over the review chain (which has the
    // extra terminal fallback to the effective implementation profile).
    const prevSnapshot = {
      review_agent_profile_id: task.review_agent_profile_id,
      effective_review_agent_profile_id: task.effective_review_agent_profile_id,
      review_agent_profile_source: task.review_agent_profile_source,
    };

    setTask((prev) => {
      if (!prev) return prev;
      const inherited =
        prev.repo_review_agent_profile_id ??
        prev.global_review_agent_profile_id ??
        prev.effective_agent_profile_id;
      return {
        ...prev,
        review_agent_profile_id: newProfile,
        effective_review_agent_profile_id: newProfile ?? inherited,
        review_agent_profile_source: newProfile !== null
          ? 'task'
          : prev.repo_review_agent_profile_id !== null
            ? 'repo'
            : prev.global_review_agent_profile_id !== null
              ? 'global'
              : prev.effective_agent_profile_id !== null
                ? 'implementation'
                : 'none',
      };
    });
    setReviewProfileError(null);

    try {
      await api.patchTask(task.id, { review_agent_profile_id: newProfile });
    } catch (err) {
      setTask((prev) => (prev ? { ...prev, ...prevSnapshot } : prev));
      setReviewProfileError(err instanceof Error ? err.message : 'Failed to update review profile');
      return;
    }
    try {
      const updated = await api.getTask(task.id);
      setTask(updated);
    } catch {
      // PATCH was confirmed; leave optimistic state — WS push will correct it.
    }
  }

  function startEditMaxAttempts() {
    if (!task) return;
    setMaxAttemptsDraft(task.max_attempts);
    setMaxAttemptsError(null);
    setEditingMaxAttempts(true);
  }

  function cancelEditMaxAttempts() {
    setEditingMaxAttempts(false);
    setMaxAttemptsDraft(null);
    setMaxAttemptsError(null);
  }

  async function handleMaxAttemptsSave() {
    if (!task || maxAttemptsPending) return;
    if (maxAttemptsDraft === null) return;
    if (!Number.isInteger(maxAttemptsDraft) || maxAttemptsDraft < 1) {
      setMaxAttemptsError('Must be a positive integer');
      return;
    }
    if (maxAttemptsDraft < task.attempt) {
      setMaxAttemptsError(
        `Cannot set below current attempt count (${task.attempt})`
      );
      return;
    }
    if (maxAttemptsDraft === task.max_attempts) {
      cancelEditMaxAttempts();
      return;
    }
    setMaxAttemptsPending(true);
    try {
      await api.patchTask(task.id, { max_attempts: maxAttemptsDraft });
      const updated = await api.getTask(task.id);
      setTask(updated);
      setEditingMaxAttempts(false);
      setMaxAttemptsDraft(null);
    } catch (err) {
      setMaxAttemptsError(
        err instanceof Error ? err.message : 'Failed to update max attempts'
      );
    } finally {
      setMaxAttemptsPending(false);
    }
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
        <Link to="/" className="text-blue-400 hover:text-blue-300">
          &larr; Dashboard
        </Link>
        <p className="mt-4 text-red-400">Error: {error}</p>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader
        back={
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="text-blue-400 hover:text-blue-300 text-sm"
            >
              &larr; Dashboard
            </Link>
            <Link
              to="/help"
              className="text-blue-400 hover:text-blue-300 text-sm"
            >
              Help
            </Link>
          </div>
        }
        title={
          <>
            {forgejoBaseUrl && task.repo ? (
              <a
                href={`${forgejoBaseUrl}/${task.repo.owner}/${task.repo.name}/issues/${task.issue_id}`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-400 font-mono hover:underline"
              >
                #{task.issue_id}
              </a>
            ) : (
              <span className="text-blue-400 font-mono">
                #{task.issue_id}
              </span>
            )}{' '}
            {task.issue_title}
          </>
        }
        meta={
          <>
            <div className="text-sm text-gray-400 space-x-4">
              {task.repo && (
                <span>
                  {task.repo.owner}/{task.repo.name}
                </span>
              )}
              {task.branch_name && (
                <span className="font-mono">{task.branch_name}</span>
              )}
              {task.pr_number && (
                <span>
                  PR{' '}
                  <a
                    href={task.forgejo_links?.pr}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    #{task.pr_number}
                  </a>
                </span>
              )}
            </div>
            {(task.container_name || task.container_id) && (
              <div className="text-xs text-gray-500 mt-1 font-mono">
                container:{' '}
                {task.container_name ?? task.container_id?.slice(0, 12)}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <label htmlFor={agentProfileSelectId} className="text-xs text-gray-500">
                Implementation profile:
              </label>
              {/* The option labels carry the inherited profile name, so this
                  select's intrinsic width is far past 375px; `min-w-0
                  max-w-full` lets it shrink to the wrapped line instead of
                  widening the document. Neither binds at desktop width. */}
              <select
                id={agentProfileSelectId}
                value={task.agent_profile_id ?? ''}
                onChange={(e) => handleAgentProfileChange(e.target.value)}
                className="min-w-0 max-w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
              >
                <option value="">
                  Inherit
                  {(() => {
                    const inheritedId =
                      task.repo_agent_profile_id ?? task.global_agent_profile_id;
                    if (!inheritedId) return ' (no default — set one in Global Settings)';
                    const found = profiles.find((p) => p.id === inheritedId);
                    const label = found?.display_name ?? inheritedId;
                    const source = task.repo_agent_profile_id ? 'repo' : 'global';
                    return ` (${source} default: ${label})`;
                  })()}
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
              {ACTIVE_STATUSES.has(task.status) && (
                <span className="text-xs text-gray-500 italic">Takes effect on next attempt</span>
              )}
              {agentProfileError && (
                <span className="text-xs text-red-400">{agentProfileError}</span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <label htmlFor={reviewProfileSelectId} className="text-xs text-gray-500">
                Review profile:
              </label>
              <select
                id={reviewProfileSelectId}
                value={task.review_agent_profile_id ?? ''}
                onChange={(e) => handleReviewProfileChange(e.target.value)}
                disabled={task.has_human_review_label === true}
                title={
                  task.has_human_review_label === true
                    ? 'Human review is enabled — the automated review agent does not run for this task.'
                    : undefined
                }
                className="min-w-0 max-w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs disabled:opacity-50"
              >
                <option value="">
                  Inherit
                  {(() => {
                    const inheritedId =
                      task.repo_review_agent_profile_id ??
                      task.global_review_agent_profile_id ??
                      task.effective_agent_profile_id;
                    if (!inheritedId) return ' (no default — set one in Global Settings)';
                    const found = profiles.find((p) => p.id === inheritedId);
                    const label = found?.display_name ?? inheritedId;
                    const source = task.repo_review_agent_profile_id
                      ? 'repo review default'
                      : task.global_review_agent_profile_id
                        ? 'global review default'
                        : 'implementation profile';
                    return ` (${source}: ${label})`;
                  })()}
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
              {task.has_human_review_label === true ? (
                <span className="text-xs text-gray-500 italic">
                  Human review is enabled — the automated review agent doesn't run
                </span>
              ) : (
                ACTIVE_STATUSES.has(task.status) && (
                  <span className="text-xs text-gray-500 italic">Takes effect on next review run</span>
                )
              )}
              {reviewProfileError && (
                <span className="text-xs text-red-400">{reviewProfileError}</span>
              )}
            </div>
          </>
        }
      >
        {/* Below `lg` AppHeader moves this slot into its disclosure panel,
            which stacks its children from the left — so the right-alignment
            and the `justify-end` rows only apply from `lg` up, where the
            block sits in the header's right column exactly as before. Each
            row wraps rather than compressing the title column beside it. */}
        <div className="min-w-0 lg:text-right">
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <StatusBadge status={task.status} />
            {task.blocked && (
              <span
                className="px-2 py-1 rounded text-sm font-medium bg-amber-900 text-amber-300"
                title={`Waiting on ${(task.blocked_by ?? [])
                  .map((n) => `#${n}`)
                  .join(', ')}`}
              >
                blocked
              </span>
            )}
            {/* Only `orphaned` is worth a badge. `idle` is the health of every
                queued and terminal task, so rendering it would put a badge on
                most of the dashboard while saying nothing — hence the guard
                here and the orphaned-only `HealthBadge`. */}
            {task.health === 'orphaned' && <HealthBadge />}
          </div>
          <div className="text-sm text-gray-400 mt-1 flex flex-wrap items-center gap-2 lg:justify-end">
            {editingMaxAttempts && MAX_ATTEMPTS_EDITABLE_STATUSES.has(task.status) ? (
              <>
                <span>Attempt {task.attempt}/</span>
                <input
                  type="number"
                  min={task.attempt}
                  value={maxAttemptsDraft ?? ''}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setMaxAttemptsDraft(Number.isNaN(v) ? null : v);
                    if (maxAttemptsError) setMaxAttemptsError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleMaxAttemptsSave();
                    else if (e.key === 'Escape') cancelEditMaxAttempts();
                  }}
                  autoFocus
                  disabled={maxAttemptsPending}
                  /* aria-label rather than a <label for>: AppHeader renders
                     this slot twice below `lg` (the hidden desktop copy and
                     the disclosure panel), so an id here would not be
                     unique in the document. */
                  aria-label="Max attempts"
                  className="w-16 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-sm text-right"
                />
                <button
                  onClick={handleMaxAttemptsSave}
                  disabled={maxAttemptsPending}
                  className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={cancelEditMaxAttempts}
                  disabled={maxAttemptsPending}
                  className="text-xs text-gray-500 hover:text-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span>Attempt {task.attempt}/{task.max_attempts}</span>
                {MAX_ATTEMPTS_EDITABLE_STATUSES.has(task.status) && (
                  <button
                    onClick={startEditMaxAttempts}
                    className="text-xs text-blue-400 hover:text-blue-300"
                    title="Change max attempts"
                  >
                    Edit
                  </button>
                )}
              </>
            )}
          </div>
          {maxAttemptsError && (
            <div className="text-xs text-red-400 mt-1 lg:text-right">
              {maxAttemptsError}
            </div>
          )}
          {/* Git-outage backoff state. Without these two lines a task waiting
              out a workspace-prep backoff is indistinguishable from an idle
              queued one, and finished-but-unpushed work looks like nothing
              happened at all. Amber matches the other degraded-state hints. */}
          {task.status === 'queued' && task.prep_backoff_level > 0 && (
            <div className="text-xs text-amber-400 mt-1 lg:text-right">
              Workspace prep failed ×{task.prep_failure_count} — retry{' '}
              <RetryIn at={task.prep_next_attempt_at} />
            </div>
          )}
          {task.salvage_next_attempt_at != null && (
            <div className="text-xs text-amber-400 mt-1 lg:text-right">
              Completed work is held locally — push retry{' '}
              <RetryIn at={task.salvage_next_attempt_at} />
            </div>
          )}
        </div>
      </AppHeader>

      {/* Actions bar */}
      <div className="border-b border-gray-800 bg-gray-900/50 px-6 py-3">
        {/* Up to six buttons live here; at 375px they do not fit on one
            line, and without wrapping the overflowing ones are simply
            unreachable. `gap-3` already supplies the row gap, so desktop
            (which never wraps) is unchanged. */}
        <div className="mx-auto max-w-7xl flex flex-wrap gap-3">
          {ACTIVE_STATUSES.has(task.status) && (
            <button
              onClick={() => handleAction({ action: 'cancel' })}
              disabled={actionPending}
              className="text-sm px-3 py-1.5 rounded border border-red-800 text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {task.status !== 'merged' && (
            <button
              onClick={() => handleAction({ action: 'close' })}
              disabled={actionPending}
              className="text-sm px-3 py-1.5 rounded border border-red-800 text-red-400 hover:bg-red-950 disabled:opacity-50"
              title="Resolve this task: close the Forgejo issue and mark the task cancelled"
            >
              Close
            </button>
          )}
          {task.status === 'in-review' && (
            <button
              onClick={() => handleAction({ action: 'force_approve' })}
              disabled={actionPending}
              className="text-sm px-3 py-1.5 rounded border border-green-800 text-green-400 hover:bg-green-950 disabled:opacity-50"
            >
              Force Approve
            </button>
          )}
          {ACTIVE_STATUSES.has(task.status) && (
            <button
              onClick={() => handleAction({ action: 'force_fail' })}
              disabled={actionPending}
              className="text-sm px-3 py-1.5 rounded border border-yellow-800 text-yellow-400 hover:bg-yellow-950 disabled:opacity-50"
            >
              Force Fail
            </button>
          )}
           {RESETTABLE_STATUSES.has(task.status) && (
             <button
               onClick={() => handleAction({ action: 'reset' })}
               disabled={actionPending}
               className="text-sm px-3 py-1.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
             >
               Reset
             </button>
           )}
           {EXTENDABLE_STATUSES.has(task.status) && (
             <button
               ref={extendTriggerRef}
               onClick={() => { setExtendAmount(1); setExtendError(null); setExtendModalOpen(true); }}
               disabled={actionPending}
               className="text-sm px-3 py-1.5 rounded border border-orange-800 text-orange-400 hover:bg-orange-950 disabled:opacity-50"
             >
               Extend
             </button>
           )}
           {REQUEUEABLE_STATUSES.has(task.status) && (
             <button
               onClick={() => handleAction({ action: 'requeue' })}
               disabled={actionPending}
               className="text-sm px-3 py-1.5 rounded border border-blue-800 text-blue-400 hover:bg-blue-950 disabled:opacity-50"
             >
               Requeue
             </button>
           )}
         </div>

        {actionError && (
          /* Inline and dismissable, right under the buttons that produced
             it. A rejected PATCH (racing another operator, an action the
             server refuses in this state) is a local, recoverable event —
             it must not take the page down, which is what routing it into
             the page-level `error` state used to do. */
          <div
            role="alert"
            className="mx-auto max-w-7xl mt-3 flex items-start gap-2 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300"
          >
            <span className="min-w-0 flex-1 break-words">{actionError}</span>
            <button
              onClick={() => setActionError(null)}
              aria-label="Dismiss error"
              className="min-h-11 sm:min-h-0 -my-1 shrink-0 px-2 opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Extend modal */}
      {extendModalOpen && task && (
        /* `p-4` on the overlay keeps a visible margin around the panel at
            any viewport, and `w-full max-w-sm` lets it shrink to fit inside
            that margin instead of being clipped below 320px — the old fixed
            `w-80` touched the screen edges already at 375px. Wide viewports
            get the `max-w-sm` cap, so the panel stays a fixed-width box. */
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={extendTitleId}
            className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-sm shadow-xl"
          >
            <h2 id={extendTitleId} className="text-lg font-semibold mb-4">Extend Task</h2>
            <p className="text-sm text-gray-400 mb-4">
              Grant additional attempts without resetting any existing work or PR.
            </p>
            <div className="mb-3">
              <label htmlFor={`${uid}-extend-amount`} className="block text-xs text-gray-500 mb-1">
                Additional attempts
              </label>
              {/* The panel mounts on open, so autoFocus lands focus inside
                  the dialog every time it is shown — and `closeExtendModal`
                  hands it back to the Extend button on the way out. */}
              <input
                id={`${uid}-extend-amount`}
                type="number"
                min={1}
                max={10}
                value={extendAmount}
                autoFocus
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v)) setExtendAmount(Math.min(10, Math.max(1, v)));
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            {/* `min-h-11` (44px) is the minimum comfortable touch target;
                these presets only reach 26px and the confirm row 32px. Reset
                at `sm` so the desktop modal keeps its original button
                heights. */}
            <div className="flex gap-2 mb-4">
              {[1, 3, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setExtendAmount(n)}
                  className={`min-h-11 sm:min-h-0 text-xs px-3 py-1 rounded border transition-colors ${
                    extendAmount === n
                      ? 'border-blue-600 text-blue-300 bg-blue-950'
                      : 'border-gray-700 text-gray-400 hover:border-gray-600'
                  }`}
                >
                  +{n}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mb-5">
              New max_attempts will be: <span className="text-gray-200 font-mono">{task.max_attempts + extendAmount}</span>
            </p>
            {extendError && (
              <p className="text-xs text-red-400 mb-3">{extendError}</p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={closeExtendModal}
                disabled={actionPending}
                className="min-h-11 sm:min-h-0 text-sm px-4 py-1.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleExtend}
                disabled={actionPending}
                className="min-h-11 sm:min-h-0 text-sm px-4 py-1.5 rounded border border-orange-700 text-orange-300 bg-orange-950/50 hover:bg-orange-950 disabled:opacity-50"
              >
                {actionPending ? 'Extending…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-8">
        {/* Failure banner — promotes the event that explains why the task
            is in a bad state ABOVE the timeline, so the operator doesn't
            have to scan twenty progress rows (or read raw docker logs) to
            find it. Covers the categorized prep failures with their
            actionable fix message AND every ordinary terminal failure
            (no changes produced, salvage/PR/prep errors, timeout kills,
            orphan exhaustion) — see `deriveLastFailure` for which status
            admits which. A successful retry clears the banner; the old
            event row remains in the timeline as a record of what
            happened. */}
        <FailureBanner task={task} />

        {/* Dependencies */}
        <DependencySection task={task} onChanged={setTask} />

        {/* Timeline */}
        {task.events && task.events.length > 0 && (
          <section>
            <h2 className="text-lg font-medium mb-3">Timeline</h2>
            <Timeline events={task.events} />
          </section>
        )}

        {/* Agent output */}
        <section>
          <h2 className="text-lg font-medium mb-3">Agent Output</h2>
          <AgentOutput taskId={task.id} isRunning={!!task.container_id} />
        </section>

        {/* Attempt history */}
        <section>
          <h2 className="text-lg font-medium mb-3">
            Attempts ({task.attempts.length})
          </h2>
          <div className="space-y-3">
            {task.attempts.map((attempt) => (
              <AttemptRow key={attempt.id} attempt={attempt} />
            ))}
          </div>
        </section>

        {/* Links */}
        {task.forgejo_links && Object.keys(task.forgejo_links).length > 0 && (
          <section>
            <h2 className="text-lg font-medium mb-2">Links</h2>
            <div className="space-x-4 text-sm">
              {task.forgejo_links.issue && (
                <a
                  href={task.forgejo_links.issue}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300"
                >
                  Forgejo Issue
                </a>
              )}
              {task.forgejo_links.pr && (
                <a
                  href={task.forgejo_links.pr}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300"
                >
                  Pull Request
                </a>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

/** Set of event_types that represent structural / operator-actionable
 *  prep failures. Each one corresponds to a `categorizePrepFailure`
 *  branch in scheduler.ts that records a task_event with a clear,
 *  actionable message when the scheduler hits a known recurring
 *  bring-up problem (image missing, etc.). The banner reads the most
 *  recent matching event and surfaces its message verbatim — the
 *  server is the source of truth for the wording. */
const STRUCTURAL_FAILURE_EVENT_TYPES = new Set([
  'agent_image_missing',
  'harness_entrypoint_exec_failed',
]);

/** Every event_type that explains why a task ended badly. The structural
 *  pair above is the operator-actionable subset; the rest are the ordinary
 *  ways a run dies, each written by a specific server call site with the
 *  underlying error in its message:
 *
 *  - `no_changes`           — the agent produced no diff (agents/develop.ts)
 *  - `salvage_failed` /
 *    `salvage_push_failed`  — finished work could not be pushed
 *  - `pr_creation_failed`   — the branch landed but the PR call failed
 *  - `prep_failed`          — workspace prep hit a git error
 *  - `container_timeout_kill` — the run blew past its timeout (scheduler)
 *  - `orphan_recovery_exhausted` — the container vanished and recovery
 *                             gave up (orphan-recovery.ts)
 *  - `status_failed`        — the generic status row `state-sync` writes on
 *                             every transition into `failed`
 *
 *  Before this set existed, only the two structural types got a banner and
 *  every other failure was a timeline row indistinguishable from the twenty
 *  progress rows above it. */
const FAILURE_EVENT_TYPES = new Set([
  ...STRUCTURAL_FAILURE_EVENT_TYPES,
  'no_changes',
  'salvage_failed',
  'pr_creation_failed',
  'prep_failed',
  'salvage_push_failed',
  'container_timeout_kill',
  'orphan_recovery_exhausted',
  'status_failed',
]);

/** What `FailureBanner` should show, or null for "nothing to report".
 *
 *  `kind` selects the heading only: 'structural' keeps the original
 *  "operator action needed" wording (the message is a fix instruction),
 *  'failure' names the event type (the message is a post-mortem). */
export interface DerivedFailure {
  event: TaskEventResponse;
  kind: 'structural' | 'failure';
}

/** Pick the event that explains the task's current bad state.
 *
 *  Two statuses qualify, for different reasons:
 *
 *  - `failed` — terminal. Any failure-class event is fair game.
 *  - `queued` — the structural-failure retry window. A task bounces back to
 *    queued between transient prep failures, and stays there after a reset
 *    the operator may not have fixed the cause of, so the structural banner
 *    has to survive the trip. Non-structural failures are deliberately NOT
 *    surfaced here: a queued task carrying an old `no_changes` from a
 *    previous attempt is not currently failing at anything.
 *
 *  Any other status means the problem is no longer live — a successful retry
 *  clears the banner, and the historical event stays in the timeline as the
 *  record of what happened.
 *
 *  `status_failed` is the fallback of last resort. state-sync writes one on
 *  every transition into `failed`, so it is present for essentially every
 *  failed task, and its message is the generic status text — the specific
 *  event from the same failure episode (`no_changes`, `prep_failed`, …) is
 *  written moments earlier and says something useful. Hence: latest
 *  non-`status_failed` failure event if there is one, else the latest
 *  `status_failed`.
 *
 *  Pure — takes the rows and the status, touches no DOM or network. */
export function deriveLastFailure(
  events: TaskEventResponse[] | undefined,
  status: string
): DerivedFailure | null {
  if (status !== 'failed' && status !== 'queued') return null;

  const candidates = (events ?? []).filter((e) =>
    status === 'queued'
      ? STRUCTURAL_FAILURE_EVENT_TYPES.has(e.event_type)
      : FAILURE_EVENT_TYPES.has(e.event_type)
  );
  if (candidates.length === 0) return null;

  // Rows arrive in the server's `created_at ASC, id ASC` order, so "latest"
  // is the last match.
  const specific = candidates.filter((e) => e.event_type !== 'status_failed');
  const event = (specific.length > 0 ? specific : candidates).at(-1)!;

  return {
    event,
    kind: STRUCTURAL_FAILURE_EVENT_TYPES.has(event.event_type)
      ? 'structural'
      : 'failure',
  };
}

/** What the user can do about each non-satisfied dependency state. The
 *  repair always happens on Forgejo (edit the issue body / close the dep
 *  issue) — the orchestrator only reflects it. */
const DEP_STATE_HINTS: Record<string, string> = {
  open: 'Waits until the issue is closed.',
  'in-progress': 'An agent is working on it — clears when its issue closes.',
  failed:
    'Its task gave up while the issue is still open. Requeue that task, close the issue, or tick the box in the issue body to override.',
  missing:
    'Issue not found. Fix or remove the line in the issue body, or tick the box to override.',
  error: 'Could not check the issue — retried automatically.',
  cycle:
    'Circular dependency. Remove one side on Forgejo, or tick a box to override.',
};

function DependencyStateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    satisfied: 'bg-green-900 text-green-300',
    'manually-satisfied': 'bg-teal-900 text-teal-300',
    open: 'bg-gray-700 text-gray-300',
    'in-progress': 'bg-blue-900 text-blue-300',
    failed: 'bg-red-900 text-red-300',
    missing: 'bg-red-900 text-red-300',
    error: 'bg-yellow-900 text-yellow-300',
    cycle: 'bg-red-900 text-red-300',
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${colors[state] ?? 'bg-gray-700 text-gray-300'}`}
    >
      {state}
    </span>
  );
}

function DependencySection({
  task,
  onChanged,
}: {
  task: TaskDetailResponse;
  onChanged: (task: TaskDetailResponse) => void;
}) {
  const [recheckPending, setRecheckPending] = useState(false);
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);
  const deps = task.dependencies ?? [];
  if (deps.length === 0) return null;

  const depHref = (n: number) =>
    forgejoBaseUrl && task.repo
      ? `${forgejoBaseUrl}/${task.repo.owner}/${task.repo.name}/issues/${n}`
      : null;

  async function handleRecheck() {
    if (recheckPending) return;
    setRecheckPending(true);
    try {
      await api.recheckDependencies(task.id);
      onChanged(await api.getTask(task.id));
    } catch {
      // Best effort — the scheduler re-checks on its own cadence.
    } finally {
      setRecheckPending(false);
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-medium">Dependencies</h2>
        <button
          onClick={handleRecheck}
          disabled={recheckPending}
          className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300 disabled:opacity-50"
        >
          {recheckPending ? 'Checking…' : 'Re-check now'}
        </button>
      </div>
      {task.blocked && (
        <p className="text-sm text-amber-400 mb-3">
          This task stays queued until every dependency below is satisfied.
          Dependencies live in the issue body on Forgejo — remove a line to
          drop one, or tick its box to override.
        </p>
      )}
      <div className="space-y-2">
        {deps.map((dep) => (
          <DependencyRow key={dep.id} dep={dep} href={depHref(dep.dep_issue_number)} />
        ))}
      </div>
    </section>
  );
}

function DependencyRow({
  dep,
  href,
}: {
  dep: TaskDependencyResponse;
  href: string | null;
}) {
  const hint = DEP_STATE_HINTS[dep.state];
  return (
    <div className="flex items-start gap-3 bg-gray-900 border border-gray-800 rounded p-3">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 font-mono text-sm hover:underline"
        >
          #{dep.dep_issue_number}
        </a>
      ) : (
        <span className="text-blue-400 font-mono text-sm">
          #{dep.dep_issue_number}
        </span>
      )}
      <DependencyStateBadge state={dep.state} />
      <div className="text-sm min-w-0">
        {dep.detail && <span className="text-gray-300">{dep.detail}</span>}
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

function FailureBanner({ task }: { task: TaskDetailResponse }) {
  // All the selection logic lives in `deriveLastFailure` (pure, unit-tested);
  // this component only picks a heading and renders the server's message
  // verbatim — the server owns the wording in both cases.
  const failure = deriveLastFailure(task.events, task.status);
  if (!failure) return null;

  return (
    <section
      className="rounded border border-red-700 bg-red-950/40 px-4 py-3"
      role="alert"
    >
      <h2 className="text-red-300 font-medium mb-1">
        {failure.kind === 'structural' ? (
          'Task blocked — operator action needed'
        ) : (
          <>
            Task failed —{' '}
            {/* The raw event_type, not a prettified label: it is what the
                operator greps the server logs and source for, and a lookup
                table of human names would silently render a new failure
                type as "undefined". `break-all` keeps a long type from
                widening the panel at 375px. */}
            <span className="font-mono text-sm break-all">
              {failure.event.event_type}
            </span>
          </>
        )}
      </h2>
      <p className="text-sm text-gray-200 whitespace-pre-wrap">
        {failure.event.message}
      </p>
    </section>
  );
}

function AgentOutput({
  taskId,
  isRunning,
}: {
  taskId: number;
  isRunning: boolean;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [complete, setComplete] = useState(!isRunning);
  const [verbose, setVerbose] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // True until the user scrolls up; keeps the panel following new output.
  const atBottomRef = useRef(true);

  useEffect(() => {
    const handler = (event: OutputWsEvent) => {
      switch (event.type) {
        case 'replay':
          setLines(event.data.split('\n').filter(Boolean));
          break;
        case 'output':
          setLines((prev) => [
            ...prev,
            ...event.data.split('\n').filter(Boolean),
          ]);
          break;
        case 'stream_complete':
          setComplete(true);
          break;
      }
    };

    const disconnect = connectOutputWs(taskId, handler);
    return disconnect;
  }, [taskId]);

  // Sticky-bottom: scroll the panel (never the window) after new lines render,
  // but only when the user is already near the bottom.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !atBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [lines, verbose]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    atBottomRef.current = scrollHeight - (scrollTop + clientHeight) < 32;
  }

  const displayLines = useMemo(
    () => lines.map((line) => filterLogLine(line, verbose)),
    [lines, verbose],
  );

  const hiddenCount = verbose ? 0 : displayLines.filter((l) => !l.show).length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* "N verbose lines hidden" beside the Verbose/Terse toggle and the
          Live chip overflows 375px; the gaps only take effect once a line
          wraps, so the desktop bar is the same single row as before. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 border-b border-gray-800 text-sm">
        <div className="flex items-center gap-3">
          <span className="text-gray-400">progress.log</span>
          {hiddenCount > 0 && (
            <span className="text-gray-500 text-xs italic">
              {hiddenCount} verbose lines hidden
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setVerbose((v) => !v)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              verbose
                ? 'border-blue-700 text-blue-400 bg-blue-950/50'
                : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'
            }`}
          >
            {verbose ? 'Verbose' : 'Terse'}
          </button>
          {!complete && (
            <span className="text-green-400 animate-pulse">Live</span>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="max-h-96 overflow-y-auto p-4 font-mono text-xs text-gray-300 whitespace-pre-wrap"
      >
        {lines.length === 0 ? (
          <span className="text-gray-500">
            {isRunning ? 'Waiting for output...' : 'No output available'}
          </span>
        ) : (
          displayLines.map((l, origIdx) =>
            l.show ? <div key={origIdx}>{l.content}</div> : null
          )
        )}
      </div>
    </div>
  );
}

/** True once a running attempt has burned more than 80% of the timeout
 *  snapshotted at its launch — the point at which the elapsed time is worth
 *  looking at, because the orchestrator will kill the run at 100%. False
 *  when no snapshot exists (pre-v22 attempts): there is no budget to be near.
 *  Pure; `now` is injected so tests need no clock. */
export function isNearTimeout(
  startedAt: string,
  timeoutMinutes: number | null,
  now: number = Date.now()
): boolean {
  if (timeoutMinutes == null || timeoutMinutes <= 0) return false;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return false;
  return now - started > timeoutMinutes * 60_000 * 0.8;
}

/** Live "elapsed / budget" for a running attempt, e.g. `3m / 30m`.
 *
 *  Subscribes to the shared 1s ticker in its own right even though the
 *  nested `Elapsed` already does: the near-timeout tint is decided here, so
 *  this component must re-render for the text to turn yellow. Same shared
 *  interval — no extra timer. */
function RunningDuration({
  startedAt,
  timeoutMinutes,
}: {
  startedAt: string;
  timeoutMinutes: number | null;
}) {
  useTicker(1_000);
  const near = isNearTimeout(startedAt, timeoutMinutes);
  return (
    <span
      className={near ? 'text-yellow-400' : undefined}
      title={
        timeoutMinutes == null
          ? 'Running'
          : `Running — the orchestrator stops this attempt at ${timeoutMinutes}m`
      }
    >
      <Elapsed startedAt={startedAt} />
      {timeoutMinutes != null && ` / ${timeoutMinutes}m`}
    </span>
  );
}

function AttemptRow({ attempt }: { attempt: AttemptResponse }) {
  const duration =
    attempt.started_at && attempt.completed_at
      ? formatDuration(
          new Date(attempt.completed_at).getTime() -
            new Date(attempt.started_at).getTime()
        )
      : attempt.started_at
        ? 'running'
        : '-';
  // Non-null `started_at` on a running attempt is what makes a live elapsed
  // time meaningful; without it there is nothing to count from.
  const runningSince =
    attempt.status === 'running' ? attempt.started_at : null;
  const failureReason =
    (attempt.status === 'failed' || attempt.status === 'timeout') &&
    attempt.error_message
      ? attempt.error_message
      : null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-4">
      {/* Role, status, verdict, duration and the harness/model id do not fit
          one 375px line. Wrapping (plus `min-w-0` so each cluster may shrink
          rather than push the card wider) keeps every field readable; at
          desktop widths nothing wraps and `justify-between` still spreads
          the two clusters to the card edges exactly as before. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="text-sm font-medium">
            Attempt {attempt.attempt_number}
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-300">
            {attempt.role}
          </span>
          <AttemptStatusBadge status={attempt.status} />
          {attempt.verdict && (
            <span className="text-xs text-gray-400">
              Verdict: {attempt.verdict}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400">
          {runningSince ? (
            <RunningDuration
              startedAt={runningSince}
              timeoutMinutes={attempt.timeout_minutes_snapshot}
            />
          ) : (
            <span>{duration}</span>
          )}
          {attempt.model_id && (
            /* `break-words` is the safety net for a long harness/model id,
               which has no space to wrap at: it only engages when the id is
               wider than the line, so desktop is untouched. */
            <span className="font-mono text-xs min-w-0 break-words">
              {attempt.harness_id ? `${attempt.harness_id} · ` : ''}
              {attempt.model_id}
            </span>
          )}
        </div>
      </div>
      <AttemptUsage attempt={attempt} />
      {/* Why the attempt ended (v32), straight from the harness's
          result.json. Above the review feedback because it explains the
          badge beside the attempt number; `break-words` keeps a long
          single-token message (a path, a URL) inside the card at 375px. */}
      {failureReason && (
        <div className="mt-2 text-xs text-red-400 break-words">
          {failureReason}
          {attempt.exit_code != null && ` (exit code ${attempt.exit_code})`}
        </div>
      )}
      {attempt.feedback && (
        <div className="mt-3 text-xs text-gray-400 border-t border-gray-800 pt-2">
          <details>
            <summary className="cursor-pointer hover:text-gray-300">
              Review feedback
            </summary>
            <pre className="mt-2 whitespace-pre-wrap">
              {attempt.feedback}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

/** Per-run effort metrics (#115): agent turns + input/output token counts,
 *  read from the harness at completion. Each is nullable — a harness that
 *  emitted no usage leaves the column NULL, which renders as "—" (never 0).
 *  Raw token counts only; no dollar cost is shown. The whole strip is hidden
 *  when the attempt reports none of the four metrics (e.g. a still-running
 *  attempt, or a pre-#115 row). */
function AttemptUsage({ attempt }: { attempt: AttemptResponse }) {
  const {
    num_turns,
    input_tokens,
    output_tokens,
    tool_calls,
    changed_files,
    additions,
    deletions,
  } = attempt;
  const hasUsage =
    num_turns != null ||
    input_tokens != null ||
    output_tokens != null ||
    tool_calls != null;
  // PR diff stats (#116) are captured on the review attempt at review/merge
  // time. Shown whenever any of the three is present (a review harness may
  // report churn but no token usage). NULL renders as "—", never 0.
  const hasDiff =
    changed_files != null || additions != null || deletions != null;
  if (!hasUsage && !hasDiff) {
    return null;
  }
  const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString());
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
      {hasUsage && (
        <>
          <span title="Agent turns">Turns: <span className="text-gray-300 tabular-nums">{fmt(num_turns)}</span></span>
          <span title="Input (prompt) tokens">In: <span className="text-gray-300 tabular-nums">{fmt(input_tokens)}</span></span>
          <span title="Output (completion) tokens">Out: <span className="text-gray-300 tabular-nums">{fmt(output_tokens)}</span></span>
          {tool_calls != null && (
            <span title="Tool calls">Tools: <span className="text-gray-300 tabular-nums">{fmt(tool_calls)}</span></span>
          )}
        </>
      )}
      {hasDiff && (
        <>
          <span title="Files changed in the PR">Files: <span className="text-gray-300 tabular-nums">{fmt(changed_files)}</span></span>
          <span title="Lines added in the PR">Diff: <span className="text-green-400 tabular-nums">+{fmt(additions)}</span> <span className="text-red-400 tabular-nums">-{fmt(deletions)}</span></span>
        </>
      )}
    </div>
  );
}

/** The orphaned-container warning. Deliberately not a general health badge:
 *  `healthy` needs no chrome and `idle` describes every queued/terminal task,
 *  so the call site renders this only for `orphaned`. */
function HealthBadge() {
  return (
    <span
      className="px-2 py-1 rounded text-xs font-medium bg-orange-900 text-orange-200 border border-orange-700"
      title="The task's container has disappeared. The orchestrator will attempt recovery on the next sweep."
    >
      orphaned
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    'in-progress': 'bg-blue-900 text-blue-300',
    'in-review': 'bg-purple-900 text-purple-300',
    'changes-needed': 'bg-yellow-900 text-yellow-300',
    preparing: 'bg-gray-700 text-gray-300',
    queued: 'bg-gray-700 text-gray-300',
    merged: 'bg-green-900 text-green-300',
    failed: 'bg-red-900 text-red-300',
    cancelled: 'bg-gray-700 text-gray-400',
    'awaiting-human-merge': 'bg-orange-900 text-orange-300',
    'awaiting-human-review': 'bg-orange-900 text-orange-300',
    'needs-human-review': 'bg-orange-900 text-orange-300',
  };

  return (
    <span
      className={`px-2 py-1 rounded text-sm font-medium ${colors[status] ?? 'bg-gray-700 text-gray-300'}`}
    >
      {status}
    </span>
  );
}

function AttemptStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-blue-900 text-blue-300',
    completed: 'bg-green-900 text-green-300',
    failed: 'bg-red-900 text-red-300',
    timeout: 'bg-yellow-900 text-yellow-300',
  };

  return (
    <span
      className={`text-xs px-2 py-0.5 rounded ${colors[status] ?? 'bg-gray-700 text-gray-300'}`}
    >
      {status}
    </span>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
