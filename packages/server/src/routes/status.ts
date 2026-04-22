import type { FastifyInstance } from "fastify";
import {
  getActiveTaskCount,
  getQueuedTasks,
  getDb,
  getSettingInt,
  getAgentTools,
  getProviders,
  getTasks,
  getRepo,
  getAgentTool,
} from "../db.js";
import type { Scheduler } from "../scheduler.js";
import type { Poller } from "../polling.js";
import { checkAlerts } from "../alerts.js";
import { ensureDiskCache, getDiskCache } from "../disk-usage.js";
import { resolveProviderKey } from "../scheduler-pools.js";

const startTime = Date.now();

export function createStatusRoutes(scheduler: Scheduler, poller?: Poller) {
  return async function statusRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/status
    app.get("/api/status", async () => {
      const activeSlots = getActiveTaskCount();
      const maxConcurrency = getSettingInt("max_concurrency");
      const queueDepth = getQueuedTasks().length;

      // Daily completions and cost
      const dailyRow = getDb()
        .prepare(
          `SELECT COUNT(*) as completions, COALESCE(SUM(cost_usd), 0) as cost
           FROM attempts WHERE date(completed_at) = date('now')`,
        )
        .get() as { completions: number; cost: number };

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
        active_slots: activeSlots,
        max_concurrency: maxConcurrency,
        queue_depth: queueDepth,
        daily_completions: dailyRow.completions,
        daily_cost_usd: Math.round(dailyRow.cost * 100) / 100,
        forgejo_connected: true,
        last_poll_at: poller?.lastPollAt ?? null,
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        providers,
        disk: {
          workspaces_bytes: workspacesBytes,
          caches_bytes: cachesBytes,
          total_bytes: workspacesBytes + cachesBytes,
          threshold_bytes: getSettingInt("disk_threshold_bytes"),
        },
      };
    });

    // GET /api/status/alerts — active alert conditions
    app.get("/api/status/alerts", async () => {
      return { alerts: await checkAlerts(app.log) };
    });

    // GET /api/status/credentials — read-only credential status
    app.get("/api/status/credentials", async () => {
      const knownVars = [
        "FORGEJO_ORCHESTRATOR_TOKEN",
        "FORGEJO_AGENT_TOKEN",
        "ANTHROPIC_API_KEY",
        "FORGEJO_OAUTH_CLIENT_ID",
        "FORGEJO_OAUTH_CLIENT_SECRET",
        "FORGEJO_WEBHOOK_SECRET",
        "ORCHESTRATOR_URL",
      ];

      // Also include env vars from configured agent tools
      const tools = getAgentTools();
      for (const tool of tools) {
        try {
          const authConfig = JSON.parse(tool.auth_config);
          if (authConfig.env_var && !knownVars.includes(authConfig.env_var)) {
            knownVars.push(authConfig.env_var);
          }
        } catch {
          /* skip */
        }
      }

      const credentials = knownVars.map((name) => ({
        name,
        configured: !!process.env[name],
      }));

      return { credentials };
    });
  };
}

