import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getTasks, getQueuedTasks, getSettingInt } from '../db.js';
import { getActiveResources } from '../queue.js';
import { buildTaskView, loadProfileDefaults } from '../task-view.js';
import type {
  DashboardSnapshot,
  DashboardEvent,
  HostPool,
  StatusChangedEvent,
} from '@orchestrator/shared';

const clients = new Set<WebSocket>();

/** Source of the live `paused` flag for the WS snapshot. Wired up at
 *  registration time so the snapshot reflects the scheduler's real
 *  state — previously this was hardcoded to `false`, which left every
 *  newly-connecting dashboard showing "Running" until the periodic
 *  REST poll completed even when the scheduler was paused. (F1) */
let getPausedState: () => boolean = () => false;

/** Factory wrapping the Fastify plugin so we can inject the scheduler's
 *  isPaused() getter without making the plugin depend on the full
 *  Scheduler class. Mirrors the pattern used by `createTaskRoutes` /
 *  `createStatusRoutes` etc. */
export function createDashboardWs(opts: {
  isPaused: () => boolean;
}): (app: FastifyInstance) => Promise<void> {
  getPausedState = opts.isPaused;
  return dashboardWs;
}

/** Heartbeat cadence. Two purposes:
 *
 *  1. A protocol-level ping keeps idle NAT/proxy paths from silently
 *     dropping a connection that legitimately has nothing to say for
 *     minutes at a time, and gives the server a dead-peer signal.
 *  2. Browsers cannot observe pong frames from JS, so the same tick also
 *     sends an application-level frame. That is what lets the client's
 *     staleness watchdog (`packages/ui/src/ws.ts`) distinguish "quiet" from
 *     "dead" and reconnect. No new event type: we reuse `status_changed`,
 *     whose payload is exactly the periodically-refreshed state a
 *     reconnect-less client would otherwise be missing.
 *
 *  The client tolerates roughly two missed beats before reconnecting, so
 *  keep this comfortably under half DASHBOARD_STALE_TOLERANCE_MS. */
const PING_INTERVAL_MS = 25_000;

export async function dashboardWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/dashboard', { websocket: true }, (socket) => {
    clients.add(socket);

    // Send initial snapshot
    const snapshot = buildSnapshot();
    socket.send(JSON.stringify(snapshot));

    // Per-socket heartbeat. `pongSeen` starts true so the first tick never
    // terminates a socket that simply hasn't been pinged yet.
    let pongSeen = true;
    socket.on('pong', () => {
      pongSeen = true;
    });

    const heartbeat = setInterval(() => {
      if (!pongSeen) {
        // Two consecutive ticks with no pong: the peer is gone but the
        // TCP connection never closed. Terminate so `close` fires, the
        // client leaves `clients`, and this interval is cleared below.
        socket.terminate();
        return;
      }
      pongSeen = false;
      try {
        socket.ping();
        socket.send(JSON.stringify(buildStatusChanged()));
      } catch {
        // Send failed on a socket the runtime hasn't closed yet — let the
        // pong check above (or the close handler) clean it up.
      }
    }, PING_INTERVAL_MS);

    // Both handlers must clear the interval: on a long-lived server, a
    // socket that errors without a clean close would otherwise leak a
    // timer (and a `clients` entry) per connection, forever.
    const cleanup = () => {
      clearInterval(heartbeat);
      clients.delete(socket);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
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

/** Convenience: notify dashboard clients that a config resource changed.
 *  Settings tabs and the Dashboard's profile cache subscribe to this
 *  and refetch the affected resource. Cheap (no payload) so it's safe
 *  to call from every CRUD route after a successful mutation. */
export function broadcastResourceChanged(
  resource: 'providers' | 'models' | 'profiles'
): void {
  broadcastDashboardEvent({ type: 'resource_changed', resource });
}

/** Snapshot of the host resource pool — used by snapshot + status_changed
 *  events. Pulled from the same source the scheduler gates against, so
 *  the dashboard never disagrees with the scheduler's view. */
export function buildHostPool(): HostPool {
  const used = getActiveResources();
  return {
    memory_used_mb: used.memoryMb,
    memory_total_mb: getSettingInt('max_agent_memory_mb'),
    cpu_used_cores: used.cpuCores,
    cpu_total_cores: getSettingInt('max_agent_cpu_cores'),
  };
}

/** Initial payload for a newly-connected dashboard. Tasks carry the same
 *  enriched `TaskView` `GET /api/tasks` returns — the client store replaces
 *  rows wholesale from these events, so anything less downgrades them.
 *  Synchronous by construction: `buildTaskView` reads SQLite plus the
 *  snapshot cache and never touches Forgejo or Docker. Exported for tests. */
export function buildSnapshot(): DashboardSnapshot {
  const defaults = loadProfileDefaults();
  return {
    type: 'snapshot',
    tasks: getTasks().map((task) => buildTaskView(task, { defaults })),
    hostPool: buildHostPool(),
    queueDepth: getQueuedTasks().length,
    paused: getPausedState(),
  };
}

/** Convenience wrapper for the pause/resume route handlers. Builds the
 *  full StatusChangedEvent payload (paused + hostPool + queueDepth) so
 *  connected dashboards don't have to issue a follow-up REST poll to
 *  see a freshly-paused / resumed scheduler. Without this, the pause
 *  state only propagated when each client's 5-second status poll
 *  cycled. (F2) */
export function broadcastStatusChanged(paused: boolean): void {
  broadcastDashboardEvent(buildStatusChanged(paused));
}

/** The `status_changed` payload. Shared by the pause/resume broadcast and
 *  the per-socket heartbeat — synchronous and cheap (one resource read,
 *  two settings reads, one queue count), so building it per beat is fine
 *  for the handful of dashboards a deployment has open. */
function buildStatusChanged(paused = getPausedState()): StatusChangedEvent {
  return {
    type: 'status_changed',
    paused,
    hostPool: buildHostPool(),
    queueDepth: getQueuedTasks().length,
  };
}
