import fs from 'node:fs';
import path from 'node:path';
import { getTasks, getSettingInt } from './db.js';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import type { FastifyBaseLogger } from 'fastify';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? '/workspaces';

/**
 * Delete workspaces for failed/cancelled tasks older than the retention period.
 * Called periodically (e.g., once per poll cycle).
 */
export function cleanupOldWorkspaces(log: FastifyBaseLogger): void {
  const retentionDays = getSettingInt('workspace_retention_days') || 7;
  const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Find terminal tasks with completed_at older than retention
  const tasks = getTasks();
  for (const task of tasks) {
    if (!TERMINAL_STATUSES.has(task.status)) continue;
    if (task.status === 'merged') continue; // Keep merged workspaces briefly for reference
    if (!task.completed_at) continue;

    const completedAt = new Date(task.completed_at).getTime();
    if (now - completedAt < cutoffMs) continue;

    const workdir = path.join(WORKSPACES_ROOT, `issue-${task.issue_id}`);
    if (!fs.existsSync(workdir)) continue;

    try {
      fs.rmSync(workdir, { recursive: true, force: true });
      log.info(
        {
          event: 'workspace_cleaned',
          task_id: task.id,
          issue_id: task.issue_id,
          age_days: Math.floor((now - completedAt) / (24 * 60 * 60 * 1000)),
        },
        `Deleted workspace for issue #${task.issue_id} (${task.status}, ${retentionDays}d retention)`
      );
    } catch (err) {
      log.warn(
        { event: 'workspace_cleanup_failed', task_id: task.id, err },
        'Failed to delete old workspace'
      );
    }
  }
}
