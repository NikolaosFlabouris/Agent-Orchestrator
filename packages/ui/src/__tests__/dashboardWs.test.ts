import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  connectDashboardWs,
  subscribeDashboardWs,
  dashboardConnectionState,
  _resetSharedDashboardWs,
} from '../ws.js';
import type { DashboardWsEvent } from '../ws.js';

/**
 * Liveness + connection sharing for the dashboard socket (issue #148).
 *
 * A silently dead TCP connection (idle NAT timeout, host IP change,
 * suspended laptop) never fires `onclose`, so the backoff reconnect never
 * ran and the client sat on stale data looking perfectly healthy. And a
 * per-view socket meant every Dashboard ↔ TaskDetail navigation tore the
 * connection down and cold-started a new one — with TaskDetail opening a
 * second one alongside it.
 *
 * These run against a fake `WebSocket` that never resolves on its own, so
 * every transition here is one the client drove.
 */

const STALE_TOLERANCE_MS = 1_000;
/** Matches LIVENESS_CHECK_INTERVAL_MS in ws.ts. */
const CHECK_INTERVAL_MS = 5_000;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static get open(): FakeWebSocket[] {
    return FakeWebSocket.instances.filter((ws) => !ws.closed);
  }

  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  closeCalls = 0;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** Server accepted the connection. */
  accept() {
    this.onopen?.();
  }

  /** Server pushed a frame. */
  deliver(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  /** What the browser does when `close()` is called on a live socket. */
  close() {
    this.closeCalls++;
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8080' });
});

afterEach(() => {
  _resetSharedDashboardWs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connectDashboardWs liveness watchdog', () => {
  it('closes a silent socket so the backoff reconnect engages', () => {
    const disconnect = connectDashboardWs(() => {}, {
      staleToleranceMs: STALE_TOLERANCE_MS,
    });
    const first = FakeWebSocket.instances[0];
    first.accept();

    // Nothing arrives. The next liveness check is past the tolerance.
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(first.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    // ...and the existing backoff reconnect (1s) opens a replacement.
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe(
      'ws://localhost:8080/ws/dashboard'
    );

    disconnect();
  });

  it('does not reconnect twice when the retired socket fires onclose late', () => {
    const disconnect = connectDashboardWs(() => {}, {
      staleToleranceMs: STALE_TOLERANCE_MS,
    });
    const first = FakeWebSocket.instances[0];
    first.accept();

    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    // A real browser may deliver the close event well after close() —
    // by then we have already scheduled a reconnect for that socket.
    first.onclose?.();

    // A double-scheduled reconnect would open two replacements here.
    vi.advanceTimersByTime(1_500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    disconnect();
  });

  it('keeps a socket that is receiving the server heartbeat', () => {
    const disconnect = connectDashboardWs(() => {}, {
      staleToleranceMs: STALE_TOLERANCE_MS,
    });
    const socket = FakeWebSocket.instances[0];
    socket.accept();

    // A beat inside every tolerance window keeps the socket alive.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(CHECK_INTERVAL_MS - 500);
      socket.deliver({ type: 'status_changed', paused: false });
      vi.advanceTimersByTime(500);
    }

    expect(socket.closeCalls).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    disconnect();
  });

  it('stops the watchdog on disconnect so no timer survives teardown', () => {
    const disconnect = connectDashboardWs(() => {}, {
      staleToleranceMs: STALE_TOLERANCE_MS,
    });
    FakeWebSocket.instances[0].accept();
    disconnect();

    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reports connection state transitions', () => {
    const states: string[] = [];
    const disconnect = connectDashboardWs(() => {}, {
      staleToleranceMs: STALE_TOLERANCE_MS,
      onState: (s) => states.push(s),
    });
    const first = FakeWebSocket.instances[0];
    first.accept();
    expect(states).toEqual(['connected']);

    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(states).toEqual(['connected', 'reconnecting']);

    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1].accept();
    expect(states).toEqual(['connected', 'reconnecting', 'connected']);

    disconnect();
  });
});

describe('shared dashboard connection', () => {
  it('serves every subscriber from a single socket', () => {
    const seenByA: DashboardWsEvent[] = [];
    const seenByB: DashboardWsEvent[] = [];
    const releaseA = subscribeDashboardWs((e) => seenByA.push(e));
    const releaseB = subscribeDashboardWs((e) => seenByB.push(e));

    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    socket.accept();
    socket.deliver({ type: 'resource_changed', resource: 'profiles' });

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);

    releaseA();
    releaseB();
  });

  it('survives navigation: the app-level subscriber keeps the socket open', () => {
    // GatedLayout's subscription (live.tsx) outlives every route.
    const releaseApp = subscribeDashboardWs(() => {});
    const socket = FakeWebSocket.instances[0];
    socket.accept();

    // Dashboard → TaskDetail → Dashboard.
    const releaseDashboard = subscribeDashboardWs(() => {});
    releaseDashboard();
    const releaseDetail = subscribeDashboardWs(() => {});
    releaseDetail();
    subscribeDashboardWs(() => {});
    vi.advanceTimersByTime(10_000);

    expect(socket.closeCalls).toBe(0);
    expect(FakeWebSocket.open).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    releaseApp();
  });

  it('reuses the live socket when a StrictMode remount lands inside the grace period', () => {
    const release = subscribeDashboardWs(() => {});
    FakeWebSocket.instances[0].accept();

    // StrictMode: effect cleanup then re-run, same tick.
    release();
    const rerelease = subscribeDashboardWs(() => {});
    vi.advanceTimersByTime(10_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].closed).toBe(false);

    rerelease();
  });

  it('closes the socket once the last subscriber is gone for good', () => {
    const release = subscribeDashboardWs(() => {});
    FakeWebSocket.instances[0].accept();

    release();
    expect(FakeWebSocket.instances[0].closed).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a repeated release from the same subscriber', () => {
    const releaseApp = subscribeDashboardWs(() => {});
    const releaseView = subscribeDashboardWs(() => {});
    FakeWebSocket.instances[0].accept();

    releaseView();
    releaseView();
    vi.advanceTimersByTime(10_000);

    expect(FakeWebSocket.instances[0].closed).toBe(false);
    releaseApp();
  });

  it('publishes liveness to every state listener and to late subscribers', () => {
    const states: string[] = [];
    const releaseApp = subscribeDashboardWs(() => {}, {
      onState: (s) => states.push(s),
    });
    FakeWebSocket.instances[0].accept();
    expect(states).toEqual(['connected']);
    expect(dashboardConnectionState()).toBe('connected');

    const lateStates: string[] = [];
    const releaseView = subscribeDashboardWs(() => {}, {
      onState: (s) => lateStates.push(s),
    });
    expect(lateStates).toEqual(['connected']);

    // Socket dies → both listeners hear it.
    FakeWebSocket.instances[0].close();
    expect(states).toEqual(['connected', 'reconnecting']);
    expect(lateStates).toEqual(['connected', 'reconnecting']);
    expect(dashboardConnectionState()).toBe('reconnecting');

    releaseView();
    releaseApp();
  });
});
