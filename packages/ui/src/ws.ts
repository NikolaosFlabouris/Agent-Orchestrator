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

/** Reported liveness of the dashboard feed. `reconnecting` covers every
 *  not-currently-receiving state (initial connect, backoff wait, declared
 *  stale) — the operator only needs to know whether what they're looking
 *  at is live. */
export type DashboardConnectionState = 'connected' | 'reconnecting';

/** How long a socket may stay silent before we declare it dead. The
 *  server pings every DASHBOARD_PING_INTERVAL_MS (25s — see
 *  `packages/server/src/ws/dashboard.ts`), so this tolerates two missed
 *  beats before acting. */
export const DASHBOARD_STALE_TOLERANCE_MS = 60_000;

/** Cadence of the client-side staleness check. Cheap (one timestamp
 *  comparison), and finer than the tolerance so detection latency is
 *  bounded by this rather than by the tolerance itself. */
const LIVENESS_CHECK_INTERVAL_MS = 5_000;

export interface DashboardWsOptions {
  /** Called on every liveness transition, and once on the first
   *  successful open. */
  onState?: (state: DashboardConnectionState) => void;
  /** Override for tests. Defaults to DASHBOARD_STALE_TOLERANCE_MS. */
  staleToleranceMs?: number;
}

/**
 * Dashboard WebSocket connection with exponential backoff reconnection.
 * On connect: receives snapshot → replaces local state.
 * On disconnect: auto-reconnects with backoff (1s, 2s, 4s, 8s, max 30s).
 *
 * Liveness: a TCP connection can die silently (idle NAT timeout, host IP
 * change, suspended laptop) without ever firing `onclose`, which used to
 * leave the client sitting on stale data while looking healthy. We track
 * the last received message and, once nothing has arrived for
 * `staleToleranceMs`, close the socket ourselves so the backoff reconnect
 * below engages. Browsers can't observe WebSocket pong frames, so the
 * server's heartbeat is an application-level frame the tracker can see.
 *
 * Prefer `subscribeDashboardWs` in app code — it shares one socket across
 * routes. This function stays exported for tests and for the singleton.
 */
