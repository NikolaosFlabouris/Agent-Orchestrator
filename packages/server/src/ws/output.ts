import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getTask } from '../db.js';
import { getOutputDir } from '../workspace.js';
import type { AgentOutputChunk, AgentOutputReplay, AgentStreamComplete } from '@orchestrator/shared';

/** Map of task ID → set of connected output clients. */
const outputClients = new Map<number, Set<WebSocket>>();

/** Map of task ID → file watcher. */
const watchers = new Map<number, fs.FSWatcher>();

export async function outputWs(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/ws/tasks/:id/output',
    { websocket: true },
    (socket, request) => {
      const taskId = parseInt(request.params.id, 10);
      const task = getTask(taskId);

      if (!task) {
        socket.close(4004, 'Task not found');
        return;
      }

      // Register client
      if (!outputClients.has(taskId)) {
        outputClients.set(taskId, new Set());
      }
      outputClients.get(taskId)!.add(socket);

      // Replay existing log
      const outputDir = getOutputDir(task);
      const logPath = path.join(outputDir, 'progress.log');

      if (fs.existsSync(logPath)) {
        try {
          const content = fs.readFileSync(logPath, 'utf-8');
          if (content) {
            const replay: AgentOutputReplay = {
              type: 'replay',
              taskId,
              data: content,
            };
            socket.send(JSON.stringify(replay));
          }
        } catch {
          // Best effort
        }
      }

      // Start watching for new output if not already watching
      if (!watchers.has(taskId) && task.container_id) {
        startWatching(taskId, logPath);
      }

      // Check if task is already complete
      if (!task.container_id && task.completed_at) {
        const complete: AgentStreamComplete = {
          type: 'stream_complete',
          taskId,
        };
        socket.send(JSON.stringify(complete));
      }

      socket.on('close', () => {
        const clients = outputClients.get(taskId);
        if (clients) {
          clients.delete(socket);
          if (clients.size === 0) {
            outputClients.delete(taskId);
            stopWatching(taskId);
          }
        }
      });

      socket.on('error', () => {
        const clients = outputClients.get(taskId);
        if (clients) {
          clients.delete(socket);
        }
      });
    }
  );
}

/** Send an output chunk to all clients watching a task. */
export function sendOutputChunk(taskId: number, data: string): void {
  const clients = outputClients.get(taskId);
  if (!clients || clients.size === 0) return;

  const event: AgentOutputChunk = {
    type: 'output',
    taskId,
    data,
    timestamp: new Date().toISOString(),
  };
  const msg = JSON.stringify(event);

  for (const client of clients) {
    try {
      client.send(msg);
    } catch {
      clients.delete(client);
    }
  }
}

/** Signal stream completion to all clients. */
export function sendStreamComplete(taskId: number): void {
  const clients = outputClients.get(taskId);
  if (!clients) return;

  const event: AgentStreamComplete = {
    type: 'stream_complete',
    taskId,
  };
  const msg = JSON.stringify(event);

  for (const client of clients) {
    try {
      client.send(msg);
    } catch {
      // Best effort
    }
  }

  stopWatching(taskId);
}

function startWatching(taskId: number, logPath: string): void {
  let lastSize = 0;
  try {
    if (fs.existsSync(logPath)) {
      lastSize = fs.statSync(logPath).size;
    }
  } catch {
    // File may not exist yet
  }

  try {
    const dir = path.dirname(logPath);
    const filename = path.basename(logPath);

    const watcher = fs.watch(dir, (eventType, changedFile) => {
      if (changedFile !== filename) return;

      try {
        const stat = fs.statSync(logPath);
        if (stat.size > lastSize) {
          const fd = fs.openSync(logPath, 'r');
          const buffer = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buffer, 0, buffer.length, lastSize);
          fs.closeSync(fd);
          lastSize = stat.size;

          const newData = buffer.toString('utf-8');
          if (newData) {
            sendOutputChunk(taskId, newData);
          }
        }
      } catch {
        // File may have been moved/deleted
      }
    });

    watchers.set(taskId, watcher);
  } catch {
    // Watch setup failed — clients will still get replay data
  }
}

function stopWatching(taskId: number): void {
  const watcher = watchers.get(taskId);
  if (watcher) {
    watcher.close();
    watchers.delete(taskId);
  }
}
