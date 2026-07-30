import { create } from 'zustand';
import type { AuthUser, TaskResponse, AgentProfileResponse } from './api.js';
import type { DashboardConnectionState, HostPool } from './ws.js';

interface Alert {
  level: 'info' | 'warning' | 'error';
  message: string;
}

/** Monotonic per-resource counter the server bumps via the WS
 *  `resource_changed` event. Components that hold a cached view of one
 *  of these resources (Settings tabs, the Dashboard's profile lookup)
 *  add the relevant version to their useEffect deps and refetch when
 *  it ticks. Cheaper than re-broadcasting full payloads from the WS. */
export interface ResourceVersions {
  providers: number;
  models: number;
  profiles: number;
}

/** Statuses `GET /api/tasks` is guaranteed to return in full.
 *
 *  The route buckets its response into active / queued / completed and
 *  truncates ONLY the completed bucket via `?limit` (default 20 — see
 *  `packages/server/src/routes/tasks.ts`). So a local row in one of these
 *  statuses that the response omits genuinely no longer holds that status
 *  on the server and is safe to prune; a missing *completed* row may well
 *  be a row the server intentionally left out. */
const PRUNABLE_STATUSES = new Set([
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
  'queued',
]);

/** Replace the row with the same id, or append it when unseen.
 *
 *  Insert-on-miss matters: `task_created` can be missed (dropped socket,
 *  a creation path that forgot to broadcast), and the periodic REST
 *  refresh is the only thing that heals that. A map-only update silently
 *  dropped such rows until the operator reloaded the page. */
function upsert(tasks: TaskResponse[], task: TaskResponse): TaskResponse[] {
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index === -1) return [...tasks, task];
  const next = tasks.slice();
  next[index] = task;
  return next;
}

interface DashboardState {
  tasks: TaskResponse[];
  agentProfiles: AgentProfileResponse[];
  hostPool: HostPool;
  queueDepth: number;
  paused: boolean;
  forgejoBaseUrl: string;
  alerts: Alert[];
  resourceVersions: ResourceVersions;
  /** Liveness of the shared dashboard WebSocket, owned by the
   *  app-level connection in `live.tsx` and rendered as the AppHeader
   *  indicator so a dead feed is visible on every view. */
  connection: DashboardConnectionState;
  /** Signed-in Forgejo user, captured once at startup by the AuthGate
   *  via GET /api/me. Null when auth is disabled or the userinfo
   *  lookup failed at login. */
  user: AuthUser | null;

  // Actions
  setSnapshot: (data: {
    tasks: TaskResponse[];
    hostPool: HostPool;
    queueDepth: number;
    paused: boolean;
  }) => void;
  updateTask: (task: TaskResponse) => void;
  addTask: (task: TaskResponse) => void;
  removeTask: (taskId: number) => void;
  syncTasks: (tasks: TaskResponse[]) => void;
  setConnection: (state: DashboardConnectionState) => void;
  setStatus: (data: {
    paused: boolean;
    hostPool: HostPool;
    queueDepth: number;
  }) => void;
  setHostPool: (hostPool: HostPool) => void;
  setForgejoBaseUrl: (url: string) => void;
  addAlert: (alert: Alert) => void;
  clearAlerts: () => void;
  setAgentProfiles: (profiles: AgentProfileResponse[]) => void;
  setUser: (user: AuthUser | null) => void;
  /** Bump the version counter for one resource. Called by the WS
   *  handler in Dashboard when a `resource_changed` event arrives. */
  bumpResourceVersion: (resource: keyof ResourceVersions) => void;
}

const ZERO_POOL: HostPool = {
  memory_used_mb: 0,
  memory_total_mb: 0,
  cpu_used_cores: 0,
  cpu_total_cores: 0,
};