export function connectDashboardWs(
  handler: DashboardHandler,
  options: DashboardWsOptions = {}
): () => void {
  const staleToleranceMs =
    options.staleToleranceMs ?? DASHBOARD_STALE_TOLERANCE_MS;
  let ws: WebSocket | null = null;
  let backoff = 1000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let liveness: ReturnType<typeof setInterval> | null = null;
  let lastMessageAt = Date.now();
  // Bumped on every connect attempt and whenever the watchdog retires a
  // socket, so a late `onclose` from a socket we already gave up on can't
  // schedule a second reconnect.
  let generation = 0;

  function stopLiveness() {
    if (liveness !== null) {
      clearInterval(liveness);
      liveness = null;
    }
  }

  function scheduleReconnect() {
    stopLiveness();
    options.onState?.('reconnecting');
    timer = setTimeout(() => {
      backoff = Math.min(backoff * 2, 30000);
      connect();
    }, backoff);
  }

  function connect() {
    if (closed) return;
    const generationAtConnect = ++generation;
    lastMessageAt = Date.now();

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/dashboard`);

    ws.onmessage = (e) => {
      lastMessageAt = Date.now();
      try {
        const event = JSON.parse(e.data);
        handler(event);
      } catch {
        // Invalid JSON
      }
    };

    ws.onopen = () => {
      backoff = 1000; // Reset backoff on successful connect
      lastMessageAt = Date.now();
      options.onState?.('connected');
    };

    ws.onclose = () => {
      if (closed || generationAtConnect !== generation) return;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };

    stopLiveness();
    liveness = setInterval(() => {
      if (Date.now() - lastMessageAt <= staleToleranceMs) return;
      // Silent for two-plus heartbeats: the socket is dead even though
      // the browser still reports it open. Retire it (bumping the
      // generation so its eventual onclose is ignored) and reconnect
      // through the normal backoff path.
      const dead = ws;
      ws = null;
      generation++;
      scheduleReconnect();
      dead?.close();
    }, LIVENESS_CHECK_INTERVAL_MS);
  }

  connect();

  // Return cleanup function
  return () => {
    closed = true;
    stopLiveness();
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

// ---------------------------------------------------------------------------
// Shared dashboard connection (module-level singleton, reference-counted)
// ---------------------------------------------------------------------------
//
// Dashboard and TaskDetail are sibling routes, so a per-view socket meant
// every navigation tore the connection down and cold-started a new one
// (new socket, new snapshot), and TaskDetail opened a *second* socket
// receiving full snapshots of every task just to filter for one id. One
// socket is owned here instead and handed to every subscriber; the app
// mounts a single long-lived subscriber (`live.tsx`, under GatedLayout) so
// the store stays live regardless of which route is rendered.

const sharedHandlers = new Set<DashboardHandler>();
const sharedStateListeners = new Set<
  (state: DashboardConnectionState) => void
>();
let sharedDisconnect: (() => void) | null = null;
let sharedRefs = 0;
let sharedState: DashboardConnectionState = 'reconnecting';
let sharedTeardownTimer: ReturnType<typeof setTimeout> | null = null;

/** Grace period between the last unsubscribe and actually closing the
 *  socket. React StrictMode double-mounts effects in development
 *  (unmount → remount in the same tick), and route transitions unmount
 *  the old tree before mounting the new one; without the grace either
 *  would churn the socket. Long enough to absorb both, short enough that
 *  a genuine teardown doesn't linger. */
const SHARED_TEARDOWN_GRACE_MS = 250;

/** Current liveness of the shared socket. Exposed for the initial render
 *  of a subscriber that mounts while a connection already exists. */
export function dashboardConnectionState(): DashboardConnectionState {
  return sharedState;
}

/** Record a liveness transition and fan it out to every subscriber.
 *
 *  Edge-triggered: a repeat of the current state is dropped rather than
 *  re-published. Each backoff attempt reports `reconnecting` again, and
 *  the store setter feeding the header indicator would otherwise write —
 *  and re-render — once per attempt for a state that never changed. */
function publishSharedState(state: DashboardConnectionState): void {
  if (state === sharedState) return;
  sharedState = state;
  // Copy: a listener may unsubscribe while we're dispatching.
  for (const listener of [...sharedStateListeners]) listener(state);
}

/**
 * Subscribe to the shared dashboard socket, opening it on the first
 * subscriber and closing it (after a short grace period) when the last
 * one goes away. Returns an idempotent unsubscribe.
 */
export function subscribeDashboardWs(
  handler: DashboardHandler,
  options: { onState?: (state: DashboardConnectionState) => void } = {}
): () => void {
  // Wrap both callbacks so each subscription owns a unique Set entry —
  // two subscribers that happen to pass the same function identity must
  // not have one's release remove the other's registration.
  const dispatch: DashboardHandler = (event) => handler(event);
  const onState = options.onState;
  const publish = onState
    ? (state: DashboardConnectionState) => onState(state)
    : null;

  sharedHandlers.add(dispatch);
  if (publish) sharedStateListeners.add(publish);
  sharedRefs++;

  if (sharedTeardownTimer !== null) {
    clearTimeout(sharedTeardownTimer);
    sharedTeardownTimer = null;
  }

  if (sharedDisconnect === null) {
    publishSharedState('reconnecting');
    sharedDisconnect = connectDashboardWs(
      (event) => {
        // Copy first: a handler may unsubscribe (or subscribe) while we
        // are dispatching.
        for (const h of [...sharedHandlers]) h(event);
      },
      { onState: publishSharedState }
    );
  } else {
    // Late subscriber: hand it the current state so its UI doesn't sit on
    // the default until the next transition.
    publish?.(sharedState);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    sharedHandlers.delete(dispatch);
    if (publish) sharedStateListeners.delete(publish);
    sharedRefs--;
    if (sharedRefs > 0) return;

    sharedTeardownTimer = setTimeout(() => {
      sharedTeardownTimer = null;
      if (sharedRefs > 0) return;
      sharedDisconnect?.();
      sharedDisconnect = null;
      sharedState = 'reconnecting';
    }, SHARED_TEARDOWN_GRACE_MS);
  };
}

/** Test-only reset of the singleton's module state. */
export function _resetSharedDashboardWs(): void {
  if (sharedTeardownTimer !== null) {
    clearTimeout(sharedTeardownTimer);
    sharedTeardownTimer = null;
  }
  sharedDisconnect?.();
  sharedDisconnect = null;
  sharedHandlers.clear();
  sharedStateListeners.clear();
  sharedRefs = 0;
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
