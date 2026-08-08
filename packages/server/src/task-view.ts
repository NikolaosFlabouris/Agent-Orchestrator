/**
 * The one and only producer of the `TaskView` wire object.
 *
 * Both `GET /api/tasks` and every dashboard WebSocket payload go through
 * here, so a task looks identical however the client received it. The two
 * callers differ ONLY in how the two external inputs — the Forgejo snapshot
 * and the Docker container list — are obtained:
 *
 *   REST      `enrichTaskWithDerivation` — awaits `getSnapshot`
 *             (stale-while-revalidate, warmed in batch by the route) and is
 *             handed `managedIds` from one Docker list call.
 *
 *   Broadcast `buildTaskView` — SYNCHRONOUS. Reads the snapshot cache with
 *             `peekSnapshot` (never fetches, never schedules a refresh) and
 *             passes no `managedIds`, so health uses the Docker-free
 *             fallback. `broadcastDashboardEvent` runs on hot paths
 *             including the scheduler tick; it must never await network I/O.
 *             When no snapshot is cached the payload carries the stored
 *             status — exactly the degradation contract `deriveStatus`
 *             documents.
 *
 * Shape is never conditional on the caller.
 */

import type {
  Task,
  TaskView,
  Attempt,
  Repo,
  AgentProfileSource,
  ReviewAgentProfileSource,
} from '@orchestrator/shared';
import { DRIVER_LABELS } from '@orchestrator/shared';
import {
  getRepo,
  getRepos,
  getActiveAttempt,
  getRunningAttempts,
  getTaskDependencies,
  getSetting,
} from './db.js';
import { isBlocked, unsatisfiedDepIssues } from './dependency-state.js';
import {
  computeTaskHealth,
  deriveHealthWithoutDocker,
} from './task-health.js';
import { getSnapshot, peekSnapshot } from './forgejo-snapshot.js';
import type { Snapshot } from './forgejo-snapshot.js';
import { deriveStatus } from './status-derivation.js';
import type { ForgejoClient } from './forgejo.js';

/** The two settings rows that feed every task's profile-resolution chain.
 *  Loop-invariant, so callers enriching N tasks resolve them once instead of
 *  issuing 2N settings reads. */
export interface ProfileDefaults {
  agentProfileId: string | null;
  reviewAgentProfileId: string | null;
}

export interface TaskViewContext {
  /** Ids of all orchestrator-managed containers, for health derivation.
   *  If undefined, health computation skips the Docker cross-check (see
   *  `deriveHealthWithoutDocker`). Never set on the broadcast path. */
  managedIds?: Set<string>;
  /** Pre-resolved container display name. Only set for single-task lookups
   *  that warrant a targeted inspect call. */
  containerName?: string | null;
  /** Pre-resolved global profile defaults. Omit for one-off enrichment;
   *  pass for list/snapshot builds. */
  defaults?: ProfileDefaults;
  /** Pre-batched running attempt per task id (one WHERE status='running'
   *  query for the whole list, see `loadTaskViewBatches`). Omit for
   *  single-task enrichment, which takes the targeted getActiveAttempt
   *  path instead. */
  runningAttempts?: Map<number, Attempt>;
  /** Pre-batched repos by id (one SELECT for the whole list). Omit for
   *  single-task enrichment. */
  repos?: Map<number, Repo>;
}

/** One-query-each batches of the per-task lookups `enrichTask` would
 *  otherwise issue N times over a list: the running attempt per task
 *  (bounded by scheduler concurrency — tiny, and free of the completed
 *  rows' large feedback blobs) and the repos table. Built once per
 *  `GET /api/tasks` request / WS snapshot and passed via TaskViewContext. */
export function loadTaskViewBatches(): Pick<
  TaskViewContext,
  'runningAttempts' | 'repos'
> {
  const runningAttempts = new Map<number, Attempt>();
  // id ASC + overwrite ⇒ the highest-id running attempt per task wins,
  // matching getActiveAttempt's `id DESC LIMIT 1`.
  for (const attempt of getRunningAttempts()) {
    runningAttempts.set(attempt.task_id, attempt);
  }
  const repos = new Map(getRepos().map((repo) => [repo.id, repo]));
  return { runningAttempts, repos };
}

/** Read the global profile defaults once. */
export function loadProfileDefaults(): ProfileDefaults {
  return {
    agentProfileId: getSetting('default_agent_profile_id') ?? null,
    reviewAgentProfileId: getSetting('default_review_agent_profile_id') ?? null,
  };
}

