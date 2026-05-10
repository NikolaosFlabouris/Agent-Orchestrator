import {
  getTasks,
  getQueuedTasks,
  getRepo,
  getAgentTool,
} from './db.js';
import { getActiveResources } from './queue.js';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { broadcastDashboardEvent } from './ws/dashboard.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  STUCK_TASK_TIMEOUT_MULTIPLIER,
} from './constants.js';
import { getSettingInt } from './db.js';
import type { FastifyBaseLogger } from 'fastify';

interface Alert {
  level: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * Check all alert conditions and broadcast any active alerts.
 * Called periodically (e.g., every 60 seconds from the poller interval).
 */
export async function checkAlerts(log: FastifyBaseLogger): Promise<Alert[]> {
  const alerts: Alert[] = [];

  // 1. Task failed after max attempts
  const failedTasks = getTasks({ status: 'failed' });
  for (const task of failedTasks) {
    const maxAttempts = task.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
    if (task.attempt >= maxAttempts && task.completed_at) {
      // Only alert for recently failed tasks (last hour)
      const completedAt = new Date(task.completed_at).getTime();
      if (Date.now() - completedAt < 60 * 60 * 1000) {
        alerts.push({
          level: 'error',
          message: `Task #${task.issue_id} failed after ${maxAttempts} attempts`,
        });
      }
    }
  }

  // 2. Task stuck (running > STUCK_TASK_TIMEOUT_MULTIPLIER × tool timeout).
  // Per-tool timeout (NOT NULL since v17): look up the task's effective
  // tool, multiply, compare against elapsed.
  const activeTasks = getTasks().filter(
    (t) => !TERMINAL_STATUSES.has(t.status) && t.status !== 'queued'
  );
  for (const task of activeTasks) {
    if (!task.started_at) continue;
    const repo = getRepo(task.repo_id);
    const toolId = task.agent_tool ?? repo?.agent_tool;
    const tool = toolId ? getAgentTool(toolId) : undefined;
    if (!tool) continue; // tool was deleted; can't determine threshold
    const stuckThresholdMs =
      tool.timeout_minutes * STUCK_TASK_TIMEOUT_MULTIPLIER * 60 * 1000;
    const elapsed = Date.now() - new Date(task.started_at).getTime();
    if (elapsed > stuckThresholdMs) {
      alerts.push({
        level: 'warning',
        message: `Task #${task.issue_id} appears stuck (running ${Math.floor(elapsed / 60000)}m, ${tool.id} timeout is ${tool.timeout_minutes}m)`,
      });
    }
  }

  // 3. Host resource pool saturated, queue growing. Either dimension at
  // its cap means no new candidate can launch. Worth surfacing because
  // the operator's options are: raise the pool, lower per-repo container
  // sizing, or wait for active tasks to finish.
  const used = getActiveResources();
  const memTotal = getSettingInt('max_agent_memory_mb');
  const cpuTotal = getSettingInt('max_agent_cpu_cores');
  const queueDepth = getQueuedTasks().length;
  const memSaturated = used.memoryMb >= memTotal;
  const cpuSaturated = used.cpuCores >= cpuTotal;
  if ((memSaturated || cpuSaturated) && queueDepth > 0) {
    const which = memSaturated && cpuSaturated
      ? `memory (${used.memoryMb}/${memTotal} MB) and CPU (${used.cpuCores}/${cpuTotal} cores)`
      : memSaturated
      ? `memory (${used.memoryMb}/${memTotal} MB)`
      : `CPU (${used.cpuCores}/${cpuTotal} cores)`;
    alerts.push({
      level: 'info',
      message: `Host resource pool saturated on ${which}; ${queueDepth} task${queueDepth === 1 ? '' : 's'} waiting`,
    });
  }

  // 4. Tasks awaiting human action for extended period
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
