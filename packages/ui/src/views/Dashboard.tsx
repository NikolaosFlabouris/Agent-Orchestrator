import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ACTIVE_STATUSES, useStore } from '../store.js';
import { api } from '../api.js';
import type { StatusResponse, TaskResponse, RepoResponse } from '../api.js';
import type { HostPool } from '../ws.js';
import { AlertBanner } from '../components/AlertBanner.js';
import { AppHeader } from '../components/AppHeader.js';
import { Elapsed, TimeAgo } from '../components/LiveTime.js';
import { QueueList } from '../components/QueueList.js';
import { KpiCard } from '../components/KpiCard.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Button } from '../components/Button.js';
import { formatNumber, formatPercent } from '../components/reportFormat.js';
import { defaultRange, previousRange } from '../components/reportFilter.js';
import type { ReportsOverview } from '@orchestrator/shared';

// Cap on the homepage Recent list, chosen by the operator from the select in
// the Recent header. The full, paginated history lives on the Reports "All
// tasks" browser (linked via "View all"); the Active and Queue sections stay
// unbounded as they're operationally important. Tune freely.
const RECENT_LIMIT_OPTIONS = [5, 10, 20, 50, 100];
const DEFAULT_RECENT_LIMIT = 10;

// `limit` sent with the /api/tasks refresh — the same value the route
// defaults to, stated explicitly because `syncTasks` needs to know it to
// tell a complete response from a truncated one before it prunes anything.
const TASKS_FETCH_LIMIT = 20;

/** How many rows the /api/tasks poll asks for, given the Recent selection.
 *  The route truncates only the completed bucket to `limit`, so a selection
 *  above the default has to be requested explicitly or the list can never
 *  fill; smaller selections keep asking for the default so shrinking the
 *  list doesn't throw away rows the store already holds. Exported for the
 *  unit test that pins the fetch-limit/`completedLimit` equality. */
export function tasksFetchLimit(recentLimit: number): number {
  return Math.max(TASKS_FETCH_LIMIT, recentLimit);
}

/** One /api/tasks refresh. Lives outside the component because the poll
 *  interval (created once, on mount) calls it with whatever the current
 *  selection is, rather than the one captured when the interval was set up.
 *
 *  The REST response overlays the Forgejo-derived status over the raw
 *  `tasks.status` the WS snapshot carries, so closed-issue/merged-PR reality
 *  overrides stale local rows.
 *
 *  `syncTasks` (not a per-row updateTask loop): it upserts, so this poll
 *  heals a `task_created` event we never received, and it converges on the
 *  server's view instead of only ever growing. The id set is captured BEFORE
 *  the request so a task created over the WebSocket while it's in flight
 *  isn't pruned by a response that predates it; the limit lets syncTasks
 *  refuse to prune from a truncated response — which is why the value sent
 *  as `limit` and the one passed as `completedLimit` must be identical.
 *  See syncTasks for the full rule. */
export function refreshTasks(recentLimit: number) {
  const { tasks, syncTasks } = useStore.getState();
  const knownIds = new Set(tasks.map((t) => t.id));
  const limit = tasksFetchLimit(recentLimit);
  api
    .getTasks({ limit })
    .then((res) => syncTasks(res.tasks, { knownIds, completedLimit: limit }))
    .catch(() => {});
}