/**
 * Resolve the effective agent profile id and its source for a task.
 * Three-tier chain: task.agent_profile_id → repo.agent_profile_id →
 * settings.default_agent_profile_id. Exported for unit tests; the
 * authoritative launch-time resolution lives in scheduler.resolveProfile().
 */
export function resolveEffectiveAgentProfile(
  taskAgentProfile: string | null,
  repoAgentProfile: string | null,
  globalDefaultProfile: string | null
): {
  effective_agent_profile_id: string | null;
  agent_profile_source: AgentProfileSource;
} {
  if (taskAgentProfile !== null) {
    return {
      effective_agent_profile_id: taskAgentProfile,
      agent_profile_source: 'task',
    };
  }
  if (repoAgentProfile !== null) {
    return {
      effective_agent_profile_id: repoAgentProfile,
      agent_profile_source: 'repo',
    };
  }
  if (globalDefaultProfile !== null) {
    return {
      effective_agent_profile_id: globalDefaultProfile,
      agent_profile_source: 'global',
    };
  }
  return { effective_agent_profile_id: null, agent_profile_source: 'none' };
}

/**
 * Resolve the effective REVIEW profile id and its source for a task.
 * Chain: task.review_agent_profile_id → repo.review_agent_profile_id →
 * settings.default_review_agent_profile_id → the task's effective
 * implementation profile ('implementation' source — review runs with the
 * same profile as the implementation when no review tier is set).
 * Exported for unit tests; the authoritative launch-time resolution lives
 * in scheduler.resolveProfile() via db.resolveStageProfileId().
 */
export function resolveEffectiveReviewAgentProfile(
  taskReviewProfile: string | null,
  repoReviewProfile: string | null,
  globalReviewDefault: string | null,
  effectiveImplementationProfile: string | null
): {
  effective_review_agent_profile_id: string | null;
  review_agent_profile_source: ReviewAgentProfileSource;
} {
  if (taskReviewProfile !== null) {
    return {
      effective_review_agent_profile_id: taskReviewProfile,
      review_agent_profile_source: 'task',
    };
  }
  if (repoReviewProfile !== null) {
    return {
      effective_review_agent_profile_id: repoReviewProfile,
      review_agent_profile_source: 'repo',
    };
  }
  if (globalReviewDefault !== null) {
    return {
      effective_review_agent_profile_id: globalReviewDefault,
      review_agent_profile_source: 'global',
    };
  }
  if (effectiveImplementationProfile !== null) {
    return {
      effective_review_agent_profile_id: effectiveImplementationProfile,
      review_agent_profile_source: 'implementation',
    };
  }
  return {
    effective_review_agent_profile_id: null,
    review_agent_profile_source: 'none',
  };
}

/**
 * Build the task view from SQLite state alone — no Forgejo derivation
 * overlaid, so `status` is still the stored runtime status. Callers that
 * want the external-facing status use `buildTaskView` (sync) or
 * `enrichTaskWithDerivation` (async).
 */