export const useStore = create<DashboardState>((set) => ({
  tasks: [],
  agentProfiles: [],
  hostPool: ZERO_POOL,
  queueDepth: 0,
  paused: false,
  forgejoBaseUrl: '',
  alerts: [],
  resourceVersions: { providers: 0, models: 0, profiles: 0 },
  connection: 'reconnecting',
  user: null,

  setSnapshot: (data) =>
    set({
      tasks: data.tasks,
      hostPool: data.hostPool,
      queueDepth: data.queueDepth,
      paused: data.paused,
    }),

  updateTask: (task) => set((state) => ({ tasks: upsert(state.tasks, task) })),

  // Same upsert as updateTask: a `task_created` for a row the snapshot
  // already carried (or a re-delivered event) must not duplicate it.
  addTask: (task) => set((state) => ({ tasks: upsert(state.tasks, task) })),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  /** Reconcile local rows against a full-list `GET /api/tasks` response.
   *
   *  Upserts every returned row, then prunes local rows the response
   *  omitted — but only those whose LOCAL status is in
   *  `PRUNABLE_STATUSES`, i.e. the buckets the route always returns
   *  whole. Pruning a missing completed row instead would delete the
   *  older history the `?limit` truncation deliberately withholds.
   *
   *  Consequence worth knowing: a task that finished between two
   *  refreshes while the completed bucket is already at `limit` is
   *  pruned (it left the active bucket and the truncation hid its new
   *  home). That's a terminal row, the full history lives on Reports,
   *  and the next reconnect snapshot — which is never truncated —
   *  brings it back.
   *
   *  Not used for WS snapshots: those replace task state wholesale via
   *  `setSnapshot` (docs/06-web-ui.md). */
  syncTasks: (tasks) =>
    set((state) => {
      const incoming = new Map(tasks.map((t) => [t.id, t]));
      const merged: TaskResponse[] = [];
      for (const local of state.tasks) {
        const fresh = incoming.get(local.id);
        if (fresh) {
          merged.push(fresh);
          incoming.delete(local.id);
        } else if (!PRUNABLE_STATUSES.has(local.status)) {
          merged.push(local);
        }
      }
      // Whatever is left is new to us — appending heals a missed
      // `task_created` without waiting for a reconnect snapshot.
      for (const fresh of incoming.values()) merged.push(fresh);
      return { tasks: merged };
    }),

  setConnection: (connection) => set({ connection }),

  setStatus: (data) =>
    set({
      paused: data.paused,
      hostPool: data.hostPool,
      queueDepth: data.queueDepth,
    }),

  setHostPool: (hostPool) => set({ hostPool }),
  setForgejoBaseUrl: (url) => set({ forgejoBaseUrl: url }),

  addAlert: (alert) =>
    set((state) => ({ alerts: [...state.alerts, alert] })),

  clearAlerts: () => set({ alerts: [] }),

  setAgentProfiles: (profiles) => set({ agentProfiles: profiles }),

  setUser: (user) => set({ user }),

  bumpResourceVersion: (resource) => {
    // Debounce per-resource (L): coalesce a burst of rapid mutations
    // into one bump so an operator seeding multiple models, or two
    // tabs racing on the same resource, doesn't trigger N parallel
    // refetches across K open Settings tabs. 50ms is short enough to
    // feel instant for a single mutation and long enough to absorb a
    // typical burst.
    const existing = pendingBumps.get(resource);
    if (existing) clearTimeout(existing);
    pendingBumps.set(
      resource,
      setTimeout(() => {
        pendingBumps.delete(resource);
        useStore.setState((state) => ({
          resourceVersions: {
            ...state.resourceVersions,
            [resource]: state.resourceVersions[resource] + 1,
          },
        }));
      }, BUMP_DEBOUNCE_MS)
    );
  },
}));

const BUMP_DEBOUNCE_MS = 50;
// Per-resource pending-bump timers. Module-scope (not store-scope)
// because the values are Node/browser timer handles, not part of the
// observable React state. Keying by resource means a bump for
// `providers` doesn't reset a debounce on `profiles`.
const pendingBumps = new Map<
  keyof ResourceVersions,
  ReturnType<typeof setTimeout>
>();
