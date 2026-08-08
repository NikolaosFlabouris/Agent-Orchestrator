import { create } from 'zustand';
import type { AuthUser, TaskResponse, AgentProfileResponse } from './api.js';
import type { ConnectionState, HostPool } from './ws.js';
import type { OrchestratorAlert } from '@orchestrator/shared';

/** Statuses the orchestrator treats as "an agent is working on it". Shared
 *  between the Dashboard's bucketing and `completedCount` below so the two
 *  can never disagree about what counts as active. Mirrors
 *  `ACTIVE_STATUSES` in `packages/server/src/routes/tasks.ts`. */
export const ACTIVE_STATUSES = new Set([
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
]);

/** Size of the completed bucket in a `GET /api/tasks` response, using the
 *  same split the server's handler applies (active / queued / completed).
 *  `syncTasks` compares this against the requested `limit` to tell a
 *  complete response from a truncated one. */
function completedCount(tasks: TaskResponse[]): number {
  let count = 0;
  for (const t of tasks) {
    if (!ACTIVE_STATUSES.has(t.status) && t.status !== 'queued') count += 1;
  }
  return count;
}

/** Fold a fresh `GET /api/status/alerts` response into the store's alert
 *  state. Exported as a pure function because the dismiss/re-fire rule below
 *  is the only genuinely non-obvious thing about this slice, and it is worth
 *  testing without a store or a DOM.
 *
 *  REPLACE, not merge: the endpoint recomputes the entire active set on every
 *  call, so an alert missing from `incoming` means its condition has cleared,
 *  not that the response was partial. There is no equivalent of `syncTasks`'
 *  truncation problem here — the response is never capped.
 *
 *  Dismissal is client-only and deliberately not sticky forever. An id is
 *  kept in the dismissed set only while the server still reports it; once the
 *  condition clears, the id is forgotten, so the same condition re-firing
 *  later (the same task gets stuck again, the git host drops out a second
 *  time) shows up again instead of being silently swallowed by a dismissal
 *  the operator made hours ago about a different incident.
 *
 *  Returns the inputs THEMSELVES when nothing they hold has changed — this
 *  runs on a 60s poll whose result is usually identical, and handing back
 *  fresh objects every tick would re-render `AlertBanner` (and every other
 *  subscriber of these slices) for nothing. Same reasoning as the write
 *  guard in `setConnection` below.
 *
 *  Never mutates its arguments. */
