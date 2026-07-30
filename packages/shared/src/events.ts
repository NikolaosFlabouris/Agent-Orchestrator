import type { TaskEvent } from './types.js';
import type { TaskView } from './task-view.js';

/** WebSocket event types for the dashboard stream.
 *
 *  Task payloads carry the enriched `TaskView` — the SAME object
 *  `GET /api/tasks` returns, not the raw `Task` row. The client store
 *  replaces a task wholesale on `task_updated`, so anything less than the
 *  full view silently downgrades the row it lands on. */

/** Host resource pool utilisation. Replaces the old count-based slot
 *  metric — see schema v19. Each container's actual size (per-repo
 *  override or DEFAULT_CONTAINER_*) sums into `*_used_*`; cap is the
 *  global `max_agent_memory_mb` / `max_agent_cpu_cores` setting. */
export interface HostPool {
  memory_used_mb: number;
  memory_total_mb: number;
  cpu_used_cores: number;
  cpu_total_cores: number;
}

export interface DashboardSnapshot {
  type: 'snapshot';
  tasks: TaskView[];
  hostPool: HostPool;
  queueDepth: number;
  paused: boolean;
}

export interface TaskUpdatedEvent {
  type: 'task_updated';
  task: TaskView;
}

export interface TaskCreatedEvent {
  type: 'task_created';
  task: TaskView;
}

// NOTE: A `TaskRemovedEvent` type lived here previously but nothing ever
// emitted it — the orchestrator has no DELETE /api/tasks route (tasks
// transition to terminal states like `failed`/`cancelled`/`merged`
// rather than being deleted). It was removed to keep the union honest;
// if a delete path is added later, restore both the type and the
// matching client handler at the same commit. (F3)

/** A timeline row was appended for a task. Emitted by `recordTaskEvent` (and
 *  by the `task_created` and status-change inserts inside state-sync), so
 *  every granular progress note — workspace cloned, branch created, PR
 *  created, salvage deferred — reaches an open Task Detail page as it
 *  happens. `state-sync.ts` is the only module that calls `insertTaskEvent`
 *  directly, so a new call site streams without opting in.
 *
 *  Deliberately the SMALLEST payload in the union: this fires from hot
 *  paths during an active run, so it carries the inserted row only, never
 *  the task. A client that misses one still converges — the full `events`
 *  array comes back on the next `GET /api/tasks/:id`, so there is no
 *  ordering or acknowledgement machinery here.
 *
 *  `event.created_at` is whatever the row holds. Rows written since the fix
 *  for issue #72 are ISO 8601 UTC; the client normalizes on render, which
 *  is the same path a fetched row takes. */
export interface TaskEventAppendedEvent {
  type: 'task_event';
  /** Denormalised from `event.task_id` so a client can filter without
   *  reaching into the row. Always equal to `event.task_id`. */
  taskId: number;
  event: TaskEvent;
}

export interface StatusChangedEvent {
  type: 'status_changed';
  paused: boolean;
  hostPool: HostPool;
  queueDepth: number;
}

/** Server-side configuration changed — clients holding cached copies of
 *  providers, models, or agent profiles (the Settings tabs, the
 *  Dashboard's ToolChip lookup table) should refetch the relevant
 *  resource. Broadcast from the matching CRUD routes after a successful
 *  mutation. */
export interface ResourceChangedEvent {
  type: 'resource_changed';
  resource: 'providers' | 'models' | 'profiles';
}

export type DashboardEvent =
  | DashboardSnapshot
  | TaskUpdatedEvent
  | TaskCreatedEvent
  | TaskEventAppendedEvent
  | StatusChangedEvent
  | ResourceChangedEvent;

/** WebSocket event types for agent output streaming. */

export interface AgentOutputChunk {
  type: 'output';
  taskId: number;
  data: string;
  timestamp: string;
}

export interface AgentOutputReplay {
  type: 'replay';
  taskId: number;
  data: string;
}

export interface AgentStreamComplete {
  type: 'stream_complete';
  taskId: number;
}

export type AgentOutputEvent =
  | AgentOutputChunk
  | AgentOutputReplay
  | AgentStreamComplete;
