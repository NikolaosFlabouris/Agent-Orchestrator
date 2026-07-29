import type { Task } from '@orchestrator/shared';
import { getTask, getRepo, updateTaskRaw, insertTaskEvent } from './db.js';
import { broadcastDashboardEvent } from './ws/dashboard.js';
import { buildTaskView } from './task-view.js';
import { sendStreamComplete } from './ws/output.js';
import { DEFAULT_MAX_ATTEMPTS } from './constants.js';
import type { ForgejoClient } from './forgejo.js';
import type { FastifyBaseLogger } from 'fastify';

let _forgejo: ForgejoClient | null = null;
let _log: FastifyBaseLogger | null = null;

/** Status labels for human-readable event messages. */
const STATUS_LABELS: Record<string, string> = {
  queued: 'Task queued',
  preparing: 'Preparing workspace',
  'in-progress': 'Implementation started',
  'in-review': 'Review started',
  'changes-needed': 'Changes requested — rework needed',
  merged: 'PR merged — task complete',
  failed: 'Task failed',
  cancelled: 'Task cancelled',
  'awaiting-human-merge': 'Awaiting human merge',
  'awaiting-human-review': 'Awaiting human review',
  'needs-human-review': 'Human review needed',
  reset: 'Task reset',
};

/**
 * Initialize state-sync with shared dependencies.
 * Called once at startup from index.ts.
 */
export function initStateSync(
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): void {
  _forgejo = forgejo;
  _log = log;
}

/**
 * Update a task's DB fields AND synchronize side effects:
 * - Record a timeline event if status changed
 * - Broadcast dashboard WebSocket event
 * - Sync Forgejo label if status changed
 *
 * This is the DEFAULT path for every task mutation. `db.updateTaskRaw` is the
 * exception, reserved for internal bookkeeping writes that change no task
 * status.
 */
export function updateTaskWithSync(
  id: number,
  updates: Parameters<typeof updateTaskRaw>[1]
): void {
  const before = getTask(id);
  updateTaskRaw(id, updates);
  const after = getTask(id);

  if (!after) return;

  // Record timeline event on status change
  if (updates.status && before?.status !== updates.status) {
    const message = STATUS_LABELS[updates.status] ?? `Status changed to ${updates.status}`;
    insertTaskEvent(id, `status_${updates.status}`, message);
  }

  // Broadcast dashboard event. The payload is the fully enriched view —
  // identical to what GET /api/tasks returns — because the client store
  // replaces the whole row on `task_updated`; sending the raw DB row would
  // strip the repo tuple, dependency/blocked state, health, and the
  // resolved profile chains off whatever the client already had.
  // `buildTaskView` is synchronous and does no network I/O.
  broadcastDashboardEvent({
    type: 'task_updated',
    task: buildTaskView(after),
  });

  // Sync Forgejo label if status changed.
  // Skip 'reset' — reset removes all status labels via actions.ts, not by setting one.
  if (
    updates.status &&
    updates.status !== 'reset' &&
    before?.status !== updates.status
  ) {
    syncLabel(after, updates.status).catch(() => {
      // Best effort — logged inside
    });
  }
}

/**
 * Record a non-status timeline event for a task.
 * Use for granular events like "workspace cloned", "branch created", "PR created", etc.
 */
export function recordTaskEvent(
  taskId: number,
  eventType: string,
  message: string
): void {
  insertTaskEvent(taskId, eventType, message);
}

/**
 * Signal that a task's agent output stream is complete.
 * Call this when a container finishes and results are processed.
 */
export function notifyStreamComplete(taskId: number): void {
  sendStreamComplete(taskId);
}

/**
 * Broadcast that a new task was created.
 */
export function notifyTaskCreated(task: Task): void {
  insertTaskEvent(task.id, 'task_created', `Task created for issue #${task.issue_id}`);
  if (_forgejo) {
    const repo = getRepo(task.repo_id);
    if (repo) {
      _forgejo
        .commentOnIssue(
          repo,
          task.issue_id,
          `Task queued for orchestration (attempt 1/${task.max_attempts ?? DEFAULT_MAX_ATTEMPTS}).`
        )
        .catch(() => {
          /* best effort */
        });
    }
  }
  broadcastDashboardEvent({
    type: 'task_created',
    task: buildTaskView(task),
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function syncLabel(task: Task, newStatus: string): Promise<void> {
  if (!_forgejo || !_log) return;

  const repo = getRepo(task.repo_id);
  if (!repo) return;

  const statusLabel = `status/${newStatus}`;

  // Preserve non-`status/*` labels (e.g. `human-merge`, `human-review`, any
  // user-authored tags). Forgejo's replaceLabel endpoint is a PUT that replaces
  // the entire label set, so without this step the `human-merge` signal would
  // be stripped every time the status transitions — which breaks the flow
  // where an `awaiting-human-merge` task is auto-rebased and needs to return
  // to `awaiting-human-merge` after the dev+review cycle.
  let preserved: string[] = [];
  try {
    const issue = await _forgejo.getIssue(repo, task.issue_id);
    preserved = issue.labels
      .map((l) => l.name)
      .filter((name) => !name.startsWith('status/'));
  } catch {
    // Best effort — fall back to just setting the status label.
  }

  try {
    await _forgejo.replaceLabelByNames(repo, task.issue_id, [
      statusLabel,
      ...preserved,
    ]);
  } catch (err) {
    _log.warn(
      { event: 'label_sync_failed', task_id: task.id, label: statusLabel, err },
      'Failed to sync Forgejo label'
    );
  }
}