export function mergeAlerts(
  prev: OrchestratorAlert[],
  incoming: OrchestratorAlert[],
  dismissed: Set<string>
): { alerts: OrchestratorAlert[]; dismissedAlertIds: Set<string> } {
  const incomingIds = new Set(incoming.map((a) => a.id));
  const nextDismissed = new Set<string>();
  for (const id of dismissed) {
    if (incomingIds.has(id)) nextDismissed.add(id);
  }
  const visible = incoming.filter((a) => !nextDismissed.has(a.id));

  // Compare on the fields that are actually rendered: an alert's message
  // carries live numbers (elapsed minutes, retry level), so identity has to
  // be by value, not by id alone.
  const unchanged =
    visible.length === prev.length &&
    visible.every((a, i) => {
      const b = prev[i];
      return (
        b !== undefined &&
        a.id === b.id &&
        a.level === b.level &&
        a.message === b.message &&
        a.task_id === b.task_id
      );
    });

  return {
    alerts: unchanged ? prev : visible,
    // `nextDismissed` is built by filtering `dismissed`, so equal sizes
    // means equal contents.
    dismissedAlertIds:
      nextDismissed.size === dismissed.size ? dismissed : nextDismissed,
  };
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

export interface SyncTasksOptions {
  /** The `limit` that was sent with the request. Supplying it lets
   *  `syncTasks` tell a complete response from one whose completed bucket
   *  the server truncated; only a complete response may prune. */
  completedLimit?: number;
  /** Ids the caller already held when it issued the request. Rows that
   *  appeared afterwards (a `task_created` racing the fetch) are never
   *  pruned by a response that predates them. */
  knownIds?: ReadonlySet<number>;
}

interface DashboardState {
  tasks: TaskResponse[];
  agentProfiles: AgentProfileResponse[];
  hostPool: HostPool;
  queueDepth: number;
  paused: boolean;
  forgejoBaseUrl: string;
  /** Active alerts from `GET /api/status/alerts`, minus the ones the
   *  operator dismissed in this tab. Polled by the Dashboard. */
  alerts: OrchestratorAlert[];
  /** Alert ids hidden by an operator dismissal, pruned as soon as the
   *  server stops reporting them — see `mergeAlerts`. Session-local and
   *  deliberately not persisted: a dismissal means "I've seen this now",
   *  not "never show me this condition again". */
  dismissedAlertIds: Set<string>;
  resourceVersions: ResourceVersions;
  /** Signed-in Forgejo user, captured once at startup by the AuthGate
   *  via GET /api/me. Null when auth is disabled or the userinfo
   *  lookup failed at login. */
  user: AuthUser | null;
  /** Health of the shared dashboard WebSocket, rendered as the "Live" /
   *  "Reconnecting" marker in AppHeader. Starts as `reconnecting` — we
   *  haven't got a socket open yet, and claiming "Live" before the first
   *  frame arrives would be a lie on a dead backend. */
  connection: ConnectionState;

  // Actions
  setSnapshot: (data: {
    tasks: TaskResponse[];
    hostPool: HostPool;
    queueDepth: number;
    paused: boolean;
  }) => void;
  updateTask: (task: TaskResponse) => void;
  syncTasks: (tasks: TaskResponse[], opts?: SyncTasksOptions) => void;
  addTask: (task: TaskResponse) => void;
  removeTask: (taskId: number) => void;
  setConnection: (state: ConnectionState) => void;
  setStatus: (data: {
    paused: boolean;
    hostPool: HostPool;
    queueDepth: number;
  }) => void;
  setHostPool: (hostPool: HostPool) => void;
  setForgejoBaseUrl: (url: string) => void;
  setAlerts: (alerts: OrchestratorAlert[]) => void;
  dismissAlert: (id: string) => void;
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
  dismissedAlertIds: new Set<string>(),
  resourceVersions: { providers: 0, models: 0, profiles: 0 },
  user: null,
  connection: 'reconnecting',

  setSnapshot: (data) =>
    set({
      tasks: data.tasks,
      hostPool: data.hostPool,
      queueDepth: data.queueDepth,
      paused: data.paused,
    }),

  // Upsert, not map-in-place. A `task_updated` for an id we've never seen
  // used to be silently dropped, which made the REST refresh incapable of
  // healing a missed `task_created` — every creation path had to remember
  // to emit one or the task stayed invisible until a manual reload.
  updateTask: (task) =>
    set((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [...state.tasks, task] };
      const tasks = state.tasks.slice();
      tasks[idx] = task;
      return { tasks };
    }),

  /** Converge local state on an unfiltered `GET /api/tasks` response: upsert
   *  every returned row (preserving existing order, appending new ids) and
   *  prune local rows the server did not return.
   *
   *  Pruning is gated, because "absent from the response" does NOT generally
   *  mean "gone". Both conditions must hold:
   *
   *  1. The response is known to be complete, i.e. `completedLimit` was
   *     supplied and its completed bucket came back shorter than that. The
   *     route splits tasks into active / queued / completed and truncates the
   *     completed bucket to `limit` (`packages/server/src/routes/tasks.ts`),
   *     so a truncated response is silent about everything it dropped and
   *     nothing may be pruned from it. Omitting `completedLimit` disables
   *     pruning entirely, which makes `syncTasks` a plain bulk upsert.
   *
   *     Bucketing by the LOCAL status instead is not a valid substitute: the
   *     server buckets on the Forgejo-derived status, which is exactly what
   *     this poll exists to discover. A task stored `in-progress` whose issue
   *     was just closed is bucketed `cancelled` by the server and truncated
   *     away — pruning it because "active tasks are always returned in full"
   *     would delete a live row every 30s.
   *  2. The id was already in the store when the caller ISSUED the request
   *     (`knownIds`). Otherwise a `task_created` arriving over the WebSocket
   *     mid-flight is pruned by a response that predates it, and the new task
   *     blinks out until the next poll.
   *
   *  Not for snapshot handling: a WS (re)connect replaces task state
   *  wholesale via `setSnapshot`, which is intentional (docs/06-web-ui.md). */
  syncTasks: (tasks, opts) =>
    set((state) => {
      // Without a limit to compare against we cannot tell a complete
      // response from a truncated one, so "absent" reads as "unknown".
      const complete =
        opts?.completedLimit !== undefined &&
        completedCount(tasks) < opts.completedLimit;
      const incoming = new Map(tasks.map((t) => [t.id, t]));
      const merged: TaskResponse[] = [];
      const seen = new Set<number>();
      for (const local of state.tasks) {
        // Collapse any pre-existing duplicate ids while we're here — two
        // rows with the same id would render under the same React key.
        if (seen.has(local.id)) continue;
        const fresh = incoming.get(local.id);
        if (fresh) {
          merged.push(fresh);
          seen.add(local.id);
          continue;
        }
        const prunable =
          complete &&
          (opts?.knownIds === undefined || opts.knownIds.has(local.id));
        if (prunable) continue;
        merged.push(local);
        seen.add(local.id);
      }
      for (const task of tasks) {
        if (!seen.has(task.id)) {
          merged.push(task);
          seen.add(task.id);
        }
      }
      return { tasks: merged };
    }),

  // Upsert as well: now that the REST refresh can insert rows too
  // (`syncTasks`), a blind append could duplicate a task whose poll response
  // landed before its `task_created` frame — and two rows sharing a React key
  // render incorrectly.
  addTask: (task) =>
    set((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [...state.tasks, task] };
      const tasks = state.tasks.slice();
      tasks[idx] = task;
      return { tasks };
    }),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  setStatus: (data) =>
    set({
      paused: data.paused,
      hostPool: data.hostPool,
      queueDepth: data.queueDepth,
    }),

  setConnection: (connection) =>
    // Guard the write so the liveness poller re-asserting the current
    // state doesn't spam subscribers of the `connection` slice.
    set((state) => (state.connection === connection ? state : { connection })),

  setHostPool: (hostPool) => set({ hostPool }),
  setForgejoBaseUrl: (url) => set({ forgejoBaseUrl: url }),

  setAlerts: (alerts) =>
    set((state) =>
      mergeAlerts(state.alerts, alerts, state.dismissedAlertIds)
    ),

  dismissAlert: (id) =>
    set((state) => ({
      alerts: state.alerts.filter((a) => a.id !== id),
      dismissedAlertIds: new Set(state.dismissedAlertIds).add(id),
    })),

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
