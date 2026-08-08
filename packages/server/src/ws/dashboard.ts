import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getTasks, getQueuedTasks, getSettingInt } from '../db.js';
import { getActiveResources } from '../queue.js';
import {
  buildTaskView,
  loadProfileDefaults,
  loadTaskViewBatches,
} from '../task-view.js';
import type {
  DashboardSnapshot,
  DashboardEvent,
  HostPool,
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

/** Heartbeat cadence. Two jobs:
 *
 *  1. A protocol-level ping keeps middleboxes (NAT tables, reverse proxies
 *     with idle timeouts) from silently dropping an otherwise-idle socket.
 *  2. The accompanying `status_changed` frame is what the CLIENT measures
 *     silence against — a browser never surfaces an incoming ping frame to
 *     JavaScript, so a ping alone cannot prove liveness to the UI. Reusing
 *     the existing event (rather than inventing a heartbeat type) keeps the
 *     `DashboardEvent` union unchanged and doubles as a periodic status
 *     resync; the client's `setStatus` is idempotent.
 *
 *  Keep in step with `DASHBOARD_STALE_TIMEOUT_MS` in `packages/ui/src/ws.ts`,
 *  which must stay at roughly twice this value. */
const PING_INTERVAL_MS = 25_000;

/** `ws` readyState for OPEN. Hardcoded rather than read off the socket so a
 *  mock in tests doesn't have to carry the constant. */
const WS_OPEN = 1;

export async function dashboardWs(app: FastifyInstance): Promise<void> {
  app.get('/ws/dashboard', { websocket: true }, (socket) => {
    clients.add(socket);

    // Send initial snapshot
    const snapshot = buildSnapshot();
    socket.send(JSON.stringify(snapshot));

    const heartbeat = setInterval(() => {
      if (socket.readyState !== WS_OPEN) return;
      try {
        socket.ping();
        socket.send(
          JSON.stringify({
            type: 'status_changed',
            paused: getPausedState(),
            hostPool: buildHostPool(),
            queueDepth: getQueuedTasks().length,
          } satisfies DashboardEvent)
        );
      } catch {
        // Socket died between the readyState check and the write. The
        // close/error handler below performs the cleanup.
      }
    }, PING_INTERVAL_MS);
    // Never hold the process open for a heartbeat alone.
    heartbeat.unref?.();

    // One cleanup for both terminal paths — an errored socket may never emit
    // 'close', so registering the clear on only one of them leaks a timer per
    // dropped connection for the life of the process.
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
  // One batch query each for running attempts and repos — enriching N
  // tasks must not issue per-task attempt-history reads on every connect.
  const batches = loadTaskViewBatches();
  return {
    type: 'snapshot',
    tasks: getTasks().map((task) =>
      buildTaskView(task, { defaults, ...batches })
    ),
    hostPool: buildHostPool(),
    queueDepth: getQueuedTasks().length,
    paused: getPausedState(),
  };
}

/** Convenience wrapper for the pause/resume route handlers. Builds the
 *  full StatusChangedEvent payload (paused + hostPool + queueDepth) so
 *  connected dashboards don't have to issue a follow-up REST poll to
 *  see a freshly-paused / resumed scheduler. Without this, the pause
 *  state only propagated when each client's status poll cycled. (F2)
 *
 *  Also called by the scheduler on a slot acquire/release, which is why
 *  that poll could be slowed to a backstop cadence — see
 *  `notifySlotTransition` in scheduler.ts. */
export function broadcastStatusChanged(paused: boolean): void {
  broadcastDashboardEvent({
    type: 'status_changed',
    paused,
    hostPool: buildHostPool(),
    queueDepth: getQueuedTasks().length,
  });
}
