import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  getActiveTaskCount,
  getQueuedTasks,
  getDb,
  getSettingInt,
  getAgentTools,
} from "../db.js";
import type { Scheduler } from "../scheduler.js";
import type { Poller } from "../polling.js";
import { checkAlerts } from "../alerts.js";

const startTime = Date.now();
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? "/workspaces";
const CACHES_ROOT = process.env.CACHES_ROOT ?? "/caches";

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

      // Disk usage
      const workspacesBytes = getDirSize(WORKSPACES_ROOT);
      const cachesBytes = getDirSize(CACHES_ROOT);

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
      return { alerts: checkAlerts(app.log) };
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

function getDirSize(dirPath: string): number {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size;
        } catch {
          /* skip */
        }
      } else if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}
