import { create } from 'zustand';
import type { TaskResponse, AgentProfileResponse } from './api.js';
import type { HostPool } from './ws.js';

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

interface DashboardState {
  tasks: TaskResponse[];
  agentProfiles: AgentProfileResponse[];
  hostPool: HostPool;
  queueDepth: number;
  paused: boolean;
  dailyCompletions: number;
  forgejoBaseUrl: string;
  alerts: Alert[];
  resourceVersions: ResourceVersions;

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
  setStatus: (data: {
    paused: boolean;
    hostPool: HostPool;
    queueDepth: number;
  }) => void;
  setHostPool: (hostPool: HostPool) => void;
  setDailyCompletions: (count: number) => void;
  setForgejoBaseUrl: (url: string) => void;
  addAlert: (alert: Alert) => void;
  clearAlerts: () => void;
  setAgentProfiles: (profiles: AgentProfileResponse[]) => void;
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
  dailyCompletions: 0,
  forgejoBaseUrl: '',
  alerts: [],
  resourceVersions: { providers: 0, models: 0, profiles: 0 },

  setSnapshot: (data) =>
    set({
      tasks: data.tasks,
      hostPool: data.hostPool,
      queueDepth: data.queueDepth,
      paused: data.paused,
    }),

  updateTask: (task) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === task.id ? task : t)),
    })),

  addTask: (task) =>
    set((state) => ({
      tasks: [...state.tasks, task],
    })),

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

  setHostPool: (hostPool) => set({ hostPool }),
  setDailyCompletions: (count) => set({ dailyCompletions: count }),
  setForgejoBaseUrl: (url) => set({ forgejoBaseUrl: url }),

  addAlert: (alert) =>
    set((state) => ({ alerts: [...state.alerts, alert] })),

  clearAlerts: () => set({ alerts: [] }),

  setAgentProfiles: (profiles) => set({ agentProfiles: profiles }),

  bumpResourceVersion: (resource) =>
    set((state) => ({
      resourceVersions: {
        ...state.resourceVersions,
        [resource]: state.resourceVersions[resource] + 1,
      },
    })),
}));
