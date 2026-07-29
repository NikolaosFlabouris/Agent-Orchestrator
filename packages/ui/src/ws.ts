import type {
  DashboardEvent,
  DashboardSnapshot,
  AgentOutputEvent,
  HostPool,
} from '@orchestrator/shared';

type DashboardHandler = (event: DashboardWsEvent) => void;
type OutputHandler = (event: OutputWsEvent) => void;

// The wire contract is owned by `@orchestrator/shared` and emitted by the
// server's single task serializer — the client re-exports it rather than
// re-declaring it, so a server-side change that alters an event payload is
// a compile error here instead of a silent runtime downgrade of the store.
export type { DashboardSnapshot, HostPool };
export type DashboardWsEvent = DashboardEvent;
export type OutputWsEvent = AgentOutputEvent;

/** Health of the dashboard socket as far as the UI is concerned.
 *  `connected` means a socket is open AND has produced traffic inside the
 *  staleness window; anything else is `reconnecting`. */
export type ConnectionState = 'connected' | 'reconnecting';
type StateHandler = (state: ConnectionState) => void;

/** How long the client tolerates total silence before declaring the socket
 *  dead. The server heartbeats every `DASHBOARD_PING_INTERVAL_MS` (25s, see
 *  `packages/server/src/ws/dashboard.ts`), so this is ~2× that plus slack —
 *  long enough that one dropped heartbeat doesn't cause a reconnect storm,
 *  short enough that a silently-dead TCP connection (idle NAT timeout,
 *  suspended laptop, host IP change — none of which fire `onclose`) is
 *  noticed in under a minute instead of never. */
export const DASHBOARD_STALE_TIMEOUT_MS = 60_000;

/** How often the liveness poller checks the clock. Cheap; the resolution
 *  only bounds how late we notice a stale socket. */
const LIVENESS_POLL_MS = 5_000;

/**
 * Dashboard WebSocket connection with exponential backoff reconnection and
 * liveness detection.
 * On connect: receives snapshot → replaces local state.
 * On disconnect: auto-reconnects with backoff (1s, 2s, 4s, 8s, max 30s).
 * On silence past `DASHBOARD_STALE_TIMEOUT_MS`: closes the socket itself so
 * the same backoff path engages.
 *
 * Prefer `subscribeDashboard` — it multiplexes every view onto one socket.
 * This stays exported for tests and for the single owner in `LiveData`.
 */
