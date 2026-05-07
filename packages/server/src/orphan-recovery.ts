import type { Task, Attempt } from '@orchestrator/shared';
import {
  getTasks,
  getRepo,
  updateAttempt,
  getAttempts,
} from './db.js';
import {
  listContainers,
  getContainer,
  inspectContainer,
} from './docker.js';
import { updateTaskWithSync, recordTaskEvent } from './state-sync.js';
import { resetTask } from './actions.js';
import type { ForgejoClient } from './forgejo.js';
import type { Scheduler } from './scheduler.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Window, in milliseconds, within which a freshly-launched attempt that
 * becomes orphaned is treated as a crash loop rather than a transient
 * failure. Recovery is refused and the task is escalated to `failed`.
 */
const CRASH_LOOP_WINDOW_MS = 30_000;

const ACTIVE_STATUSES = new Set<Task['status']>([
  'in-progress',
  'in-review',
  'changes-needed',
]);

export type OrphanKind = 'null_container' | 'missing_container';

export interface DetectedOrphan {
  task: Task;
  stuckAttempt: Attempt;
  kind: OrphanKind;
}

/**
 * Scan for tasks whose agent container has disappeared but whose attempt row
 * is still `running`. Two shapes qualify:
 *
 *  - `null_container`: task status is active but `container_id` is NULL
 *    (a prior recovery nulled the pointer without finalising the attempt row,
 *    or the container wait-callback never fired).
 *
 *  - `missing_container`: `container_id` is set but Docker has no record of
 *    it (container was removed externally, or Docker itself was restarted).
 *
 * Returns `null` if Docker is unreachable — callers must treat this as "do
 * nothing" rather than assume everything is orphaned.
 */
export async function detectOrphans(
  log: FastifyBaseLogger
): Promise<DetectedOrphan[] | null> {
  let managedContainers: Awaited<ReturnType<typeof listContainers>>;
  try {
    managedContainers = await listContainers();
  } catch (err) {
    log.warn(
      { event: 'orphan_sweep_docker_unavailable', err },
      'Skipping orphan sweep — Docker unreachable'
    );
    return null;
  }

  const managedIds = new Set(managedContainers.map((c) => c.Id));

  const activeTasks: Task[] = [];
  for (const status of ACTIVE_STATUSES) {
    activeTasks.push(...getTasks({ status }));
  }

  const orphans: DetectedOrphan[] = [];

  for (const task of activeTasks) {
    let kind: OrphanKind | null = null;

    if (task.container_id === null) {
      kind = 'null_container';
    } else if (!managedIds.has(task.container_id)) {
      kind = 'missing_container';
    }

    if (kind === null) continue;

    // Find the most recent running attempt row. Without one, the task is
    // merely between roles (e.g. dev just completed, review not launched
    // yet) and not actually orphaned.
    const stuckAttempt = findStuckAttempt(task);
    if (!stuckAttempt) continue;

    orphans.push({ task, stuckAttempt, kind });
  }

  return orphans;
}

/**
 * Top-level sweep: detect orphans, then recover each one according to its
 * attempt role. Re-entry is prevented by a caller-supplied mutex flag via
 * the `Scheduler` integration; this function itself is not mutex-aware.
 */
export async function runOrphanSweep(
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger
): Promise<void> {
  const orphans = await detectOrphans(log);
  if (orphans === null) return;
  if (orphans.length === 0) return;

  for (const orphan of orphans) {
    const { task, stuckAttempt, kind } = orphan;

    log.warn(
      {
        event: 'orphan_detected',
        task_id: task.id,
        attempt_id: stuckAttempt.id,
        role: stuckAttempt.role,
        kind,
      },
      'Orphaned task detected'
    );
    recordTaskEvent(
      task.id,
      'orphan_detected',
      `Orphan detected: attempt ${stuckAttempt.attempt_number ?? '?'} (${stuckAttempt.role}) has no container (${kind})`
    );

    if (stuckAttempt.role === 'review') {
      await recoverReviewOrphan(task, stuckAttempt, forgejo, log);
    } else {
      await recoverDevOrphan(task, stuckAttempt, forgejo, scheduler, log);
    }
  }
}

