import type { Task } from './types.js';

/** WebSocket event types for the dashboard stream. */

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
  tasks: Task[];
  hostPool: HostPool;
  queueDepth: number;
  paused: boolean;
}

export interface TaskUpdatedEvent {
  type: 'task_updated';
  task: Task;
}

export interface TaskCreatedEvent {
  type: 'task_created';
  task: Task;
}

export interface TaskRemovedEvent {
  type: 'task_removed';
  taskId: number;
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
  | TaskRemovedEvent
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
