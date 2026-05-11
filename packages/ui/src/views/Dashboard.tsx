import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../store.js';
import { api } from '../api.js';
import type { StatusResponse, TaskResponse, RepoResponse } from '../api.js';
import { connectDashboardWs } from '../ws.js';
import type { DashboardWsEvent, HostPool } from '../ws.js';
import { AlertBanner } from '../components/AlertBanner.js';
import { QueueList } from '../components/QueueList.js';

const ACTIVE_STATUSES = new Set([
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
]);

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
  const dailyCompletions = useStore((s) => s.dailyCompletions);
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);
  const alerts = useStore((s) => s.alerts);

  const setStatus = useStore((s) => s.setStatus);
  const setHostPool = useStore((s) => s.setHostPool);

  const [pools, setPools] = useState<StatusResponse['providers']>([]);
  const [repos, setRepos] = useState<RepoResponse[]>([]);

  useEffect(() => {
    // Actions are pulled from `getState()` inside the effect so we
    // don't add subscriptions for things we only invoke (never read
    // as values). Same identity guarantee as the selector pattern,
    // just without the unused subscription overhead.
    const {
      setDailyCompletions,
      setForgejoBaseUrl,
      setHostPool: setHostPoolFn,
      setSnapshot,
      updateTask,
      addTask,
      removeTask,
      setStatus: setStatusFn,
      bumpResourceVersion,
      setAgentProfiles,
      agentProfiles: initialAgentProfiles,
    } = useStore.getState();

    // Pull status immediately and every 5 s. Daily completions come from the
    // same payload; providers are sampled often so the Pools row stays close
    // to live.
    const refresh = () => {
      api.getStatus().then((s) => {
        setDailyCompletions(s.daily_completions);
        setForgejoBaseUrl(s.forgejo_base_url);
        setHostPoolFn({
          memory_used_mb: s.host_pool.memory_used_mb,
          memory_total_mb: s.host_pool.memory_total_mb,
          cpu_used_cores: s.host_pool.cpu_used_cores,
          cpu_total_cores: s.host_pool.cpu_total_cores,
        });
        setPools(s.providers ?? []);
      }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);

    // Pull the task list through the REST API as well. The dashboard WS
    // snapshot returns raw `tasks.status` (runtime state), whereas the REST
    // response overlays the Forgejo-derived status so closed-issue/merged-PR
    // reality overrides stale local `failed` rows. Refresh on mount and
    // every 30 s so driver-label / issue-closure changes reach the UI even
    // if a webhook was dropped.
    const refreshTasks = () => {
      api.getTasks().then((res) => {
        for (const task of res.tasks) updateTask(task);
      }).catch(() => {});
    };
    refreshTasks();
    const tasksTimer = window.setInterval(refreshTasks, 30_000);

    // Connect WebSocket
    const handler = (event: DashboardWsEvent) => {
      switch (event.type) {
        case 'snapshot':
          setSnapshot(event);
          break;
        case 'task_updated':
          updateTask(event.task);
          break;
        case 'task_created':
          addTask(event.task);
          break;
        case 'task_removed':
          removeTask(event.taskId);
          break;
        case 'status_changed':
          setStatusFn(event);
          break;
        case 'resource_changed':
          // Bump the version counter so Settings tabs / other consumers
          // refetch. For profiles specifically the Dashboard itself
          // holds a cached display-name lookup, so refetch it inline.
          bumpResourceVersion(event.resource);
          if (event.resource === 'profiles') {
            api
              .getAgentProfiles()
              .then((res) => setAgentProfiles(res.profiles))
              .catch(() => {});
          }
          break;
      }
    };

    const disconnect = connectDashboardWs(handler);

    // Fetch agent profiles once for display in task rows (cached in
    // store). Subsequent updates arrive via the resource_changed event
    // handler above.
    if (initialAgentProfiles.length === 0) {
      api
        .getAgentProfiles()
        .then((res) => setAgentProfiles(res.profiles))
        .catch(() => {});
    }

    // Fetch repos once on mount for the Repos strip
    api.getRepos().then((res) => setRepos(res.repos)).catch(() => {});

    return () => {
      disconnect();
      window.clearInterval(timer);
      window.clearInterval(tasksTimer);
    };
  }, []);

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

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Agent Orchestrator</h1>
          <div className="flex items-center gap-6 text-sm">
            <span className={paused ? 'text-yellow-400' : 'text-green-400'}>
              {paused ? 'Paused' : 'Running'}
            </span>
            <HostPoolDisplay pool={hostPool} />
            <span>Queue: {queueDepth}</span>
            <span>Today: {dailyCompletions} tasks</span>
            <button
              onClick={async () => {
                if (paused) {
                  await api.resume();
                  setStatus({ paused: false, hostPool, queueDepth });
                } else {
                  await api.pause();
                  setStatus({ paused: true, hostPool, queueDepth });
                }
              }}
              className={`px-3 py-1 rounded text-xs font-medium ${
                paused
                  ? 'bg-green-900 text-green-300 hover:bg-green-800'
                  : 'bg-yellow-900 text-yellow-300 hover:bg-yellow-800'
              }`}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <Link
              to="/settings"
              className="text-blue-400 hover:text-blue-300"
            >
              Settings
            </Link>
             <Link
               to="/help"
               className="text-blue-400 hover:text-blue-300"
             >
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
           </div>
        </div>
      </header>

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
                 className={
                   isPaused
                     ? 'text-yellow-400'
                     : full
                       ? 'text-orange-400'
                       : 'text-gray-300'
                 }
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
               className="text-gray-300 hover:text-blue-300"
             >
               {r.owner}/{r.name} ↗
             </a>
           ))}
         </div>
       )}

       <AlertBanner alerts={alerts} />

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

        {/* Recent completions */}
        <section>
          <h2 className="text-lg font-medium mb-3">
            Recent ({completedTasks.length})
          </h2>
          {completedTasks.length === 0 ? (
            <p className="text-gray-500 text-sm">No completed tasks</p>
          ) : (
            <div className="space-y-2">
              {completedTasks.map((task) => (
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

  return (
    <span
      className={`text-xs font-mono truncate ${isOverride ? 'text-blue-400' : 'text-gray-500'}`}
      title={`${name} (${sourceLabel})`}
    >
      {isOverride && <span className="mr-0.5">•</span>}
      {truncated}
    </span>
  );
}

function ActiveTaskCard({ task }: { task: TaskResponse }) {
  const navigate = useNavigate();
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);

  const issueHref =
    forgejoBaseUrl && task.repo
      ? `${forgejoBaseUrl}/${task.repo.owner}/${task.repo.name}/issues/${task.issue_id}`
      : null;

  const goToTask = () => navigate(`/tasks/${task.id}`);

  const phaseLabel: Record<string, string> = {
    preparing: 'Preparing',
    'in-progress': 'Implementing',
    'in-review': 'Reviewing',
    'changes-needed': 'Reworking',
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={goToTask}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToTask();
        }
      }}
      className="block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors cursor-pointer"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {task.health === 'orphaned' && (
            <span
              className="inline-block w-2 h-2 rounded-full bg-orange-400"
              title="Orphaned — container has disappeared. Orchestrator will attempt recovery."
              aria-label="Orphaned"
            />
          )}
          <div>
            {issueHref ? (
              <a
                href={issueHref}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => e.stopPropagation()}
                className="text-blue-400 font-mono text-sm hover:underline"
              >
                #{task.issue_id}
              </a>
            ) : (
              <span className="text-blue-400 font-mono text-sm">
                #{task.issue_id}
              </span>
            )}{' '}
            <span className="font-medium">{task.issue_title}</span>
            {task.repo && (
              <span className="text-gray-500 text-sm ml-2">
                {task.repo.owner}/{task.repo.name}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <ToolChip task={task} />
          <StatusBadge status={task.status} label={phaseLabel[task.status]} />
          <span className="text-gray-400">
            Attempt {task.attempt}/{task.max_attempts}
          </span>
          {task.started_at && (
            <span className="text-gray-500">
              {elapsed(task.started_at)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function CompletedItem({ task }: { task: TaskResponse }) {
  const navigate = useNavigate();
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);

  const issueHref =
    forgejoBaseUrl && task.repo
      ? `${forgejoBaseUrl}/${task.repo.owner}/${task.repo.name}/issues/${task.issue_id}`
      : null;

  const goToTask = () => navigate(`/tasks/${task.id}`);

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={goToTask}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToTask();
        }
      }}
      className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded p-3 hover:border-gray-700 transition-colors cursor-pointer"
    >
      <div>
        {issueHref ? (
          <a
            href={issueHref}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            className="text-blue-400 font-mono text-sm hover:underline"
          >
            #{task.issue_id}
          </a>
        ) : (
          <span className="text-blue-400 font-mono text-sm">
            #{task.issue_id}
          </span>
        )}{' '}
        <span>{task.issue_title}</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <ToolChip task={task} />
        <StatusBadge status={task.status} />
        <span className="text-gray-500">
          {task.attempt} attempt{task.attempt !== 1 ? 's' : ''}
        </span>
        {task.completed_at && (
          <span className="text-gray-500">{timeAgo(task.completed_at)}</span>
        )}
      </div>
    </div>
  );
}

function HostPoolDisplay({ pool }: { pool: HostPool }) {
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
      <span className={memColor}>Mem: {usedGb}/{memGb} GB</span>
      <span className="text-gray-600 mx-2">·</span>
      <span className={cpuColor}>CPU: {pool.cpu_used_cores}/{pool.cpu_total_cores}</span>
    </span>
  );
}

function StatusBadge({ status, label }: { status: string; label?: string }) {
  const colors: Record<string, string> = {
    'in-progress': 'bg-blue-900 text-blue-300',
    'in-review': 'bg-purple-900 text-purple-300',
    'changes-needed': 'bg-yellow-900 text-yellow-300',
    preparing: 'bg-gray-700 text-gray-300',
    merged: 'bg-green-900 text-green-300',
    failed: 'bg-red-900 text-red-300',
    cancelled: 'bg-gray-700 text-gray-400',
    'awaiting-human-merge': 'bg-orange-900 text-orange-300',
    'awaiting-human-review': 'bg-orange-900 text-orange-300',
    'needs-human-review': 'bg-orange-900 text-orange-300',
  };

  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-gray-700 text-gray-300'}`}
    >
      {label ?? status}
    </span>
  );
}

function elapsed(startedAt: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(startedAt).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
