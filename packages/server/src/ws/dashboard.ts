import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getTasks, getActiveTaskCount, getQueuedTasks, getSettingInt, getDb } from '../db.js';
import type { DashboardSnapshot, DashboardEvent } from '@orchestrator/shared';

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

function buildSnapshot(): DashboardSnapshot {
  const tasks = getTasks();
  const activeCount = getActiveTaskCount();
  const maxConcurrency = getSettingInt('max_concurrency');
  const queueDepth = getQueuedTasks().length;

  return {
    type: 'snapshot',
    tasks,
    activeCount,
    maxConcurrency,
    queueDepth,
    paused: false,
  };
}