export function Dashboard() {
  // Selector-based subscriptions: each call subscribes only to its
  // slice, so Dashboard re-renders only when a slice it actually
  // reads changes — not on every store mutation. Action references
  // are stable across renders, so the action selectors are
  // effectively free (Object.is returns true on every read).
  const tasks = useStore((s) => s.tasks);
  const hostPool = useStore((s) => s.hostPool);
  const queueDepth = useStore((s) => s.queueDepth);
  const paused = useStore((s) => s.paused);
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);
  const alerts = useStore((s) => s.alerts);
  const dismissAlert = useStore((s) => s.dismissAlert);

  const setStatus = useStore((s) => s.setStatus);
  const setHostPool = useStore((s) => s.setHostPool);
  // Subscribe to the profiles version. The WS handler bumps this
  // whenever `resource_changed:profiles` arrives; the dedicated
  // useEffect below re-fetches in response. Previously the WS handler
  // ALSO inline-fetched, which was a redundant second request from
  // the same browser (and skipped the debounce). (L)
  const profilesVersion = useStore((s) => s.resourceVersions.profiles);
  const setAgentProfiles = useStore((s) => s.setAgentProfiles);

  const [pools, setPools] = useState<StatusResponse['providers']>([]);
  const [repos, setRepos] = useState<RepoResponse[]>([]);
  // How many completed tasks the Recent list shows. Deliberately not
  // persisted — a fresh load starts at the default.
  const [recentLimit, setRecentLimit] = useState(DEFAULT_RECENT_LIMIT);
  // True once a status poll has failed and no later one has succeeded. The
  // header keeps rendering the last-known pool figures — blanking them would
  // be worse than showing slightly old ones — so this flag is what stops
  // those figures from silently passing as current.
  const [statusStale, setStatusStale] = useState(false);
  const recentLimitSelectId = useId();
  // The task poll is an interval created once on mount, so its callback
  // reads the selection through a ref instead of closing over it. Putting
  // `recentLimit` in that effect's deps would instead tear down and rebuild
  // both polls (resetting their clocks) on every change of the select.
  const recentLimitRef = useRef(recentLimit);

  useEffect(() => {
    // Actions are pulled from `getState()` inside the effect so we
    // don't add subscriptions for things we only invoke (never read
    // as values). Same identity guarantee as the selector pattern,
    // just without the unused subscription overhead.
    //
    // The dashboard WebSocket is NOT opened here — it's owned app-wide by
    // <LiveData> in main.tsx so it survives navigation. This effect only
    // owns the REST polls, which are per-view.
    const { setForgejoBaseUrl, setHostPool: setHostPoolFn, setAlerts } =
      useStore.getState();

    // Both timers below are RECONCILIATION BACKSTOPS, not the data path.
    // Everything they fetch is pushed over the WebSocket as it happens:
    // task creation, every task mutation (including externally-driven ones),
    // and `status_changed` on each slot acquire/release as well as on
    // pause/resume. The polls exist only to heal a frame that never arrived
    // — a dropped event, a missed webhook — which is a real failure mode in
    // this system, the same one the server's own `Poller` covers. So they
    // stay, at a cadence measured in minutes rather than seconds.
    //
    // `GET /api/status` also carries per-provider `active_slots`, which has
    // no push equivalent; that is the one thing genuinely sampled here, and
    // it moves only when a container starts or stops.
    const STATUS_POLL_MS = 60_000;
    // Deliberately not a multiple of the server's snapshot TTL (90s, see
    // `DEFAULT_TTL_MS` in forgejo-snapshot.ts). At the old 30s/30s the two
    // resonated: every poll arrived just as the cache expired, so nearly all
    // of them paid for the full paginated Forgejo walk.
    const TASKS_POLL_MS = 300_000;

    // Pull status on mount and every STATUS_POLL_MS.
    const refresh = () => {
      api.getStatus().then((s) => {
        setForgejoBaseUrl(s.forgejo_base_url);
        setHostPoolFn({
          memory_used_mb: s.host_pool.memory_used_mb,
          memory_total_mb: s.host_pool.memory_total_mb,
          cpu_used_cores: s.host_pool.cpu_used_cores,
          cpu_total_cores: s.host_pool.cpu_total_cores,
        });
        setPools(s.providers ?? []);
        setStatusStale(false);
      }).catch(() => setStatusStale(true));
      // Alerts ride the same tick rather than getting their own timer: they
      // are the same kind of slow-moving operational state, and one cadence
      // is one thing to reason about. They stay a SEPARATE request because
      // `checkAlerts` walks every task plus its active attempt and resolved
      // profile — folding that into /api/status would put a full table walk
      // on the path the header's pool figures depend on. A failure is
      // swallowed: the previous set stays on screen until the next tick,
      // which is strictly better than blanking the banner on one bad poll.
      api.getAlerts().then((res) => setAlerts(res.alerts)).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);

    // Pull the task list through the REST API as well, every TASKS_POLL_MS,
    // so driver-label / issue-closure changes reach the UI even if a webhook
    // was dropped. (The refresh ON mount is owned by the `recentLimit`
    // effect below, which also runs on every change of the selection.)
    const tasksTimer = window.setInterval(
      () => refreshTasks(recentLimitRef.current),
      TASKS_POLL_MS
    );

    // Fetch repos once on mount for the Repos strip
    api.getRepos().then((res) => setRepos(res.repos)).catch(() => {});

    return () => {
      window.clearInterval(timer);
      window.clearInterval(tasksTimer);
    };
  }, []);

  // Fetch on mount, and again whenever the Recent selection changes: picking
  // a larger count has to fill the list now, not at the next poll tick, and
  // the store may hold fewer completed rows than the new selection.
  useEffect(() => {
    recentLimitRef.current = recentLimit;
    refreshTasks(recentLimit);
  }, [recentLimit]);

  // Agent profile list is held in the store for display in task rows.
  // Subscribe to the version counter and refetch when it ticks; runs
  // once on mount (profilesVersion starts at 0) and on every WS
  // `resource_changed:profiles` bump after debouncing.
  useEffect(() => {
    api
      .getAgentProfiles()
      .then((res) => setAgentProfiles(res.profiles))
      .catch(() => {});
  }, [profilesVersion, setAgentProfiles]);

  const activeTasks = tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  const queuedTasks = tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0));
  const completedTasks = tasks
    .filter((t) => !ACTIVE_STATUSES.has(t.status) && t.status !== 'queued')
    .sort((a, b) => {
      const aNull = a.completed_at === null;
      const bNull = b.completed_at === null;
      if (aNull && bNull) return b.created_at.localeCompare(a.created_at);
      if (aNull) return -1;
      if (bNull) return 1;
      return b.completed_at!.localeCompare(a.completed_at!);
    });
  const recentTasks = completedTasks.slice(0, recentLimit);

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader title="Agent Orchestrator">
        <span className={paused ? 'text-yellow-400' : 'text-green-400'}>
          {paused ? 'Paused' : 'Running'}
        </span>
        <HostPoolDisplay pool={hostPool} stale={statusStale} />
        <span>Queue: {queueDepth}</span>
        <Button
          variant={paused ? 'tonal-success' : 'tonal-warn'}
          onClick={async () => {
            if (paused) {
              await api.resume();
              setStatus({ paused: false, hostPool, queueDepth });
            } else {
              await api.pause();
              setStatus({ paused: true, hostPool, queueDepth });
            }
          }}
          className="px-3 py-1 text-xs font-medium"
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Link to="/reports" className="text-blue-400 hover:text-blue-300">
          Reports
        </Link>
        <Link to="/settings" className="text-blue-400 hover:text-blue-300">
          Settings
        </Link>
        <Link to="/help" className="text-blue-400 hover:text-blue-300">
          Help
        </Link>
        {forgejoBaseUrl && (
          <a
            href={forgejoBaseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-400 hover:text-blue-300"
          >
            Forgejo ↗
          </a>
        )}
      </AppHeader>

       {pools.length > 0 && (
         <div className="border-b border-gray-800 bg-gray-900/60 px-6 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
           <span className="text-gray-500 uppercase tracking-wide">
             Pools
           </span>
           {pools.map((p) => {
             const full =
               p.concurrency_limit > 0 &&
               p.active_slots >= p.concurrency_limit;
             const isPaused = p.concurrency_limit === 0;
             return (
               <span
                 key={p.id}
                 /* `break-words` only engages when a single provider name is
                    wider than the strip, so desktop is untouched; without it
                    a long unbroken display name widens the document at
                    375px instead of wrapping. */
                 className={`min-w-0 break-words ${
                   isPaused
                     ? 'text-yellow-400'
                     : full
                       ? 'text-orange-400'
                       : 'text-gray-300'
                 }`}
                 title={
                   isPaused
                     ? `${p.display_name}: paused (concurrency_limit = 0)`
                     : full
                       ? `${p.display_name}: at limit — candidate tasks on this provider will wait`
                       : `${p.display_name}: ${p.concurrency_limit - p.active_slots} slot(s) free`
                 }
               >
                 {p.display_name}: {p.active_slots}/{p.concurrency_limit}
                 {isPaused ? ' (paused)' : ''}
               </span>
             );
           })}
         </div>
       )}

       {repos.length > 0 && forgejoBaseUrl && (
         <div className="border-b border-gray-800 bg-gray-900/60 px-6 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
           <span className="text-gray-500 uppercase tracking-wide">Repos</span>
           {repos.map((r) => (
             <a
               key={r.id}
               href={`${forgejoBaseUrl}/${r.owner}/${r.name}`}
               target="_blank"
               rel="noreferrer noopener"
               /* Same rationale as the Pools strip: `owner/name` has no
                  natural break opportunity, so a long repo slug would
                  overflow the viewport rather than wrap. */
               className="min-w-0 break-words text-gray-300 hover:text-blue-300"
             >
               {r.owner}/{r.name} ↗
             </a>
           ))}
         </div>
       )}

       <AlertBanner alerts={alerts} onDismiss={dismissAlert} />

      <KpiStrip />

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-8">
        {/* Active tasks */}
        <section>
          <h2 className="text-lg font-medium mb-3">
            Active ({activeTasks.length})
          </h2>
          {activeTasks.length === 0 ? (
            <p className="text-gray-500 text-sm">No active tasks</p>
          ) : (
            <div className="grid gap-3">
              {activeTasks.map((task) => (
                <ActiveTaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </section>

        {/* Queue */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-medium">
              Queue ({queuedTasks.length})
              {queuedTasks.some((t) => t.blocked) && (
                <span className="ml-2 px-2 py-0.5 rounded text-xs font-medium bg-amber-900 text-amber-300 align-middle">
                  {queuedTasks.filter((t) => t.blocked).length} blocked
                </span>
              )}
            </h2>
            <Link
              to="/tasks/new"
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              + Add task
            </Link>
          </div>
          {queuedTasks.length === 0 ? (
            <p className="text-gray-500 text-sm">Queue is empty</p>
          ) : (
            <QueueList tasks={queuedTasks} />
          )}
        </section>

        {/* Recent completions — capped at the operator's selection; the full
            history lives on the Reports "All tasks" browser. */}
        <section>
          {/* Three items (heading, size select, "View all") do not fit on one
              375px line, so the row wraps; `sm:flex-nowrap` keeps the desktop
              row the single line it has always been. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-3 sm:flex-nowrap">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-lg font-medium">
                Recent
                {completedTasks.length > recentLimit
                  ? ` (${recentTasks.length} of ${completedTasks.length})`
                  : ` (${completedTasks.length})`}
              </h2>
              <label
                htmlFor={recentLimitSelectId}
                className="text-xs text-gray-500"
              >
                Show
              </label>
              <select
                id={recentLimitSelectId}
                value={recentLimit}
                onChange={(e) => setRecentLimit(Number(e.target.value))}
                title="How many recently completed tasks to list"
                className="min-h-11 min-w-0 max-w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs sm:min-h-0"
              >
                {RECENT_LIMIT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            {completedTasks.length > 0 && (
              <Link
                to="/reports#all-tasks"
                className="text-sm text-blue-400 hover:text-blue-300"
              >
                View all →
              </Link>
            )}
          </div>
          {completedTasks.length === 0 ? (
            <p className="text-gray-500 text-sm">No completed tasks</p>
          ) : (
            <div className="space-y-2">
              {recentTasks.map((task) => (
                <CompletedItem key={task.id} task={task} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function ToolChip({ task }: { task: TaskResponse }) {
  const profiles = useStore((s) => s.agentProfiles);
  const profileId = task.effective_agent_profile_id;
  if (!profileId) return null;

  const found = profiles.find((p) => p.id === profileId);
  const name = found?.display_name ?? profileId;
  const truncated = name.length > 25 ? name.slice(0, 24) + '…' : name;
  const source = task.agent_profile_source;
  const isOverride = source === 'task';
  const sourceLabel =
    source === 'task'
      ? 'task override'
      : source === 'repo'
        ? 'repo default'
        : source === 'global'
          ? 'global default'
          : 'unset';

  // Second chip only when the review stage resolves to a different
  // profile — the common single-profile setup stays visually unchanged.
  const reviewId = task.effective_review_agent_profile_id;
  const reviewDiffers = reviewId !== null && reviewId !== profileId;
  const reviewFound = reviewDiffers
    ? profiles.find((p) => p.id === reviewId)
    : undefined;
  const reviewName = reviewFound?.display_name ?? reviewId ?? '';
  const reviewTruncated =
    reviewName.length > 25 ? reviewName.slice(0, 24) + '…' : reviewName;
  const reviewSource = task.review_agent_profile_source;
  const reviewIsOverride = reviewSource === 'task';
  const reviewSourceLabel =
    reviewSource === 'task'
      ? 'task override'
      : reviewSource === 'repo'
        ? 'repo review default'
        : reviewSource === 'global'
          ? 'global review default'
          : 'implementation profile';

  return (
    <>
      <span
        /* `truncate` is whitespace-nowrap, so without `max-w-full` a long
           profile name is free to push past the card edge at 375px — the
           cap only binds below the widths desktop ever reaches. */
        className={`text-xs font-mono truncate max-w-full ${isOverride ? 'text-blue-400' : 'text-gray-500'}`}
        title={`${name} (${sourceLabel})`}
      >
        {isOverride && <span className="mr-0.5">•</span>}
        {truncated}
      </span>
      {reviewDiffers && (
        <span
          className={`text-xs font-mono truncate max-w-full ${reviewIsOverride ? 'text-blue-400' : 'text-gray-500'}`}
          title={`Review: ${reviewName} (${reviewSourceLabel})`}
        >
          ⮑ {reviewTruncated}
        </span>
      )}
    </>
  );
}

function ActiveTaskCard({ task }: { task: TaskResponse }) {
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);

  const issueHref =
    forgejoBaseUrl && task.repo
      ? `${forgejoBaseUrl}/${task.repo.owner}/${task.repo.name}/issues/${task.issue_id}`
      : null;

  const phaseLabel: Record<string, string> = {
    preparing: 'Preparing',
    'in-progress': 'Implementing',
    'in-review': 'Reviewing',
    'changes-needed': 'Reworking',
  };

  return (
    /* Stretched link: the card is the positioning context, and the task
       title below is a real <Link> whose `after:inset-0` overlay covers it.
       Navigation therefore goes through an <a href>, so middle-click and
       ctrl/cmd+click open the task in a new tab — which an onClick+navigate
       <div role="link"> could never offer. Anything else that must stay
       clickable (the Forgejo issue link) is raised above the overlay with
       `relative z-10`. */
    <div className="relative block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors cursor-pointer">
      {/* Below `sm` the metadata cluster gets its own line under the title
          instead of being squeezed against it; `sm:` restores the original
          single centred row (flex `gap: normal` computes to 0, so
          `sm:gap-0` is the same box the row has always had). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-0">
        <div className="flex min-w-0 items-center gap-2">
          {task.health === 'orphaned' && (
            <span
              className="inline-block shrink-0 w-2 h-2 rounded-full bg-orange-400"
              title="Orphaned — container has disappeared. Orchestrator will attempt recovery."
              aria-label="Orphaned"
            />
          )}
          {/* `min-w-0` lets this block shrink inside the flex row and
              `truncate` ends the line with an ellipsis rather than pushing
              the issue title (and the metadata behind it) off-screen. */}
          <div className="min-w-0 truncate">
            {issueHref ? (
              /* Sibling of the task link, never a child of it — nested <a>
                 elements are invalid — and `relative z-10` keeps it above
                 the stretched overlay so it still opens Forgejo. */
              <a
                href={issueHref}
                target="_blank"
                rel="noreferrer noopener"
                className="relative z-10 text-blue-400 font-mono text-sm hover:underline"
              >
                #{task.issue_id}
              </a>
            ) : (
              <span className="text-blue-400 font-mono text-sm">
                #{task.issue_id}
              </span>
            )}{' '}
            <Link
              to={`/tasks/${task.id}`}
              className="font-medium after:absolute after:inset-0 after:content-['']"
            >
              {task.issue_title}
            </Link>
            {task.repo && (
              <span className="text-gray-500 text-sm ml-2">
                {task.repo.owner}/{task.repo.name}
              </span>
            )}
          </div>
        </div>
        {/* Wraps internally at 375px (tool chip / badge / attempt / elapsed
            are four separate items); `sm:flex-nowrap` plus the unchanged
            4-unit column gap keeps the desktop row identical. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:flex-nowrap">
          <ToolChip task={task} />
          <StatusBadge status={task.status} label={phaseLabel[task.status]} />
          <span className="text-gray-400">
            Attempt {task.attempt}/{task.max_attempts}
          </span>
          {task.started_at && (
            <span className="text-gray-500">
              {/* Self-ticking leaf: the duration advances every second
                  without a server event, and only this span re-renders. */}
              <Elapsed startedAt={task.started_at} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function CompletedItem({ task }: { task: TaskResponse }) {
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);

  const issueHref =
    forgejoBaseUrl && task.repo
      ? `${forgejoBaseUrl}/${task.repo.owner}/${task.repo.name}/issues/${task.issue_id}`
      : null;

  return (
    /* Stretched link — same pattern as ActiveTaskCard: `relative` row, the
       title is the real <a href> and its `after:inset-0` overlay makes the
       whole row open in a new tab on middle- / ctrl-click. */
    <div className="relative flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-0 bg-gray-900 border border-gray-800 rounded p-3 hover:border-gray-700 transition-colors cursor-pointer">
      <div className="min-w-0 truncate">
        {issueHref ? (
          <a
            href={issueHref}
            target="_blank"
            rel="noreferrer noopener"
            className="relative z-10 text-blue-400 font-mono text-sm hover:underline"
          >
            #{task.issue_id}
          </a>
        ) : (
          <span className="text-blue-400 font-mono text-sm">
            #{task.issue_id}
          </span>
        )}{' '}
        <Link
          to={`/tasks/${task.id}`}
          className="after:absolute after:inset-0 after:content-['']"
        >
          {task.issue_title}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:flex-nowrap">
        <ToolChip task={task} />
        <StatusBadge status={task.status} />
        <span className="text-gray-500">
          {task.attempt} attempt{task.attempt !== 1 ? 's' : ''}
        </span>
        {task.completed_at && (
          <span className="text-gray-500">
            <TimeAgo date={task.completed_at} />
          </span>
        )}
      </div>
    </div>
  );
}

/** Compact, non-interactive KPI strip over a fixed last-30-days window.
 *  Reuses the Reports page KpiCard (compact variant) and links through to
 *  the full Reports view. A reporting hiccup must never break the
 *  operational Dashboard, so a failed fetch degrades to a one-line "Stats
 *  unavailable" note rather than taking the page down — but it is a note,
 *  not nothing: rendering an empty strip made a broken reports endpoint
 *  indistinguishable from a still-loading one, forever. */
const STRIP_WINDOW_DAYS = 30;

function KpiStrip() {
  const [overview, setOverview] = useState<ReportsOverview | null>(null);
  const [prev, setPrev] = useState<ReportsOverview | null>(null);
  // Only the primary-window fetch sets this. The comparison window is
  // decoration (it renders the deltas); losing it alone is not worth a
  // banner, so its failure leaves the strip fully populated minus arrows.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = defaultRange(STRIP_WINDOW_DAYS);
    const previous = previousRange(from, to);
    api
      .getReportOverview({ from, to })
      .then((res) => !cancelled && setOverview(res))
      .catch(() => !cancelled && setFailed(true));
    if (previous) {
      api
        .getReportOverview({ from: previous.from, to: previous.to })
        .then((res) => !cancelled && setPrev(res))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (!overview) {
    if (!failed) return null; // still in flight — no placeholder flash
    return (
      <div className="border-b border-gray-800 bg-gray-900/40 px-6 py-3">
        <p className="mx-auto max-w-7xl text-xs text-gray-500">
          Stats unavailable
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-gray-800 bg-gray-900/40 px-6 py-3">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
        <Link
          to="/reports"
          className="text-xs uppercase tracking-wide text-gray-500 hover:text-blue-300"
          title="Open the full Reports view"
        >
          Last 30 days ↗
        </Link>
        {/* Below `sm` the three tiles cannot sit side by side at 375px —
            "Success rate" alone wraps its label at a third of that width —
            so they stack, and `w-full` (no flex-basis of 0) pushes the grid
            onto its own wrapped line under the "Last 30 days" link. From
            `sm` up, `sm:w-auto sm:flex-1` restores the original
            `flex-1 grid-cols-3` row exactly. */}
        <div className="grid w-full grid-cols-1 gap-3 sm:w-auto sm:flex-1 sm:grid-cols-3">
          <KpiCard
            compact
            label="Merged"
            value={overview.throughput.tasks_merged}
            previous={prev?.throughput.tasks_merged}
            format={formatNumber}
            polarity="higher-good"
          />
          <KpiCard
            compact
            label="Success rate"
            value={overview.success_rate}
            previous={prev?.success_rate ?? null}
            format={(v) => formatPercent(v)}
            polarity="higher-good"
          />
          <KpiCard
            compact
            label="Backlog"
            value={overview.backlog.queued}
            format={formatNumber}
            polarity="lower-good"
            sub={overview.backlog.blocked > 0 ? `${overview.backlog.blocked} blocked` : undefined}
          />
        </div>
      </div>
    </div>
  );
}

function HostPoolDisplay({ pool, stale }: { pool: HostPool; stale?: boolean }) {
  const memPct = pool.memory_total_mb > 0
    ? Math.round((pool.memory_used_mb / pool.memory_total_mb) * 100)
    : 0;
  const cpuPct = pool.cpu_total_cores > 0
    ? Math.round((pool.cpu_used_cores / pool.cpu_total_cores) * 100)
    : 0;
  const memColor = memPct >= 100 ? 'text-orange-400' : memPct >= 80 ? 'text-yellow-400' : '';
  const cpuColor = cpuPct >= 100 ? 'text-orange-400' : cpuPct >= 80 ? 'text-yellow-400' : '';
  const memGb = (pool.memory_total_mb / 1024).toFixed(1);
  const usedGb = (pool.memory_used_mb / 1024).toFixed(1);
  return (
    <span title={`Host resource pool: memory ${pool.memory_used_mb}/${pool.memory_total_mb} MB · CPU ${pool.cpu_used_cores}/${pool.cpu_total_cores} cores`}>
      {stale && (
        /* The numbers beside this dot are the last ones that arrived, and
           the poll that should have refreshed them failed. Marking them
           beats both blanking the figures and letting stale ones pass as
           current — the WebSocket keeps pushing pool changes, so they are
           usually still right, just no longer confirmed. */
        <span
          className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 align-middle"
          title="Status poll failed — these figures are the last ones received and may be out of date."
          aria-label="Status poll failed; figures may be out of date"
        />
      )}
      <span className={memColor}>Mem: {usedGb}/{memGb} GB</span>
      <span className="text-gray-600 mx-2">·</span>
      <span className={cpuColor}>CPU: {pool.cpu_used_cores}/{pool.cpu_total_cores}</span>
    </span>
  );
}
