import type { FastifyInstance } from "fastify";
import {
  getQueuedTasks,
  getDb,
  getSettingInt,
  getProviders,
  getTasks,
  getRepo,
  getAgentTool,
} from "../db.js";
import { getActiveResources } from "../queue.js";
import type { Scheduler } from "../scheduler.js";
import type { Poller } from "../polling.js";
import { checkAlerts } from "../alerts.js";
import { ensureDiskCache, getDiskCache } from "../disk-usage.js";
import { resolveProviderKey } from "../scheduler-pools.js";
import { FORWARDED_KEYS } from "../credentials.js";
import { detectHostCapacity } from "../host-capacity.js";

const startTime = Date.now();

export function createStatusRoutes(scheduler: Scheduler, poller?: Poller) {
  return async function statusRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/status
    app.get("/api/status", async () => {
      // Host resource pool: sum of active container memory/CPU vs the
      // configured pool. Replaces the old count-based "slots" since
      // per-repo container_memory_mb / container_cpu_cores can vary.
      const used = getActiveResources();
      const pool = {
        memory_mb: getSettingInt('max_agent_memory_mb'),
        cpu_cores: getSettingInt('max_agent_cpu_cores'),
      };
      const queueDepth = getQueuedTasks().length;

      // Daily completions
      const dailyRow = getDb()
        .prepare(
          `SELECT COUNT(*) as completions
           FROM attempts WHERE date(completed_at) = date('now')`,
        )
        .get() as { completions: number };

      // Disk usage — served from a 60s cache refreshed in the background so
      // the scan never blocks the event loop. See ../disk-usage.ts.
      ensureDiskCache();
      const disk = getDiskCache();
      const workspacesBytes = disk?.workspaces ?? 0;
      const cachesBytes = disk?.caches ?? 0;

      // Per-provider slot accounting — drives the Pools row on the dashboard.
      const activeTasks = [
        ...getTasks({ status: 'preparing' }),
        ...getTasks({ status: 'in-progress' }),
        ...getTasks({ status: 'in-review' }),
      ].filter((t) => t.container_id !== null);
      const activePerProvider = new Map<string, number>();
      for (const task of activeTasks) {
        const repo = getRepo(task.repo_id);
        const toolId = task.agent_tool ?? repo?.agent_tool;
        const tool = toolId ? getAgentTool(toolId) : undefined;
        const key = resolveProviderKey(task, tool, repo);
        activePerProvider.set(key, (activePerProvider.get(key) ?? 0) + 1);
      }
      const providers = getProviders().map((p) => ({
        id: p.id,
        display_name: p.display_name,
        concurrency_limit: p.concurrency_limit,
        active_slots: activePerProvider.get(p.id) ?? 0,
      }));

      return {
        state: scheduler.isPaused() ? "paused" : "running",
        // Host resource pool — utilization vs cap on each dimension.
        host_pool: {
          memory_used_mb: used.memoryMb,
          memory_total_mb: pool.memory_mb,
          cpu_used_cores: used.cpuCores,
          cpu_total_cores: pool.cpu_cores,
        },
        queue_depth: queueDepth,
        daily_completions: dailyRow.completions,
        forgejo_base_url: process.env.FORGEJO_URL ?? 'http://forgejo:3000',
        forgejo_connected: true,
        last_poll_at: poller?.lastPollAt ?? null,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        providers,
        disk: {
          workspaces_bytes: workspacesBytes,
          caches_bytes: cachesBytes,
          total_bytes: workspacesBytes + cachesBytes,
        },
      };
    });

    // GET /api/status/alerts — active alert conditions
    app.get("/api/status/alerts", async () => {
      return { alerts: await checkAlerts(app.log) };
    });

    // GET /api/status/host-capacity — live host capacity probe used by
    // the Settings UI to render "Detected: X MB / Y cores" hints next to
    // the resource-pool inputs and warn when the operator's value exceeds
    // what's actually available. Purely informational — the orchestrator
    // always honours the configured settings.
    app.get("/api/status/host-capacity", async () => {
      return await detectHostCapacity();
    });

    // GET /api/status/credentials — read-only credential status
    app.get("/api/status/credentials", async () => {
      // Orchestrator-side env vars (used by the orchestrator process itself,
      // never forwarded to agent containers).
      const orchestratorVars = [
        "FORGEJO_ORCHESTRATOR_TOKEN",
        "FORGEJO_AGENT_TOKEN",
        "FORGEJO_OAUTH_CLIENT_ID",
        "FORGEJO_OAUTH_CLIENT_SECRET",
        "FORGEJO_WEBHOOK_SECRET",
        "ORCHESTRATOR_URL",
      ];

      // Each entry carries a `scope` so the UI can split orchestrator-only
      // secrets from provider keys forwarded to agent containers (the latter
      // are what the per-tool env_vars override form lists).
      const credentials = [
        ...orchestratorVars.map((name) => ({
          name,
          configured: !!process.env[name],
          scope: 'orchestrator' as const,
        })),
        ...FORWARDED_KEYS.map((name) => ({
          name,
          configured: !!process.env[name],
          scope: 'forwarded' as const,
        })),
      ];

      return { credentials };
    });
  };
}

