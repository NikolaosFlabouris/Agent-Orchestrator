/**
 * Per-socket dashboard heartbeat (issue #148).
 *
 * Neither side used to ping, so a silently dead TCP connection was never
 * detected: the server kept a phantom client and the browser sat on stale
 * data. The heartbeat also has to clean itself up on BOTH `close` and
 * `error` — a long-lived orchestrator would otherwise leak one interval per
 * connection that errored without closing cleanly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The snapshot/status builders read SQLite + the queue; this suite is about
// timer lifecycle, so stub them to fixed values instead of standing up a DB.
vi.mock('../../db.js', () => ({
  getTasks: () => [],
  getQueuedTasks: () => [],
  getSettingInt: () => 0,
}));
vi.mock('../../queue.js', () => ({
  getActiveResources: () => ({ memoryMb: 0, cpuCores: 0 }),
}));
vi.mock('../../task-view.js', () => ({
  buildTaskView: (task: unknown) => task,
  loadProfileDefaults: () => ({}),
}));

const { dashboardWs } = await import('../../ws/dashboard.js');

/** Minimal stand-in for the `ws` socket the Fastify plugin hands us. */
class FakeSocket {
  sent: string[] = [];
  pings = 0;
  terminated = 0;
  private handlers = new Map<string, (() => void)[]>();

  on(event: string, handler: () => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string) {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  ping() {
    this.pings++;
  }

  terminate() {
    this.terminated++;
    this.emit('close');
  }

  /** Frame types the socket received, in order. */
  types(): string[] {
    return this.sent.map((s) => JSON.parse(s).type);
  }
}

/** Registers the plugin and returns the socket handler it installed. */
async function socketHandler(): Promise<(socket: FakeSocket) => void> {
  let handler: ((socket: FakeSocket) => void) | null = null;
  const app = {
    get: (
      path: string,
      _opts: unknown,
      route: (socket: FakeSocket) => void
    ) => {
      expect(path).toBe('/ws/dashboard');
      handler = route;
    },
  } as unknown as FastifyInstance;
  await dashboardWs(app);
  expect(handler).not.toBeNull();
  return handler!;
}

const PING_INTERVAL_MS = 25_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dashboard WebSocket heartbeat', () => {
  it('sends the snapshot immediately, then beats on an interval', async () => {
    const handler = await socketHandler();
    const socket = new FakeSocket();
    handler(socket);

    expect(socket.types()).toEqual(['snapshot']);
    expect(socket.pings).toBe(0);

    vi.advanceTimersByTime(PING_INTERVAL_MS);
    // A protocol ping (keeps the path warm, gives us a dead-peer signal)
    // plus a frame the browser can actually observe — pong frames are
    // invisible to JS, so the client's staleness watchdog needs this.
    expect(socket.pings).toBe(1);
    expect(socket.types()).toEqual(['snapshot', 'status_changed']);

    socket.emit('pong');
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.pings).toBe(2);
    expect(socket.types()).toEqual([
      'snapshot',
      'status_changed',
      'status_changed',
    ]);

    socket.emit('close');
  });

  it('clears the interval when the socket closes', async () => {
    const handler = await socketHandler();
    const socket = new FakeSocket();
    handler(socket);
    const before = vi.getTimerCount();
    expect(before).toBeGreaterThan(0);

    socket.emit('close');

    expect(vi.getTimerCount()).toBe(before - 1);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 4);
    expect(socket.pings).toBe(0);
  });

  it('clears the interval when the socket errors without closing', async () => {
    const handler = await socketHandler();
    const socket = new FakeSocket();
    handler(socket);
    const before = vi.getTimerCount();

    socket.emit('error');

    expect(vi.getTimerCount()).toBe(before - 1);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 4);
    expect(socket.pings).toBe(0);
  });

  it('leaks no timer across many connect/disconnect cycles', async () => {
    const handler = await socketHandler();
    const baseline = vi.getTimerCount();

    for (let i = 0; i < 25; i++) {
      const socket = new FakeSocket();
      handler(socket);
      socket.emit(i % 2 === 0 ? 'close' : 'error');
    }

    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('terminates a peer that stops ponging', async () => {
    const handler = await socketHandler();
    const socket = new FakeSocket();
    handler(socket);

    // First beat pings and clears the pong flag; the peer never answers.
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.terminated).toBe(0);

    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.terminated).toBe(1);
    // terminate() surfaces as a close, which must have cleared the timer.
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(PING_INTERVAL_MS * 4);
    expect(socket.terminated).toBe(1);
    expect(socket.pings).toBe(1);
  });
});
