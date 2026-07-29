/**
 * Dashboard WebSocket heartbeat (#148).
 *
 * Neither side used to ping, so a silently dead TCP connection — an idle NAT
 * timeout, a host IP change, a suspended laptop — never fired `onclose` and
 * the client's backoff reconnect never ran. The server now heartbeats each
 * socket; these tests pin both halves of that:
 *
 *  - the heartbeat carries an application-level frame, not just a protocol
 *    ping (a browser never surfaces an incoming ping frame to JavaScript, so
 *    a ping alone cannot prove liveness to the UI's staleness detector), and
 *  - the per-socket interval is cleared on BOTH the `close` and the `error`
 *    handler, so a long-lived server doesn't leak one timer per dropped
 *    connection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { initDatabase } from '../../db.js';
import { dashboardWs } from '../../ws/dashboard.js';

type SocketHandler = (socket: WebSocket) => void;

/** Captures the route handler `dashboardWs` registers so a test can drive it
 *  with a fake socket, without standing up a real Fastify + ws server. */
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

/** Minimal stand-in for a `ws` WebSocket. */
function fakeSocket() {
  const listeners = new Map<string, () => void>();
  const socket = {
    readyState: 1,
    sent: [] as string[],
    pings: 0,
    send(msg: string) {
      socket.sent.push(msg);
    },
    ping() {
      socket.pings += 1;
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

const PING_INTERVAL_MS = 25_000;

beforeEach(() => {
  initDatabase(':memory:');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dashboard ws heartbeat', () => {
  it('sends the snapshot immediately, then heartbeats on an interval', async () => {
    const handler = await captureHandler();
    const socket = fakeSocket();
    handler(socket as unknown as WebSocket);

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]).type).toBe('snapshot');
    expect(socket.pings).toBe(0);

    vi.advanceTimersByTime(PING_INTERVAL_MS);

    // Protocol ping (keeps NAT/proxy tables warm) AND an app-level frame the
    // browser can actually observe.
    expect(socket.pings).toBe(1);
    expect(socket.sent).toHaveLength(2);
    const beat = JSON.parse(socket.sent[1]);
    expect(beat.type).toBe('status_changed');
    expect(beat).toHaveProperty('hostPool');
    expect(beat).toHaveProperty('queueDepth');
    expect(beat).toHaveProperty('paused');

    vi.advanceTimersByTime(PING_INTERVAL_MS * 3);
    expect(socket.pings).toBe(4);

    socket.emit('close');
  });

  it('sends the heartbeat inside the client staleness tolerance', () => {
    // The UI declares a socket dead after DASHBOARD_STALE_TIMEOUT_MS (60s)
    // of silence. A slower heartbeat would make every healthy connection
    // look dead and reconnect forever.
    expect(PING_INTERVAL_MS * 2).toBeLessThanOrEqual(60_000);
  });

  it('clears the interval when the socket closes', async () => {
    const handler = await captureHandler();
    const socket = fakeSocket();
    const before = vi.getTimerCount();
    handler(socket as unknown as WebSocket);
    expect(vi.getTimerCount()).toBe(before + 1);

    socket.emit('close');

    expect(vi.getTimerCount()).toBe(before);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 5);
    expect(socket.pings).toBe(0);
  });

  it('clears the interval when the socket errors', async () => {
    // An errored socket may never emit 'close', so registering the clear on
    // only the close handler leaks a timer per dropped connection.
    const handler = await captureHandler();
    const socket = fakeSocket();
    const before = vi.getTimerCount();
    handler(socket as unknown as WebSocket);
    expect(vi.getTimerCount()).toBe(before + 1);

    socket.emit('error');

    expect(vi.getTimerCount()).toBe(before);
    vi.advanceTimersByTime(PING_INTERVAL_MS * 5);
    expect(socket.pings).toBe(0);
  });

  it('leaves no timer behind after many connect/disconnect cycles', async () => {
    const handler = await captureHandler();
    const before = vi.getTimerCount();

    for (let i = 0; i < 25; i++) {
      const socket = fakeSocket();
      handler(socket as unknown as WebSocket);
      socket.emit(i % 2 === 0 ? 'close' : 'error');
    }

    expect(vi.getTimerCount()).toBe(before);
  });

  it('skips the heartbeat while the socket is not OPEN', async () => {
    const handler = await captureHandler();
    const socket = fakeSocket();
    handler(socket as unknown as WebSocket);

    socket.readyState = 2; // CLOSING
    vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
    expect(socket.pings).toBe(0);
    expect(socket.sent).toHaveLength(1);

    socket.emit('close');
  });
});
