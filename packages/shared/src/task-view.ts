/**
 * The task object every consumer outside the server sees.
 *
 * `Task` (types.ts) is the raw SQLite row; `TaskView` is the enriched
 * serialization built on top of it — the repo tuple, the synced dependency
 * projection and its derived `blocked` flags, container health, and the
 * resolved agent-profile chains. One shape, one producer
 * (`packages/server/src/task-view.ts`), used by BOTH `GET /api/tasks` and
 * every dashboard WebSocket payload. Typing the WS events as the bare `Task`
 * row is what previously let each `task_updated` event downgrade an enriched
 * row in the client store — so the two must never diverge again, and a
 * divergence is now a compile error.
 */

import type { Task, TaskDependency, TaskStatus } from './types.js';

/** Runtime health derived from container state. 'orphaned' means the task
 *  looks active but its container has vanished; the orchestrator attempts
 *  recovery on the next sweep. */
export type TaskHealth = 'healthy' | 'orphaned' | 'idle';

/** Tier the effective implementation profile was resolved from. */
export type AgentProfileSource = 'task' | 'repo' | 'global' | 'none';

/** Tier the effective review profile was resolved from. 'implementation' =
 *  no review tier is set anywhere, so review runs with the implementation
 *  profile. */
export type ReviewAgentProfileSource =
  | 'task'
  | 'repo'
  | 'global'
  | 'implementation'
  | 'none';

export interface TaskRepoRef {
  id: number;
  owner: string;
  name: string;
}

export interface TaskView extends Omit<Task, 'issue_title'> {
  /** Never null on the wire — falls back to `Issue #<n>` when the stored
   *  title is missing. */
  issue_title: string;
  /** Forgejo-derived status: what the UI should show. Equal to
   *  `runtime_status` when no Forgejo snapshot is available. */
  status: TaskStatus;
  /** The stored orchestrator status, before derivation. */
  runtime_status: TaskStatus;
  repo: TaskRepoRef | null;
  /** Synced projection of the issue body's `## Dependencies` checklist. */
  dependencies: TaskDependency[];
  /** Unsatisfied dependency issue numbers (empty when none gate launch). */
  blocked_by: number[];
  /** True when the task is queued and unsatisfied dependencies prevent it
   *  from launching. Presentation-only — the status stays `queued`. */
  blocked: boolean;
  health: TaskHealth;
  /** Human-readable container name if one is currently running. Only
   *  populated by the single-task detail endpoint (resolving it costs a
   *  Docker inspect); null everywhere else. */
  container_name: string | null;
  /** Effective profile id resolved through the chain
   *  task → repo → settings.default_agent_profile_id. Null only when none
   *  of the three is set, in which case the task can't launch. */
  effective_agent_profile_id: string | null;
  agent_profile_source: AgentProfileSource;
  /** Repo's configured default profile id (second tier of the chain). */
  repo_agent_profile_id: string | null;
  /** Global default profile id (third / fallback tier). */
  global_agent_profile_id: string | null;
  /** Effective REVIEW-stage profile id, resolved task → repo → global
   *  review default → the effective implementation profile. */
  effective_review_agent_profile_id: string | null;
  review_agent_profile_source: ReviewAgentProfileSource;
  repo_review_agent_profile_id: string | null;
  global_review_agent_profile_id: string | null;
  /** Live read of the Forgejo `human-review` driver label. true = the
   *  automated review agent is skipped for this task, so the review profile
   *  is unused. null = unknown (no snapshot available). Absent on the
   *  non-derived paths (POST/PATCH responses); the UI re-fetches after
   *  mutations. */
  has_human_review_label?: boolean | null;
}
