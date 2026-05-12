import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getTasks, getQueuedTasks, getSettingInt } from '../db.js';
import { getActiveResources } from '../queue.js';
import type {
  DashboardSnapshot,
  DashboardEvent,
  HostPool,
} from '@orchestrator/shared';

const clients = new Set<WebSocket>();

/** Source of the live `paused` flag for the WS snapshot. Wired up at
 *  registration time so the snapshot reflects the scheduler's real
 *  state — previously this was hardcoded to `false`, which left every
 *  newly-connecting dashboard showing "Running" until the periodic
 *  REST poll completed even when the scheduler was paused. (F1) */
let getPausedState: () => boolean = () => false;

/** Factory wrapping the Fastify plugin so we can inject the scheduler's
 *  isPaused() getter without making the plugin depend on the full
 *  Scheduler class. Mirrors the pattern used by `createTaskRoutes` /
 *  `createStatusRoutes` etc. */
export function createDashboardWs(opts: {
  isPaused: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  getPausedState = opts.isPaused;
  return dashboardWs;
}

export async function dashboardWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/dashboard', { websocket: true }, (socket) => {
    clients.add(socket);

    // Send initial snapshot
    const snapshot = buildSnapshot();
    socket.send(JSON.stringify(snapshot));

    socket.on('close', () => {
      clients.delete(socket);
    });

    socket.on('error', () => {
      clients.delete(socket);
    });
  });
}

/** Broadcast an event to all connected dashboard clients. */
export function broadcastDashboardEvent(event: DashboardEvent): void {
  const msg = JSON.stringify(event);
  for (const client of clients) {
    try {
      client.send(msg);
    } catch {
      clients.delete(client);
    }
  }
}

/** Convenience: notify dashboard clients that a config resource changed.
 *  Settings tabs and the Dashboard's profile cache subscribe to this
 *  and refetch the affected resource. Cheap (no payload) so it's safe
 *  to call from every CRUD route after a successful mutation. */
export function broadcastResourceChanged(
  resource: 'providers' | 'models' | 'profiles'
): void {
  broadcastDashboardEvent({ type: 'resource_changed', resource });
}

/** Snapshot of the host resource pool — used by snapshot + status_changed
 *  events. Pulled from the same source the scheduler gates against, so
 *  the dashboard never disagrees with the scheduler's view. */
export function buildHostPool(): HostPool {
  const used = getActiveResources();
  return {
    memory_used_mb: used.memoryMb,
    memory_total_mb: getSettingInt('max_agent_memory_mb'),
    cpu_used_cores: used.cpuCores,
    cpu_total_cores: getSettingInt('max_agent_cpu_cores'),
  };
}

function buildSnapshot(): DashboardSnapshot {
  return {
    type: 'snapshot',
    tasks: getTasks(),
    hostPool: buildHostPool(),
    queueDepth: getQueuedTasks().length,
    paused: getPausedState(),
  };
}

/** Convenience wrapper for the pause/resume route handlers. Builds the
 *  full StatusChangedEvent payload (paused + hostPool + queueDepth) so
 *  connected dashboards don't have to issue a follow-up REST poll to
 *  see a freshly-paused / resumed scheduler. Without this, the pause
 *  state only propagated when each client's 5-second status poll
 *  cycled. (F2) */
export function broadcastStatusChanged(paused: boolean): void {
  broadcastDashboardEvent({
    type: 'status_changed',
    paused,
    hostPool: buildHostPool(),
    queueDepth: getQueuedTasks().length,
  });
}
