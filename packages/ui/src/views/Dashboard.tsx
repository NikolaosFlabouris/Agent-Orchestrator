import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store.js';
import { api } from '../api.js';
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

  useEffect(() => {
    // Load initial status for daily cost/completions
    api.getStatus().then((s) => {
      store.setDailyCost(s.daily_cost_usd);
      store.setDailyCompletions(s.daily_completions);
    }).catch(() => {});

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
    return disconnect;
  }, []);

  const activeTasks = store.tasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  const queuedTasks = store.tasks
    .filter((t) => t.status === 'queued')
    .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0));
  const completedTasks = store.tasks.filter(
    (t) => !ACTIVE_STATUSES.has(t.status) && t.status !== 'queued'
  );

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
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
          </div>
        </div>
      </header>

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

function ActiveTaskCard({ task }: { task: import('../api.js').TaskResponse }) {
  const phaseLabel: Record<string, string> = {
    preparing: 'Preparing',
    'in-progress': 'Implementing',
    'in-review': 'Reviewing',
    'changes-needed': 'Reworking',
  };

  return (
    <Link
      to={`/tasks/${task.id}`}
      className="block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div>
          <span className="text-blue-400 font-mono text-sm">
            #{task.issue_id}
          </span>{' '}
          <span className="font-medium">{task.issue_title}</span>
          {task.repo && (
            <span className="text-gray-500 text-sm ml-2">
              {task.repo.owner}/{task.repo.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm">
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
    </Link>
  );
}

function CompletedItem({ task }: { task: import('../api.js').TaskResponse }) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded p-3 hover:border-gray-700 transition-colors"
    >
      <div>
        <span className="text-blue-400 font-mono text-sm">
          #{task.issue_id}
        </span>{' '}
        <span>{task.issue_title}</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <StatusBadge status={task.status} />
        <span className="text-gray-500">
          {task.attempt} attempt{task.attempt !== 1 ? 's' : ''}
        </span>
        {task.completed_at && (
          <span className="text-gray-500">{timeAgo(task.completed_at)}</span>
        )}
      </div>
    </Link>
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