export function enrichTask(task: Task, ctx: TaskViewContext = {}): TaskView {
  const repo = ctx.repos ? ctx.repos.get(task.repo_id) : getRepo(task.repo_id);

  // Only the RUNNING attempt feeds the view (health derivation) — loading
  // the full attempt history here pulled every completed row's feedback
  // blob per task, per list, per snapshot. getActiveAttempt is the
  // targeted single-task query; list callers pre-batch via
  // `loadTaskViewBatches` and pass the map.
  const runningAttempt = ctx.runningAttempts
    ? ctx.runningAttempts.get(task.id)
    : getActiveAttempt(task.id);
  const health = ctx.managedIds
    ? computeTaskHealth(task, ctx.managedIds, runningAttempt)
    : deriveHealthWithoutDocker(task, runningAttempt);

  // Surface the effective profile ids (per stage) and which tier each came
  // from so the UI can render the override / inherit chains without a
  // second round-trip. Task-level override wins, then repo default, then
  // the global default; the review chain additionally falls back to the
  // effective implementation profile.
  const defaults = ctx.defaults ?? loadProfileDefaults();
  const repoProfileId = repo?.agent_profile_id ?? null;
  const globalDefault = defaults.agentProfileId;
  const { effective_agent_profile_id, agent_profile_source } =
    resolveEffectiveAgentProfile(
      task.agent_profile_id,
      repoProfileId,
      globalDefault
    );

  const repoReviewProfileId = repo?.review_agent_profile_id ?? null;
  const globalReviewDefault = defaults.reviewAgentProfileId;
  const { effective_review_agent_profile_id, review_agent_profile_source } =
    resolveEffectiveReviewAgentProfile(
      task.review_agent_profile_id,
      repoReviewProfileId,
      globalReviewDefault,
      effective_agent_profile_id
    );

  // Blocked is presentation-only: computed at read time from the synced
  // dependency rows, never stored, never a TaskStatus.
  // Deliberately NOT batched into TaskViewContext: task_dependencies is a
  // narrow indexed table (no blobs), and the list paths are already bounded
  // by getDashboardTasks — the win would be marginal next to the attempts
  // N+1 the context removes.
  const dependencies = getTaskDependencies(task.id);

  return {
    ...task,
    issue_title: task.issue_title ?? `Issue #${task.issue_id}`,
    repo: repo ? { id: repo.id, owner: repo.owner, name: repo.name } : null,
    dependencies,
    blocked_by: unsatisfiedDepIssues(dependencies),
    blocked: task.status === 'queued' && isBlocked(dependencies),
    runtime_status: task.status,
    health,
    container_name: ctx.containerName ?? null,
    effective_agent_profile_id,
    agent_profile_source,
    repo_agent_profile_id: repoProfileId,
    global_agent_profile_id: globalDefault,
    effective_review_agent_profile_id,
    review_agent_profile_source,
    repo_review_agent_profile_id: repoReviewProfileId,
    global_review_agent_profile_id: globalReviewDefault,
  };
}

/**
 * Read the human-review driver label off a Forgejo snapshot. The label —
 * not a task column — is what makes the orchestrator skip the automated
 * review agent, so this is the live answer to "will a review agent run
 * for this task?". Returns null when no snapshot is available (Forgejo
 * unreachable / not yet fetched): "unknown", which the UI treats as
 * not-enabled. Exported for unit tests.
 */
export function hasHumanReviewLabel(snapshot: Snapshot | null): boolean | null {
  if (!snapshot) return null;
  return snapshot.issue.labels.includes(DRIVER_LABELS.HUMAN_REVIEW);
}

/**
 * Overlay the Forgejo-derived status (and the human-review label read) on
 * an already-enriched view. `status` becomes the derived value — what the
 * UI should show — while `runtime_status` keeps the stored orchestrator
 * state for debugging. A null snapshot leaves the stored status in place.
 */
function applyDerivation(
  base: TaskView,
  task: Task,
  snapshot: Snapshot | null
): TaskView {
  const derived = deriveStatus(task, snapshot);
  return {
    ...base,
    status: derived.status,
    // Re-key blocked on the DERIVED status: a queued task whose issue was
    // closed externally reads as cancelled, not blocked. (derived ===
    // 'queued' implies stored === 'queued', so base.blocked is reusable.)
    blocked: derived.status === 'queued' && base.blocked,
    has_human_review_label: hasHumanReviewLabel(snapshot),
  };
}

/**
 * Enrich a task and overlay the Forgejo-derived status, fetching the
 * snapshot if the cache can't serve it. Snapshot failures fall back to the
 * stored status — the API stays responsive if Forgejo is briefly
 * unreachable. REST-only: the broadcast path must not await Forgejo.
 */
export async function enrichTaskWithDerivation(
  task: Task,
  forgejo: ForgejoClient,
  ctx: TaskViewContext = {}
): Promise<TaskView> {
  const base = enrichTask(task, ctx);

  let snapshot: Snapshot | null = null;
  try {
    snapshot = await getSnapshot(task, forgejo);
  } catch {
    // Best effort — derivation falls back to stored status.
  }
  return applyDerivation(base, task, snapshot);
}

/**
 * Synchronous, network-free, Docker-free task view for the WebSocket
 * broadcast path. Identical output shape to `enrichTaskWithDerivation`;
 * the derived status is only as good as whatever the snapshot cache
 * already holds (warm → derived, cold → stored status).
 */
export function buildTaskView(
  task: Task,
  ctx: TaskViewContext = {}
): TaskView {
  const base = enrichTask(task, ctx);
  return applyDerivation(base, task, peekSnapshot(task.id));
}