export function connectDashboardWs(
  handler: DashboardHandler,
  onState?: StateHandler
): () => void {
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let liveness: ReturnType<typeof setInterval> | null = null;
  let lastMessageAt = 0;

  function setState(state: ConnectionState) {
    if (!closed) onState?.(state);
  }

  function stopLiveness() {
    if (liveness !== null) {
      clearInterval(liveness);
      liveness = null;
    }
  }

  function scheduleReconnect() {
    if (closed || timer !== null) return;
    setState('reconnecting');
    timer = setTimeout(() => {
      timer = null;
      backoff = Math.min(backoff * 2, 30000);
      connect();
    }, backoff);
  }

  function connect() {
    if (closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws/dashboard`);
    ws = socket;
    lastMessageAt = Date.now();

    socket.onmessage = (e) => {
      // Any frame counts as proof of life, including the server's periodic
      // status heartbeat — that's what makes silence meaningful below.
      lastMessageAt = Date.now();
      try {
        const event = JSON.parse(e.data);
        handler(event);
      } catch {
        // Invalid JSON
      }
    };

    socket.onopen = () => {
      backoff = 1000; // Reset backoff on successful connect
      lastMessageAt = Date.now();
      setState('connected');
      stopLiveness();
      liveness = setInterval(() => {
        if (Date.now() - lastMessageAt <= DASHBOARD_STALE_TIMEOUT_MS) return;
        // Silent for too long. A half-open TCP connection never fires
        // `onclose`, so nothing would ever restart the backoff loop — close
        // it explicitly. We detach the handlers first and drive the
        // reconnect ourselves rather than waiting on `onclose`, because a
        // close handshake on a dead peer can hang in CLOSING indefinitely.
        stopLiveness();
        ws = null;
        socket.onclose = null;
        socket.onmessage = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          // Already closing/closed — nothing to do.
        }
        scheduleReconnect();
      }, LIVENESS_POLL_MS);
    };

    socket.onclose = () => {
      stopLiveness();
      if (closed) return;
      scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  setState('reconnecting');
  connect();

  // Return cleanup function
  return () => {
    closed = true;
    stopLiveness();
    if (timer) clearTimeout(timer);
    ws?.close();
    ws = null;
  };
}

// ---------------------------------------------------------------------------
// Shared, reference-counted dashboard connection
// ---------------------------------------------------------------------------
//
// Every view that needs live task data subscribes here instead of opening its
// own socket. Previously Dashboard and TaskDetail each called
// `connectDashboardWs`, so navigating between them tore one socket down and
// cold-started another (new snapshot, new slow REST fetch) — and while
// TaskDetail was mounted two sockets were open, both receiving full snapshots
// of every task so one of them could filter for a single id.

const subscribers = new Set<DashboardHandler>();
const stateSubscribers = new Set<StateHandler>();
let sharedDisconnect: (() => void) | null = null;
let sharedState: ConnectionState = 'reconnecting';
let teardownTimer: ReturnType<typeof setTimeout> | null = null;

/** Grace period between the last unsubscribe and actually closing the
 *  socket. React StrictMode mounts effects, tears them down, and mounts them
 *  again synchronously in development; without this the shared socket would
 *  be opened, closed, and reopened on every dev page load. A route change
 *  that swaps which component holds the subscription is covered for free. */
const TEARDOWN_GRACE_MS = 250;

function fanOut(event: DashboardWsEvent) {
  for (const handler of [...subscribers]) handler(event);
}

function fanOutState(state: ConnectionState) {
  sharedState = state;
  for (const handler of [...stateSubscribers]) handler(state);
}

/**
 * Subscribe to the app-wide dashboard stream. The first subscriber opens the
 * socket; the last one to leave closes it (after a short grace period). The
 * returned function unsubscribes.
 *
 * `onState` is invoked immediately with the current connection state so a
 * late subscriber renders the right indicator without waiting for a
 * transition.
 */
export function subscribeDashboard(
  handler: DashboardHandler,
  onState?: StateHandler
): () => void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }

  subscribers.add(handler);
  if (onState) {
    stateSubscribers.add(onState);
    onState(sharedState);
  }

  if (sharedDisconnect === null) {
    sharedDisconnect = connectDashboardWs(fanOut, fanOutState);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscribers.delete(handler);
    if (onState) stateSubscribers.delete(onState);
    if (subscribers.size > 0 || teardownTimer !== null) return;
    teardownTimer = setTimeout(() => {
      teardownTimer = null;
      if (subscribers.size > 0) return;
      sharedDisconnect?.();
      sharedDisconnect = null;
      sharedState = 'reconnecting';
    }, TEARDOWN_GRACE_MS);
  };
}

/** Test-only: drop the shared socket and every subscriber immediately. */
export function _resetSharedDashboard(): void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
  subscribers.clear();
  stateSubscribers.clear();
  sharedDisconnect?.();
  sharedDisconnect = null;
  sharedState = 'reconnecting';
}

/**
 * Agent output WebSocket connection.
 * On connect: receives replay of existing output, then live chunks.
 * On stream_complete: connection may be closed by server.
 */
export function connectOutputWs(
  taskId: number,
  handler: OutputHandler
): () => void {
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(
      `${protocol}//${location.host}/ws/tasks/${taskId}/output`
    );

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handler(event);
      } catch {
        // Invalid JSON
      }
    };

    ws.onopen = () => {
      backoff = 1000;
    };

    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(() => {
        backoff = Math.min(backoff * 2, 30000);
        connect();
      }, backoff);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
