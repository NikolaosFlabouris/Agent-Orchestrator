import { useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { TaskDetailResponse, AttemptResponse, TaskAction, ToolResponse } from '../api.js';
import { connectOutputWs } from '../ws.js';
import type { OutputWsEvent } from '../ws.js';
import { Timeline } from '../components/Timeline.js';
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

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [agentToolError, setAgentToolError] = useState<string | null>(null);
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  const [extendAmount, setExtendAmount] = useState(1);
  const [extendError, setExtendError] = useState<string | null>(null);
  const tools = useStore((s) => s.tools);
  const setTools = useStore((s) => s.setTools);
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);

  useEffect(() => {
    if (!id) return;
    api
      .getTask(parseInt(id, 10))
      .then(setTask)
      .catch((err) => setError(err.message));
  }, [id]);

  // Load tools into store if not already cached
  useEffect(() => {
    if (tools.length === 0) {
      api.getTools().then((res) => setTools(res.tools)).catch(() => {});
    }
  }, [tools.length, setTools]);

  async function handleAction(action: TaskAction) {
    if (!task || actionPending) return;
    // Confirmation for destructive actions
    if (action.action === 'cancel') {
      if (!confirm('Cancel this task? Container will be stopped and branch/PR cleaned up.')) return;
    } else if (action.action === 'reset') {
      if (!confirm('This will delete the branch, PR, and all agent work. The issue will return to an unqueued state. Continue?')) return;
    } else if (action.action === 'force_fail') {
      if (!confirm('Force-fail this task?')) return;
    } else if (action.action === 'requeue') {
      if (!confirm('Requeue this task? It will be placed at the end of the queue.')) return;
    }

    setActionPending(true);
    try {
      await api.patchTask(task.id, action);
      // Reload task
      const updated = await api.getTask(task.id);
      setTask(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionPending(false);
    }
  }

  async function handleExtend() {
    if (!task || actionPending) return;
    setActionPending(true);
    setExtendError(null);
    try {
      await api.patchTask(task.id, { action: 'extend', additional_attempts: extendAmount });
      const updated = await api.getTask(task.id);
      setTask(updated);
      setExtendModalOpen(false);
    } catch (err) {
      setExtendError(err instanceof Error ? err.message : 'Extend failed');
    } finally {
      setActionPending(false);
    }
  }

  async function handleAgentToolChange(newToolId: string) {
    if (!task) return;
    const newTool = newToolId || null; // empty string → null (repo default)
    const prevTool = task.agent_tool;

    // Optimistic update — also sync derived fields so the select label stays
    // consistent before the getTask refetch resolves.
    setTask((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        agent_tool: newTool,
        effective_agent_tool_id: newTool ?? prev.repo_agent_tool,
        agent_tool_source: newTool !== null ? 'task' : 'repo',
      };
    });
    setAgentToolError(null);

    try {
      await api.patchTask(task.id, { agent_tool: newTool });
    } catch (err) {
      // Roll back only when the PATCH itself failed (server hasn't persisted the change).
      setTask((prev) => prev ? {
        ...prev,
        agent_tool: prevTool,
        effective_agent_tool_id: prevTool ?? prev.repo_agent_tool,
        agent_tool_source: prevTool !== null ? 'task' : 'repo',
      } : prev);
      setAgentToolError(err instanceof Error ? err.message : 'Failed to update agent tool');
      return;
    }
    try {
      const updated = await api.getTask(task.id);
      setTask(updated);
    } catch {
      // PATCH was confirmed; leave optimistic state — WS push will correct it.
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

  const totalCost = task.attempts.reduce(
    (sum, a) => sum + (a.cost_usd ?? 0),
    0
  );

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
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
            <h1 className="text-xl font-semibold mt-1">
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
            </h1>
            <div className="text-sm text-gray-400 mt-1 space-x-4">
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
              <label className="text-xs text-gray-500">Agent tool:</label>
              <select
                value={task.agent_tool ?? ''}
                onChange={(e) => handleAgentToolChange(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
              >
                <option value="">
                  Use repo default
                  {task.repo_agent_tool
                    ? ` (${tools.find((t) => t.id === task.repo_agent_tool)?.display_name ?? task.repo_agent_tool})`
                    : ''}
                </option>
                {tools.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.display_name}
                  </option>
                ))}
              </select>
              {ACTIVE_STATUSES.has(task.status) && (
                <span className="text-xs text-gray-500 italic">Takes effect on next attempt</span>
              )}
              {agentToolError && (
                <span className="text-xs text-red-400">{agentToolError}</span>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 justify-end">
              <StatusBadge status={task.status} />
              {task.health === 'orphaned' && <HealthBadge health={task.health} />}
            </div>
            <div className="text-sm text-gray-400 mt-1">
              Attempt {task.attempt}/{task.max_attempts}
            </div>
          </div>
        </div>
      </header>

      {/* Actions bar */}
      <div className="border-b border-gray-800 bg-gray-900/50 px-6 py-3">
        <div className="mx-auto max-w-7xl flex gap-3">
          {ACTIVE_STATUSES.has(task.status) && (
            <button
              onClick={() => handleAction({ action: 'cancel' })}
              disabled={actionPending}
              className="text-sm px-3 py-1.5 rounded border border-red-800 text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              Cancel
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

      </div>

      {/* Extend modal */}
      {extendModalOpen && task && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-80 shadow-xl">
            <h2 className="text-lg font-semibold mb-4">Extend Task</h2>
            <p className="text-sm text-gray-400 mb-4">
              Grant additional attempts without resetting any existing work or PR.
            </p>
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">Additional attempts</label>
              <input
                type="number"
                min={1}
                max={10}
                value={extendAmount}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v)) setExtendAmount(Math.min(10, Math.max(1, v)));
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex gap-2 mb-4">
              {[1, 3, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setExtendAmount(n)}
                  className={`text-xs px-3 py-1 rounded border transition-colors ${
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
                onClick={() => { setExtendModalOpen(false); setExtendError(null); }}
                disabled={actionPending}
                className="text-sm px-4 py-1.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleExtend}
                disabled={actionPending}
                className="text-sm px-4 py-1.5 rounded border border-orange-700 text-orange-300 bg-orange-950/50 hover:bg-orange-950 disabled:opacity-50"
              >
                {actionPending ? 'Extending…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-8">
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

        {/* Cost summary */}
        <section>
          <h2 className="text-lg font-medium mb-2">Cost Summary</h2>
          <p className="text-2xl font-mono">${totalCost.toFixed(2)}</p>
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
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 text-sm">
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

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
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
        <div className="flex items-center gap-4 text-sm text-gray-400">
          <span>{duration}</span>
          {attempt.input_tokens != null && (
            <span>
              {(attempt.input_tokens / 1000).toFixed(0)}k in /{' '}
              {((attempt.output_tokens ?? 0) / 1000).toFixed(0)}k out
            </span>
          )}
          {attempt.cost_usd != null && (
            <span className="font-mono">${attempt.cost_usd.toFixed(2)}</span>
          )}
        </div>
      </div>
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

function HealthBadge({ health }: { health: 'healthy' | 'orphaned' | 'idle' }) {
  if (health === 'healthy' || health === 'idle') return null;
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
