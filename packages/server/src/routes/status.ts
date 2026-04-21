import fsp from "node:fs/promises";
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
import { resolveProviderKey } from "../scheduler-pools.js";

const startTime = Date.now();
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? "/workspaces";
const CACHES_ROOT = process.env.CACHES_ROOT ?? "/caches";

// ---------------------------------------------------------------------------
// Disk-usage cache (stale-while-revalidate)
// ---------------------------------------------------------------------------
//
// /api/status used to compute WORKSPACES_ROOT + CACHES_ROOT directory sizes on
// every request via synchronous recursive `fs.statSync`. With many workspaces
// that scan can take tens of seconds, and because it runs on the event-loop
// thread it blocked every other request behind it — the dashboard's 5s
// auto-refresh stacks pending status calls, `/health` times out, WebSocket
// upgrades stall. The orchestrator "runs" but the UI feels frozen.
//
// Fix: compute sizes with async fs.promises (no event-loop block), cache for
// 60 s, and serve from cache even while a background refresh is in flight.
// First call after boot returns zero bytes until the first refresh completes;
// every subsequent call is instant.
const DISK_CACHE_TTL_MS = 60_000;
let diskCache: { workspaces: number; caches: number; at: number } | null =
  null;
let diskRefreshing: Promise<void> | null = null;

async function getDirSizeAsync(dirPath: string): Promise<number> {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isFile()) {
        try {
          total += (await fsp.stat(fullPath)).size;
        } catch {
          /* skip — file may have vanished mid-scan */
        }
      } else if (entry.isDirectory()) {
        total += await getDirSizeAsync(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function ensureDiskCache(): void {
  if (diskCache && Date.now() - diskCache.at < DISK_CACHE_TTL_MS) return;
  if (diskRefreshing) return;
  diskRefreshing = (async () => {
    const [workspaces, caches] = await Promise.all([
      getDirSizeAsync(WORKSPACES_ROOT),
      getDirSizeAsync(CACHES_ROOT),
    ]);
    diskCache = { workspaces, caches, at: Date.now() };
  })().finally(() => {
    diskRefreshing = null;
  });
}

// Kick off the first refresh at module-load time so the cold-start window is
// short. `void` discards the promise; errors are swallowed inside.
void ensureDiskCache();

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
      // the scan never blocks the event loop. See ensureDiskCache above.
      ensureDiskCache();
      const workspacesBytes = diskCache?.workspaces ?? 0;
      const cachesBytes = diskCache?.caches ?? 0;

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

