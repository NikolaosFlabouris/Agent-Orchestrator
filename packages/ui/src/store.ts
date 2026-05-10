import { create } from 'zustand';
import type { TaskResponse, ToolResponse } from './api.js';
import type { HostPool } from './ws.js';

interface Alert {
  level: 'info' | 'warning' | 'error';
  message: string;
}

interface DashboardState {
  tasks: TaskResponse[];
  tools: ToolResponse[];
  hostPool: HostPool;
  queueDepth: number;
  paused: boolean;
  dailyCompletions: number;
  forgejoBaseUrl: string;
  alerts: Alert[];

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
  setTools: (tools: ToolResponse[]) => void;
}

const ZERO_POOL: HostPool = {
  memory_used_mb: 0,
  memory_total_mb: 0,
  cpu_used_cores: 0,
  cpu_total_cores: 0,
};

export const useStore = create<DashboardState>((set) => ({
  tasks: [],
  tools: [],
  hostPool: ZERO_POOL,
  queueDepth: 0,
  paused: false,
  dailyCompletions: 0,
  forgejoBaseUrl: '',
  alerts: [],

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

  setTools: (tools) => set({ tools }),
}));
