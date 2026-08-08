import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getTask } from '../db.js';
import { getOutputDir } from '../workspace.js';
import type { AgentOutputChunk, AgentOutputReplay, AgentStreamComplete } from '@orchestrator/shared';

/** Largest slice of progress.log a replay frame will carry. A long run can
 *  leave a log of hundreds of megabytes; sending it as one frame pins that
 *  much in the server's heap, in the socket buffer, and in the browser tab.
 *  Past this we send only the tail — the full file stays one click away via
 *  `GET /api/tasks/:id/log`, which streams it. */
export const MAX_REPLAY_BYTES = 256 * 1024;

/** Marker prefixed to a truncated replay. It is just another log line to the
 *  UI, which renders it like any other. */
export const TRUNCATION_MARKER =
  '--- log truncated; use Download for the full file ---';

/** Read the replay payload for a log file: the whole file when it is small,
 *  otherwise the last MAX_REPLAY_BYTES cut forward to the first newline (so
 *  the frame never opens mid-line, which would corrupt a JSON event line) and
 *  prefixed with the truncation marker.
 *
 *  Returns null when the file is missing, empty, or unreadable — the caller
 *  sends no replay frame at all in that case. */
export function buildReplayPayload(logPath: string): string | null {
  try {
    const size = fs.statSync(logPath).size;
    if (size === 0) return null;
    if (size <= MAX_REPLAY_BYTES) {
      return fs.readFileSync(logPath, 'utf-8') || null;
    }

    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_REPLAY_BYTES);
      const read = fs.readSync(fd, buffer, 0, MAX_REPLAY_BYTES, size - MAX_REPLAY_BYTES);
      let tail = buffer.subarray(0, read).toString('utf-8');
      // Drop the partial first line — which also drops the replacement char
      // a byte-offset read leaves behind when it lands mid-UTF-8-sequence.
      // If the tail holds no newline at all it is one enormous line — keep it
      // rather than emit nothing.
      const nl = tail.indexOf('\n');
      if (nl !== -1) tail = tail.slice(nl + 1);
      return `${TRUNCATION_MARKER}\n${tail}`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

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

      const content = buildReplayPayload(logPath);
      if (content) {
        const replay: AgentOutputReplay = {
          type: 'replay',
          taskId,
          data: content,
        };
        try {
          socket.send(JSON.stringify(replay));
        } catch {
          // Best effort — a socket that died between connect and replay.
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
