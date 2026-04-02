import type { Task } from './types.js';

/** WebSocket event types for the dashboard stream. */

export interface DashboardSnapshot {
  type: 'snapshot';
  tasks: Task[];
  activeCount: number;
  maxConcurrency: number;
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
  activeCount: number;
  queueDepth: number;
}

export type DashboardEvent =
  | DashboardSnapshot
  | TaskUpdatedEvent
  | TaskCreatedEvent
  | TaskRemovedEvent
  | StatusChangedEvent;

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