/**
 * Recover a review-role orphan.
 *
 *  - Finalise the stuck `attempts` row as `failed`.
 *  - If the task has attempts remaining and the prior launch wasn't a
 *    crash loop: increment `tasks.attempt`, clear `container_id`, leave
 *    status as `in-review`. `fillSlots` relaunches the review container
 *    on the next tick.
 *  - Otherwise escalate to `failed`.
 *
 * Review orphans are safe to relaunch because a review agent only reads
 * the PR diff — no workspace mutation has happened.
 */
export async function recoverReviewOrphan(
  task: Task,
  stuckAttempt: Attempt,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  finaliseAttemptAsFailed(stuckAttempt, 'Container disappeared before review completed');

  if (isCrashLoop(task, stuckAttempt)) {
    await markExhausted(
      task,
      'Review container crash-looped (new launch failed within 30 seconds)',
      forgejo,
      log
    );
    return;
  }

  const nextAttempt = task.attempt + 1;
  const maxAttempts = task.max_attempts ?? 3;
  if (nextAttempt > maxAttempts) {
    await markExhausted(
      task,
      `Exhausted ${maxAttempts} attempts during orphan recovery`,
      forgejo,
      log
    );
    return;
  }

    updateTaskWithSync(task.id, {
      attempt: nextAttempt,
      container_id: null,
      // status stays 'in-review' — fillSlots (queue.ts:26) already prioritises
      // in-review tasks without a container.
    });

    try {
      const repo = getRepo(task.repo_id);
      if (repo) {
        await forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Orphan recovery: review container disappeared. Relaunching review agent (attempt ${nextAttempt}/${maxAttempts}).`
        );
      }
    } catch {
      /* best effort */
    }

    recordTaskEvent(
      task.id,
      'orphan_recovery_triggered',
      `Review orphan recovered — relaunching review (attempt ${nextAttempt}/${maxAttempts})`
    );

  log.info(
    {
      event: 'orphan_recovered_review',
      task_id: task.id,
      attempt: nextAttempt,
    },
    'Review orphan recovered'
  );
}

/**
 * Recover a develop-role orphan.
 *
 * Unlike review, a dev container may have made uncommitted changes in its
 * workspace before disappearing, and the branch it pushed is a speculative
 * partial. We therefore call the full `resetTask` flow (stop stale
 * container, delete remote branch, close PR, wipe workspace, clear status
 * labels) and requeue the task at the back of the FIFO queue with the
 * attempt counter bumped.
 *
 * Guards are the same as review recovery: a fresh orphan within
 * CRASH_LOOP_WINDOW_MS or a bumped attempt exceeding max_attempts both
 * escalate the task to `failed` instead of resetting.
 */
export async function recoverDevOrphan(
  task: Task,
  stuckAttempt: Attempt,
  forgejo: ForgejoClient,
  scheduler: Scheduler,
  log: FastifyBaseLogger
): Promise<void> {
  finaliseAttemptAsFailed(stuckAttempt, 'Container disappeared before develop completed');

  if (isCrashLoop(task, stuckAttempt)) {
    await markExhausted(
      task,
      'Develop container crash-looped (new launch failed within 30 seconds)',
      forgejo,
      log
    );
    return;
  }

  const nextAttempt = task.attempt + 1;
  const maxAttempts = task.max_attempts ?? 3;
  if (nextAttempt > maxAttempts) {
    await markExhausted(
      task,
      `Exhausted ${maxAttempts} attempts during orphan recovery`,
      forgejo,
      log
    );
    return;
  }

  // Hand off to the shared reset flow. `incrementAttempt` bumps
  // tasks.attempt instead of resetting to 1; `requeue` drops the task back
  // into the FIFO queue instead of the terminal `reset` state so the
  // scheduler picks it up on the next tick without human intervention.
  await resetTask(task, forgejo, scheduler, log, {
    reason: `Dev orphan recovery (attempt ${nextAttempt}/${maxAttempts})`,
    incrementAttempt: true,
    requeue: true,
  });

  try {
    const repo = getRepo(task.repo_id);
    if (repo) {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Orphan recovery: dev container disappeared. Relaunching dev agent (attempt ${nextAttempt}/${maxAttempts}).`
      );
    }
  } catch {
    /* best effort */
  }

  recordTaskEvent(
    task.id,
    'orphan_recovery_triggered',
    `Dev orphan recovered — requeued (attempt ${nextAttempt}/${maxAttempts})`
  );
  log.info(
    {
      event: 'orphan_recovered_develop',
      task_id: task.id,
      attempt: nextAttempt,
    },
    'Dev orphan recovered'
  );
}

