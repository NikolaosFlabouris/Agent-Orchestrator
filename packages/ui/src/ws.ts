import type { TaskResponse, StatusResponse } from './api.js';

type DashboardHandler = (event: DashboardWsEvent) => void;
type OutputHandler = (event: OutputWsEvent) => void;

export interface HostPool {
  memory_used_mb: number;
  memory_total_mb: number;
  cpu_used_cores: number;
  cpu_total_cores: number;
}

export interface DashboardSnapshot {
  type: 'snapshot';
  tasks: TaskResponse[];
  hostPool: HostPool;
  queueDepth: number;
  paused: boolean;
}

export type DashboardWsEvent =
  | DashboardSnapshot
  | { type: 'task_updated'; task: TaskResponse }
  | { type: 'task_created'; task: TaskResponse }
  | { type: 'status_changed'; paused: boolean; hostPool: HostPool; queueDepth: number }
  | {
      type: 'resource_changed';
      resource: 'providers' | 'models' | 'profiles';
    };

export type OutputWsEvent =
  | { type: 'output'; taskId: number; data: string; timestamp: string }
  | { type: 'replay'; taskId: number; data: string }
  | { type: 'stream_complete'; taskId: number };

/**
 * Dashboard WebSocket connection with exponential backoff reconnection.
 * On connect: receives snapshot → replaces local state.
 * On disconnect: auto-reconnects with backoff (1s, 2s, 4s, 8s, max 30s).
 */
export function connectDashboardWs(handler: DashboardHandler): () => void {
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/dashboard`);

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handler(event);
      } catch {
        // Invalid JSON
      }
    };

    ws.onopen = () => {
      backoff = 1000; // Reset backoff on successful connect
    };

    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(() => {
        backoff = Math.min(backoff * 2, 30000);
        connect();
      }, backoff);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  // Return cleanup function
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

/**
 * Agent output WebSocket connection.
 * On connect: receives replay of existing output, then live chunks.
 * On stream_complete: connection may be closed by server.
 */
export function connectOutputWs(
  taskId: number,
  handler: OutputHandler
): () => void {
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(
      `${protocol}//${location.host}/ws/tasks/${taskId}/output`
    );

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handler(event);
      } catch {
        // Invalid JSON
      }
    };

    ws.onopen = () => {
      backoff = 1000;
    };

    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(() => {
        backoff = Math.min(backoff * 2, 30000);
        connect();
      }, backoff);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
