import type { Task } from '@orchestrator/shared';
import { getTask, getRepo, updateTask as dbUpdateTask, insertTaskEvent } from './db.js';
import { broadcastDashboardEvent } from './ws/dashboard.js';
import { sendStreamComplete } from './ws/output.js';
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
 * Drop-in replacement for db.updateTask when side effects are desired.
 */
export function updateTaskWithSync(
  id: number,
  updates: Parameters<typeof dbUpdateTask>[1]
): void {
  const before = getTask(id);
  dbUpdateTask(id, updates);
  const after = getTask(id);

  if (!after) return;

  // Record timeline event on status change
  if (updates.status && before?.status !== updates.status) {
    const message = STATUS_LABELS[updates.status] ?? `Status changed to ${updates.status}`;
    insertTaskEvent(id, `status_${updates.status}`, message);
  }

  // Broadcast dashboard event
  broadcastDashboardEvent({
    type: 'task_updated',
    task: after,
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
  broadcastDashboardEvent({
    type: 'task_created',
    task,
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function syncLabel(task: Task, newStatus: string): Promise<void> {
  if (!_forgejo || !_log) return;

  const repo = getRepo(task.repo_id);
  if (!repo) return;

  const labelName = `status/${newStatus}`;

  try {
    await _forgejo.replaceLabelByNames(repo, task.issue_id, [labelName]);
  } catch (err) {
    _log.warn(
      { event: 'label_sync_failed', task_id: task.id, label: labelName, err },
      'Failed to sync Forgejo label'
    );
  }
}
