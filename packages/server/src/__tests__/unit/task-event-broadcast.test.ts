/**
 * Timeline streaming (issue #149).
 *
 * `recordTaskEvent` has 39 call sites and `updateTaskWithSync` writes a
 * status row of its own; before this change all of them wrote a
 * `task_events` row and told nobody, so the Task Detail timeline only moved
 * when an unrelated `task_updated` happened to trigger a full refetch.
 *
 * Nothing is mocked here: the assertions read the JSON frames a connected
 * dashboard socket actually receives, so the row that lands in SQLite is
 * checked against the row that goes on the wire. A no-op status write has to
 * stay silent — this fires from hot paths during a run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type {
  DashboardEvent,
  Repo,
  TaskEventAppendedEvent,
} from '@orchestrator/shared';
import { initDatabase, insertTask, getTaskEvents } from '../../db.js';
import { dashboardWs } from '../../ws/dashboard.js';
import { recordTaskEvent, updateTaskWithSync } from '../../state-sync.js';

type SocketHandler = (socket: WebSocket) => void;

/** Same harness as dashboard-ws-heartbeat.test.ts: capture the route handler
 *  and drive it with a fake socket, no real server needed. */
async function captureHandler(): Promise<SocketHandler> {
  let captured: SocketHandler | null = null;
  const app = {
    get(_path: string, _opts: unknown, handler: SocketHandler) {
      captured = handler;
    },
  } as unknown as FastifyInstance;
  await dashboardWs(app);
  if (!captured) throw new Error('dashboardWs registered no handler');
  return captured;
}

function fakeSocket() {
  const listeners = new Map<string, () => void>();
  const socket = {
    readyState: 1,
    sent: [] as string[],
    ping() {},
    send(msg: string) {
      socket.sent.push(msg);
    },
    on(event: string, cb: () => void) {
      listeners.set(event, cb);
      return socket;
    },
    emit(event: string) {
      listeners.get(event)?.();
    },
  };
  return socket;
}

let db: ReturnType<typeof initDatabase>;
let socket: ReturnType<typeof fakeSocket>;

/** Every frame the connected client received, parsed, minus the connect-time
 *  snapshot. */
function received(): DashboardEvent[] {
  return socket.sent
    .map((msg) => JSON.parse(msg) as DashboardEvent)
    .filter((e) => e.type !== 'snapshot');
}

function taskEventFrames(): TaskEventAppendedEvent[] {
  return received().filter(
    (e): e is TaskEventAppendedEvent => e.type === 'task_event'
  );
}

function seedRepo(id: number, overrides: Partial<Repo> = {}): void {
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (?, 'owner', ?)`).run(
    id,
    overrides.name ?? `repo${id}`
  );
}

beforeEach(async () => {
  db = initDatabase(':memory:');
  vi.useFakeTimers();
  const handler = await captureHandler();
  socket = fakeSocket();
  handler(socket as unknown as WebSocket);
  seedRepo(1);
});

afterEach(() => {
  // Deregisters the socket from the module-level client set and clears its
  // heartbeat timer — otherwise frames would leak between tests.
  socket.emit('close');
  vi.useRealTimers();
});

describe('recordTaskEvent', () => {
  it('broadcasts the persisted row — id, type, message and timestamp', () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'preparing' });

    recordTaskEvent(task.id, 'workspace_cloned', 'Workspace cloned for owner/repo1');

    const persisted = getTaskEvents(task.id);
    expect(persisted).toHaveLength(1);

    const frames = taskEventFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].taskId).toBe(task.id);
    expect(frames[0].event).toEqual(persisted[0]);
    // Spelled out, because the client renders exactly these four fields.
    expect(frames[0].event.id).toBe(persisted[0].id);
    expect(frames[0].event.event_type).toBe('workspace_cloned');
    expect(frames[0].event.message).toBe('Workspace cloned for owner/repo1');
    expect(frames[0].event.created_at).toBe(persisted[0].created_at);
  });

  it('carries the row alone — never the task', () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'preparing' });

    recordTaskEvent(task.id, 'branch_created', 'Branch feat/x created from main');

    // A task payload here would put the whole enriched view on the wire many
    // times per attempt.
    expect(Object.keys(taskEventFrames()[0]).sort()).toEqual([
      'event',
      'taskId',
      'type',
    ]);
  });

  it('emits one frame per call, in call order', () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'preparing' });

    recordTaskEvent(task.id, 'workspace_cloned', 'first');
    recordTaskEvent(task.id, 'branch_created', 'second');

    expect(taskEventFrames().map((e) => e.event.message)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('updateTaskWithSync', () => {
  it('emits both a task_updated and a task_event when the status changes', () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });

    updateTaskWithSync(task.id, { status: 'in-progress' });

    const frames = taskEventFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].taskId).toBe(task.id);
    expect(frames[0].event.event_type).toBe('status_in-progress');
    expect(frames[0].event.message).toBe('Implementation started');
    expect(frames[0].event).toEqual(getTaskEvents(task.id)[0]);

    expect(received().filter((e) => e.type === 'task_updated')).toHaveLength(1);
  });

  it('emits no task_event when the status is unchanged', () => {
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });

    updateTaskWithSync(task.id, { queue_position: 3 });
    updateTaskWithSync(task.id, { status: 'queued' });

    expect(taskEventFrames()).toHaveLength(0);
    expect(getTaskEvents(task.id)).toHaveLength(0);
    // …while the task itself is still broadcast on both writes.
    expect(received().filter((e) => e.type === 'task_updated')).toHaveLength(2);
  });
});
