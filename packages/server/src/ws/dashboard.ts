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
    paused: false,
  };
}