/**
 * Escalate an orphaned task to `failed` because it has exhausted its
 * attempts, or because it entered a crash loop. Comments on the Forgejo
 * issue so a human notices.
 */
async function markExhausted(
  task: Task,
  reason: string,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  updateTaskWithSync(task.id, {
    status: 'failed',
    container_id: null,
    completed_at: new Date().toISOString(),
  });

  recordTaskEvent(task.id, 'orphan_recovery_exhausted', reason);
  log.error(
    { event: 'orphan_recovery_exhausted', task_id: task.id, reason },
    'Orphan recovery exhausted — marking task as failed'
  );

  const repo = getRepo(task.repo_id);
  if (repo) {
    try {
      await forgejo.commentOnIssue(
        repo,
        task.issue_id,
        `Orchestrator could not recover this task: ${reason}. Marked as failed. Use the Reset action to re-run from scratch.`
      );
    } catch {
      // Best effort — the DB state and UI health badge already reflect the failure.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finaliseAttemptAsFailed(attempt: Attempt, feedback: string): void {
  updateAttempt(attempt.id, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    feedback,
  });
}

function findStuckAttempt(task: Task): Attempt | undefined {
  // Walk attempts newest-first and return the first `running` row. Don't
  // filter by role here — the role of the stuck attempt is the signal
  // the sweep needs to pick a recovery path.
  const attempts = getAttempts(task.id);
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].status === 'running') return attempts[i];
  }
  return undefined;
}

function isCrashLoop(task: Task, stuckAttempt: Attempt): boolean {
  // If the freshly-orphaned attempt started within CRASH_LOOP_WINDOW_MS ago,
  // relaunching is almost certainly pointless — something is wrong with the
  // image, the host, or the task payload, and another spin-up will just
  // fail the same way.
  if (!stuckAttempt.started_at) return false;
  const startedMs = Date.parse(stuckAttempt.started_at);
  if (Number.isNaN(startedMs)) return false;
  const ageMs = Date.now() - startedMs;
  return ageMs >= 0 && ageMs < CRASH_LOOP_WINDOW_MS;
}

/**
 * Given a task, compute the health signal the UI and API should expose.
 * Pure function over (task, managedContainerIds, runningAttempt). Lives
 * here so the definition of "orphaned" stays tied to the recovery logic
 * that acts on it.
 */
export function computeTaskHealth(
  task: Task,
  managedContainerIds: Set<string>,
  runningAttempt: Attempt | undefined
): 'healthy' | 'orphaned' | 'idle' {
  if (!ACTIVE_STATUSES.has(task.status)) return 'idle';

  const hasRunningAttempt = runningAttempt !== undefined;
  if (!hasRunningAttempt) return 'healthy'; // between roles — not orphaned.

  if (task.container_id === null) return 'orphaned';
  if (!managedContainerIds.has(task.container_id)) return 'orphaned';
  return 'healthy';
}

/**
 * Resolve the display name of a running container, if any. Returns the
 * first managed container name Docker reports (without the leading slash
 * Docker puts in front of names), or null when no container is running.
 */
export async function getContainerDisplayName(
  containerId: string | null,
  log: FastifyBaseLogger
): Promise<string | null> {
  if (!containerId) return null;
  try {
    const container = getContainer(containerId);
    const info = await inspectContainer(container);
    const name = info.Name ?? '';
    return name.startsWith('/') ? name.slice(1) : name || null;
  } catch (err) {
    log.debug(
      { event: 'container_name_lookup_failed', container_id: containerId, err },
      'Could not resolve container name'
    );
    return null;
  }
}
