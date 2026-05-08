import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../store.js';
import { api } from '../api.js';
import type { StatusResponse, TaskResponse, RepoResponse } from '../api.js';
import { connectDashboardWs } from '../ws.js';
import type { DashboardWsEvent } from '../ws.js';
import { AlertBanner } from '../components/AlertBanner.js';
import { QueueList } from '../components/QueueList.js';

const ACTIVE_STATUSES = new Set([
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
]);

export function Dashboard() {
  const store = useStore();
  const [pools, setPools] = useState<StatusResponse['providers']>([]);
  const [repos, setRepos] = useState<RepoResponse[]>([]);
 
  useEffect(() => {
    // Pull status immediately and every 5 s. Daily cost/completions come from
    // the same payload; providers are sampled often so the Pools row stays
    // close to live. Cost is cheap (single SQL query + one JSON serialisation).
    const refresh = () => {
        api.getStatus().then((s) => {
          store.setDailyCost(s.daily_cost_usd);
          store.setDailyCompletions(s.daily_completions);
          store.setForgejoBaseUrl(s.forgejo_base_url);
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
        for (const task of res.tasks) store.updateTask(task);
      }).catch(() => {});
    };
    refreshTasks();
    const tasksTimer = window.setInterval(refreshTasks, 30_000);

    // Connect WebSocket
    const handler = (event: DashboardWsEvent) => {
      switch (event.type) {
        case 'snapshot':
          store.setSnapshot(event);
          break;
        case 'task_updated':
          store.updateTask(event.task);
          break;
        case 'task_created':
          store.addTask(event.task);
          break;
        case 'task_removed':
          store.removeTask(event.taskId);
          break;
        case 'status_changed':
          store.setStatus(event);
          break;
      }
    };

    const disconnect = connectDashboardWs(handler);

    // Fetch tools once for display in task rows (cached in store)
    if (store.tools.length === 0) {
      api.getTools().then((res) => store.setTools(res.tools)).catch(() => {});
    }
 
    // Fetch repos once on mount for the Repos strip
    api.getRepos().then((res) => setRepos(res.repos)).catch(() => {});
 
    return () => {
      disconnect();
      window.clearInterval(timer);
      window.clearInterval(tasksTimer);
    };
  }, []);

  const activeTasks = store.tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  const queuedTasks = store.tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0));
  const completedTasks = store.tasks
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
            <span className={store.paused ? 'text-yellow-400' : 'text-green-400'}>
              {store.paused ? 'Paused' : 'Running'}
            </span>
            <span>
              Slots: {store.activeCount}/{store.maxConcurrency}
            </span>
            <span>Queue: {store.queueDepth}</span>
            <span>Today: {store.dailyCompletions} tasks</span>
            <span>${store.dailyCostUsd.toFixed(2)}</span>
            <button
              onClick={async () => {
                if (store.paused) {
                  await api.resume();
                  store.setStatus({ paused: false, activeCount: store.activeCount, queueDepth: store.queueDepth });
                } else {
                  await api.pause();
                  store.setStatus({ paused: true, activeCount: store.activeCount, queueDepth: store.queueDepth });
                }
              }}
              className={`px-3 py-1 rounded text-xs font-medium ${
                store.paused
                  ? 'bg-green-900 text-green-300 hover:bg-green-800'
                  : 'bg-yellow-900 text-yellow-300 hover:bg-yellow-800'
              }`}
            >
              {store.paused ? 'Resume' : 'Pause'}
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
             {store.forgejoBaseUrl && (
               <a
                 href={store.forgejoBaseUrl}
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
             const paused = p.concurrency_limit === 0;
             return (
               <span
                 key={p.id}
                 className={
                   paused
                     ? 'text-yellow-400'
                     : full
                       ? 'text-orange-400'
                       : 'text-gray-300'
                 }
                 title={
                   paused
                     ? `${p.display_name}: paused (concurrency_limit = 0)`
                     : full
                       ? `${p.display_name}: at limit — candidate tasks on this provider will wait`
                       : `${p.display_name}: ${p.concurrency_limit - p.active_slots} slot(s) free`
                 }
               >
                 {p.display_name}: {p.active_slots}/{p.concurrency_limit}
                 {paused ? ' (paused)' : ''}
               </span>
             );
           })}
         </div>
       )}
 
       {repos.length > 0 && store.forgejoBaseUrl && (
         <div className="border-b border-gray-800 bg-gray-900/60 px-6 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
           <span className="text-gray-500 uppercase tracking-wide">Repos</span>
           {repos.map((r) => (
             <a
               key={r.id}
               href={`${store.forgejoBaseUrl}/${r.owner}/${r.name}`}
               target="_blank"
               rel="noreferrer noopener"
               className="text-gray-300 hover:text-blue-300"
             >
               {r.owner}/{r.name} ↗
             </a>
           ))}
         </div>
       )}
 
       <AlertBanner alerts={store.alerts} />

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
  const tools = useStore((s) => s.tools);
  const toolId = task.effective_agent_tool_id;
  if (!toolId) return null;

  const found = tools.find((t) => t.id === toolId);
  const name = found?.display_name ?? toolId;
  const truncated = name.length > 25 ? name.slice(0, 24) + '…' : name;
  const isOverride = task.agent_tool_source === 'task';

  return (
    <span
      className={`text-xs font-mono truncate ${isOverride ? 'text-blue-400' : 'text-gray-500'}`}
      title={`${name}${isOverride ? ' (task override)' : ' (repo default)'}`}
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
