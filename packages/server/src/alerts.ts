import fs from 'node:fs';
import { getTasks, getSettingInt, getActiveTaskCount, getQueuedTasks } from './db.js';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { broadcastDashboardEvent } from './ws/dashboard.js';
import type { FastifyBaseLogger } from 'fastify';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? '/workspaces';
const CACHES_ROOT = process.env.CACHES_ROOT ?? '/caches';

interface Alert {
  level: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * Check all alert conditions and broadcast any active alerts.
 * Called periodically (e.g., every 60 seconds from the poller interval).
 */
export function checkAlerts(log: FastifyBaseLogger): Alert[] {
  const alerts: Alert[] = [];

  // 1. Task failed after max attempts
  const failedTasks = getTasks({ status: 'failed' });
  for (const task of failedTasks) {
    if (task.attempt >= task.max_attempts && task.completed_at) {
      // Only alert for recently failed tasks (last hour)
      const completedAt = new Date(task.completed_at).getTime();
      if (Date.now() - completedAt < 60 * 60 * 1000) {
        alerts.push({
          level: 'error',
          message: `Task #${task.issue_id} failed after ${task.max_attempts} attempts`,
        });
      }
    }
  }

  // 2. Task stuck (running > 2x timeout)
  const timeoutMinutes = getSettingInt('agent_timeout_minutes') || 30;
  const stuckThresholdMs = timeoutMinutes * 2 * 60 * 1000;
  const activeTasks = getTasks().filter(
    (t) => !TERMINAL_STATUSES.has(t.status) && t.status !== 'queued'
  );
  for (const task of activeTasks) {
    if (task.started_at) {
      const elapsed = Date.now() - new Date(task.started_at).getTime();
      if (elapsed > stuckThresholdMs) {
        alerts.push({
          level: 'warning',
          message: `Task #${task.issue_id} appears stuck (running ${Math.floor(elapsed / 60000)}m, timeout is ${timeoutMinutes}m)`,
        });
      }
    }
  }

  // 3. All slots full, queue growing
  const activeCount = getActiveTaskCount();
  const maxConcurrency = getSettingInt('max_concurrency');
  const queueDepth = getQueuedTasks().length;
  if (activeCount >= maxConcurrency && queueDepth > 0) {
    alerts.push({
      level: 'info',
      message: `All ${maxConcurrency} slots in use, ${queueDepth} tasks queued`,
    });
  }

  // 4. Disk usage exceeds threshold
  const thresholdBytes = getSettingInt('disk_threshold_bytes');
  if (thresholdBytes > 0) {
    const totalBytes = getDirSize(WORKSPACES_ROOT) + getDirSize(CACHES_ROOT);
    if (totalBytes > thresholdBytes) {
      const totalGb = (totalBytes / (1024 * 1024 * 1024)).toFixed(1);
      const thresholdGb = (thresholdBytes / (1024 * 1024 * 1024)).toFixed(1);
      alerts.push({
        level: 'warning',
        message: `Disk usage (${totalGb} GB) exceeds threshold (${thresholdGb} GB)`,
      });
    }
  }

  // 5. Tasks awaiting human action for extended period
  const humanTasks = getTasks().filter((t) =>
    ['awaiting-human-merge', 'awaiting-human-review', 'needs-human-review'].includes(t.status)
  );
  for (const task of humanTasks) {
    if (task.completed_at) {
      const waitingMs = Date.now() - new Date(task.completed_at).getTime();
      if (waitingMs > 24 * 60 * 60 * 1000) {
        const hours = Math.floor(waitingMs / (60 * 60 * 1000));
        alerts.push({
          level: 'warning',
          message: `Task #${task.issue_id} awaiting human action for ${hours}h (${task.status})`,
        });
      }
    }
  }

  return alerts;
}

function getDirSize(dirPath: string): number {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isFile()) {
        try { total += fs.statSync(fullPath).size; } catch { /* skip */ }
      } else if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}
