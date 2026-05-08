import { create } from 'zustand';
import type { TaskResponse, ToolResponse } from './api.js';

interface Alert {
  level: 'info' | 'warning' | 'error';
  message: string;
}

interface DashboardState {
  tasks: TaskResponse[];
  tools: ToolResponse[];
  activeCount: number;
  maxConcurrency: number;
  queueDepth: number;
  paused: boolean;
  dailyCostUsd: number;
  dailyCompletions: number;
  forgejoBaseUrl: string;
  alerts: Alert[];
 
  // Actions
  setSnapshot: (data: {
    tasks: TaskResponse[];
    activeCount: number;
    maxConcurrency: number;
    queueDepth: number;
    paused: boolean;
  }) => void;
  updateTask: (task: TaskResponse) => void;
  addTask: (task: TaskResponse) => void;
  removeTask: (taskId: number) => void;
  setStatus: (data: {
    paused: boolean;
    activeCount: number;
    queueDepth: number;
  }) => void;
  setDailyCost: (cost: number) => void;
  setDailyCompletions: (count: number) => void;
  setForgejoBaseUrl: (url: string) => void;
  addAlert: (alert: Alert) => void;
  clearAlerts: () => void;
  setTools: (tools: ToolResponse[]) => void;
}

export const useStore = create<DashboardState>((set) => ({
  tasks: [],
  tools: [],
  activeCount: 0,
  maxConcurrency: 5,
  queueDepth: 0,
  paused: false,
  dailyCostUsd: 0,
  dailyCompletions: 0,
  forgejoBaseUrl: '',
  alerts: [],

  setSnapshot: (data) =>
    set({
      tasks: data.tasks,
      activeCount: data.activeCount,
      maxConcurrency: data.maxConcurrency,
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
      activeCount: data.activeCount,
      queueDepth: data.queueDepth,
    }),

  setDailyCost: (cost) => set({ dailyCostUsd: cost }),
  setDailyCompletions: (count) => set({ dailyCompletions: count }),
  setForgejoBaseUrl: (url) => set({ forgejoBaseUrl: url }),
 
  addAlert: (alert) =>
    set((state) => ({ alerts: [...state.alerts, alert] })),

  clearAlerts: () => set({ alerts: [] }),

  setTools: (tools) => set({ tools }),
}));
