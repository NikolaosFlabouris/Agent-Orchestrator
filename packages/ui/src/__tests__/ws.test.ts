/**
 * Dashboard WebSocket: liveness detection and the shared, reference-counted
 * connection.
 *
 * The two failure modes under test:
 *  - A silently dead TCP connection (idle NAT timeout, suspended laptop,
 *    host IP change) never fires `onclose`, so the backoff reconnect never
 *    ran and the client sat on stale data looking perfectly healthy.
 *  - Every view opened its own socket, so navigating Dashboard → TaskDetail
 *    → Dashboard tore one down and cold-started another.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectDashboardWs,
  subscribeDashboard,
  _resetSharedDashboard,
  DASHBOARD_STALE_TIMEOUT_MS,
} from '../ws.js';
import type { ConnectionState, DashboardWsEvent } from '../ws.js';

/** Stand-in for the browser WebSocket. Records every instance so a test can
 *  assert how many sockets were opened and drive their callbacks by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  static get open(): FakeWebSocket[] {
    return FakeWebSocket.instances.filter((s) => s.readyState !== 3);
  }

  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  closeCount = 0;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** Simulate the server accepting the connection. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Simulate an inbound frame. */
  deliver(event: DashboardWsEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.();
  }
}

const snapshot = (): DashboardWsEvent => ({
  type: 'snapshot',
  tasks: [],
  hostPool: {
    memory_used_mb: 0,
    memory_total_mb: 0,
    cpu_used_cores: 0,
    cpu_total_cores: 0,
  },
  queueDepth: 0,
  paused: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).location = { protocol: 'http:', host: 'localhost:8080' };
});

afterEach(() => {
  _resetSharedDashboard();
  vi.useRealTimers();
  delete (globalThis as any).WebSocket;
  delete (globalThis as any).location;
});

describe('connectDashboardWs liveness', () => {
  it('closes a silent socket once the staleness tolerance elapses', () => {
    const disconnect = connectDashboardWs(() => {});
    const socket = FakeWebSocket.instances[0];
    socket.accept();

    // Just inside the tolerance: still trusted.
    vi.advanceTimersByTime(DASHBOARD_STALE_TIMEOUT_MS - 1_000);
    expect(socket.closeCount).toBe(0);

    // Past it with no traffic at all — the server heartbeats far more often
    // than this, so silence means the connection is dead.
    vi.advanceTimersByTime(10_000);
    expect(socket.closeCount).toBe(1);

    disconnect();
  });

  it('reconnects after closing a stale socket', () => {
    const disconnect = connectDashboardWs(() => {});
    FakeWebSocket.instances[0].accept();

    // The liveness poller notices on its first check past the tolerance.
    vi.advanceTimersByTime(DASHBOARD_STALE_TIMEOUT_MS + 5_000);
    expect(FakeWebSocket.instances[0].closeCount).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Backoff starts at 1s.
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    disconnect();
  });

  it('does not close a socket that keeps receiving traffic', () => {
    const disconnect = connectDashboardWs(() => {});
    const socket = FakeWebSocket.instances[0];
    socket.accept();

    // Server heartbeat cadence is 25s; four beats span more than two
    // tolerance windows.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(25_000);
      socket.deliver(snapshot());
    }

    expect(socket.closeCount).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    disconnect();
  });

  it('reports connection state transitions', () => {
    const states: ConnectionState[] = [];
    const disconnect = connectDashboardWs(
      () => {},
      (s) => states.push(s)
    );

    // Nothing is live until the socket opens.
    expect(states).toEqual(['reconnecting']);

    FakeWebSocket.instances[0].accept();
    expect(states).toEqual(['reconnecting', 'connected']);

    vi.advanceTimersByTime(DASHBOARD_STALE_TIMEOUT_MS + 10_000);
    expect(states).toEqual(['reconnecting', 'connected', 'reconnecting']);

    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1].accept();
    expect(states).toEqual([
      'reconnecting',
      'connected',
      'reconnecting',
      'connected',
    ]);

    disconnect();
  });

  it('stops the liveness timer after disconnect', () => {
    const disconnect = connectDashboardWs(() => {});
    FakeWebSocket.instances[0].accept();
    disconnect();

    vi.advanceTimersByTime(10 * DASHBOARD_STALE_TIMEOUT_MS);

    // No reconnect and no second close attempt after teardown.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closeCount).toBe(1);
  });
});

describe('subscribeDashboard', () => {
  it('opens exactly one socket no matter how many views subscribe', () => {
    const a = subscribeDashboard(() => {});
    const b = subscribeDashboard(() => {});
    const c = subscribeDashboard(() => {});

    expect(FakeWebSocket.open).toHaveLength(1);

    a();
    b();
    c();
  });

  it('fans one frame out to every subscriber', () => {
    const seen: string[] = [];
    const a = subscribeDashboard((e) => seen.push(`a:${e.type}`));
    const b = subscribeDashboard((e) => seen.push(`b:${e.type}`));

    const socket = FakeWebSocket.instances[0];
    socket.accept();
    socket.deliver(snapshot());

    expect(seen).toEqual(['a:snapshot', 'b:snapshot']);

    a();
    b();
  });

  it('survives Dashboard → TaskDetail → Dashboard navigation', () => {
    // The app-level owner (LiveData in GatedLayout) never unsubscribes.
    const appOwner = subscribeDashboard(() => {});
    const socket = FakeWebSocket.instances[0];
    socket.accept();

    // Route change: Dashboard unmounts, TaskDetail mounts and subscribes.
    const detail = subscribeDashboard(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Back to the Dashboard: TaskDetail unmounts.
    detail();
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.closeCount).toBe(0);

    appOwner();
  });

  it('tolerates a StrictMode subscribe/unsubscribe/subscribe cycle', () => {
    // React 19 development mode mounts effects, tears them down, and mounts
    // them again. The shared socket must not be closed and reopened, nor
    // left orphaned.
    const first = subscribeDashboard(() => {});
    first();
    const second = subscribeDashboard(() => {});

    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closeCount).toBe(0);

    second();
  });

  it('closes the socket once the last subscriber leaves', () => {
    const release = subscribeDashboard(() => {});
    FakeWebSocket.instances[0].accept();

    release();
    // Grace period first — the socket is still up for a StrictMode remount.
    expect(FakeWebSocket.instances[0].closeCount).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances[0].closeCount).toBe(1);
  });

  it('is idempotent when the same release function runs twice', () => {
    const owner = subscribeDashboard(() => {});
    const release = subscribeDashboard(() => {});

    release();
    release();
    vi.advanceTimersByTime(1_000);

    // The app owner is still subscribed, so nothing was torn down.
    expect(FakeWebSocket.open).toHaveLength(1);
    owner();
  });

  it('replays the current connection state to a late subscriber', () => {
    const owner = subscribeDashboard(() => {});
    FakeWebSocket.instances[0].accept();

    const states: ConnectionState[] = [];
    const late = subscribeDashboard(
      () => {},
      (s) => states.push(s)
    );
    expect(states).toEqual(['connected']);

    late();
    owner();
  });
});
