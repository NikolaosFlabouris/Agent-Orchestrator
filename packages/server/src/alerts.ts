import {
  getTasks,
  getQueuedTasks,
  getRepo,
  getAgentProfile,
  getActiveAttempt,
  resolveStageProfileId,
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

  // 2. Task stuck (running > STUCK_TASK_TIMEOUT_MULTIPLIER × timeout).
  //
  // Threshold sourcing — H5a: we prefer the snapshot recorded on the
  // active attempt row (attempts.timeout_minutes_snapshot, captured at
  // queued→in-progress transition) over a live profile read. This
  // makes the alert reflect the threshold that was in effect when the
  // attempt started, so an operator who shortens profile.timeout_minutes
  // mid-flight doesn't retroactively flag every in-flight task as stuck.
  //
  // Fallback chain when the snapshot is absent (legacy pre-v22 rows or
  // missing attempt row):
  //   1. Live read of the profile via the standard resolution chain
  //      (task → repo → settings.default).
  //   2. Skip the task if even that can't resolve — we can't reason
  //      about stuck without a threshold.
  const activeTasks = getTasks().filter(
    (t) => !TERMINAL_STATUSES.has(t.status) && t.status !== 'queued'
  );
  for (const task of activeTasks) {
    if (!task.started_at) continue;

    // Threshold source resolution. Three outcomes:
    //   - 'snapshot' → snapshot column on the active attempt (H5a path)
    //   - 'profile'  → live profile read fallback for legacy/pre-v22
    //                  attempt rows whose snapshot is missing
    //   - undecidable → no profile resolvable; skip the task
    let thresholdMinutes: number | null = null;
    type ThresholdSource =
      | { kind: 'snapshot'; attemptId: number }
      | { kind: 'profile'; profileId: string };
    let source: ThresholdSource | null = null;

    // Filter to the *running* attempt (M3). `getLatestAttempt`
    // would include a completed dev attempt during the brief gap
    // before the review attempt row is inserted — the snapshot
    // value is the same in practice, but semantically we want
    // "the currently running attempt".
    const active = getActiveAttempt(task.id);
    if (
      active &&
      typeof active.timeout_minutes_snapshot === 'number' &&
      active.timeout_minutes_snapshot > 0
    ) {
      thresholdMinutes = active.timeout_minutes_snapshot;
      source = { kind: 'snapshot', attemptId: active.id };
    } else {
      // Legacy / pre-v22 fallback. Same stage-aware resolution as the
      // scheduler: the running attempt's role picks the chain; with no
      // attempt row, derive the stage from the task status.
      const repo = getRepo(task.repo_id);
      const stage =
        active?.role ?? (task.status === 'in-review' ? 'review' : 'develop');
      const ref = resolveStageProfileId(task, repo, stage);
      const profile = ref ? getAgentProfile(ref.id) : undefined;
      if (!profile) continue; // profile gone; can't determine threshold
      thresholdMinutes = profile.timeout_minutes;
      source = { kind: 'profile', profileId: profile.id };
    }

    // Use the current attempt's start time (not the task's) so a stuck
    // review run is measured from the review attempt's launch, not
    // from the dev attempt's. task.started_at is set on the first
    // launch and never reset, so for review-phase tasks it would
    // include the full successful dev run and prematurely flag the
    // review as stuck. Falls back to task.started_at when the active
    // attempt has no started_at (shouldn't happen in normal flow but
    // defends against partial inserts).
    const startedAtSource =
      (active && active.started_at) || task.started_at;
    const stuckThresholdMs =
      thresholdMinutes * STUCK_TASK_TIMEOUT_MULTIPLIER * 60 * 1000;
    const elapsed = Date.now() - new Date(startedAtSource).getTime();
    if (elapsed > stuckThresholdMs) {
      // Surface the attempt id (snapshot path) or the live profile id
      // (fallback path) so an on-call operator can jump straight to
      // the offending row without re-walking the task→profile chain
      // (H6).
      const sourceLabel =
        source.kind === 'snapshot'
          ? `snapshot of attempt #${source.attemptId}`
          : `live profile '${source.profileId}'`;
      alerts.push({
        level: 'warning',
        message:
          `Task #${task.issue_id} appears stuck ` +
          `(running ${Math.floor(elapsed / 60000)}m, ` +
          `timeout is ${thresholdMinutes}m from ${sourceLabel})`,
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
