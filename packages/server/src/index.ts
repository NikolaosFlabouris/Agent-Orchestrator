import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase, wasFirstRun, updateSetting } from "./db.js";
import { detectHostCapacity } from "./host-capacity.js";
import { ForgejoClient } from "./forgejo.js";
import {
  initDocker,
  listContainers,
  ensureAgentNetwork,
  initHostPathMap,
} from "./docker.js";
import { Scheduler } from "./scheduler.js";
import { gracefulShutdown } from "./shutdown.js";
import { onStartup } from "./recovery.js";
import { Poller } from "./polling.js";
import { verifyWebhooks } from "./webhooks.js";
import { createTaskRoutes } from "./routes/tasks.js";
import { settingsRoutes } from "./routes/settings.js";
import { createRepoRoutes } from "./routes/repos.js";
import { providerRoutes } from "./routes/providers.js";
import { agentProfileRoutes } from "./routes/agent-profiles.js";
import { createStatusRoutes } from "./routes/status.js";
import { createMeRoutes } from "./routes/me.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { createMcpOAuthRoutes } from "./routes/mcp-oauth.js";
import { createDashboardWs, broadcastStatusChanged } from "./ws/dashboard.js";
import { outputWs } from "./ws/output.js";
import { registerAuth, authDisabled } from "./auth.js";
import { initStateSync } from "./state-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORGEJO_URL = process.env.FORGEJO_URL ?? "http://forgejo:3000";
const FORGEJO_ORCHESTRATOR_TOKEN = process.env.FORGEJO_ORCHESTRATOR_TOKEN ?? "";
// Container layout invariants: the persistence volume is mounted at /data,
// SQLite lives at the root of it, and Fastify binds 0.0.0.0:8080 inside
// the container; the docker-compose port mapping forwards 8081→8080.
//
// HOST is computed at boot rather than hardcoded so the un-authed dev
// mode can force a 127.0.0.1 bind — see resolveBindHost() below. The
// container-internal port stays fixed because it's paired with the
// docker-compose port mapping; loopback exposure happens at the compose
// level via `127.0.0.1:8081:8080` (see docker-compose.yml).
//
// DB_PATH is env-overridable so `npm run dev` outside the container can
// point at a local file (e.g. `DB_PATH=./dev.db npm run dev`) without
// needing a /data mount.
const DB_PATH = process.env.DB_PATH ?? "/data/orchestrator.db";
const PORT = 8080;

/** Cookie-secret resolution (C2). The signed-cookie value is the entire
 *  auth surface, so a missing / too-short secret is a hard fail in
 *  production and requires an explicit dev-flag opt-in elsewhere.
 *
 *  - production: refuse to start without a strong secret (≥32 chars).
 *  - non-production with a strong secret: use it.
 *  - non-production without one: refuse unless
 *    ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET=1, in which case use the
 *    dev placeholder AND force the loopback bind (see resolveBindHost).
 *
 *  Length floor is 32 chars because `openssl rand -hex 32` is the
 *  documented recipe and any shorter value is almost certainly a typo
 *  or a placeholder the operator forgot to replace. */
const DEV_COOKIE_SECRET = "orchestrator-dev-secret-change-in-production";
function resolveCookieSecret(): { secret: string; isDevFallback: boolean } {
  const raw = process.env.COOKIE_SECRET;
  const strong = typeof raw === "string" && raw.length >= 32;
  if (strong) return { secret: raw!, isDevFallback: false };

  if (process.env.NODE_ENV === "production") {
    console.error(
      "COOKIE_SECRET is required in production and must be at least 32 " +
        "characters. Generate one with: openssl rand -hex 32"
    );
    process.exit(1);
  }
  if (process.env.ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET !== "1") {
    console.error(
      "COOKIE_SECRET is missing or too short (<32 chars). Set it to a " +
        "strong random value (openssl rand -hex 32), or set " +
        "ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET=1 for local dev — the " +
        "orchestrator will then bind to 127.0.0.1 only."
    );
    process.exit(1);
  }
  return { secret: DEV_COOKIE_SECRET, isDevFallback: true };
}

const { secret: COOKIE_SECRET, isDevFallback: COOKIE_SECRET_IS_DEV } =
  resolveCookieSecret();

/** Bind host (C2). 0.0.0.0 is the production default — the container's
 *  internal port is mapped to a host port by docker-compose, which is
 *  where LAN visibility is actually controlled. We override to
 *  127.0.0.1 whenever the orchestrator is running in a degraded
 *  security mode (auth disabled OR dev-fallback cookie secret) so that
 *  even a misconfigured `docker-compose.yml` with `0.0.0.0:8081:8080`
 *  can't reach the LAN by accident — the bind inside the container
 *  refuses non-loopback connections at the kernel level.
 *
 *  Operators who genuinely want an un-authed instance reachable from
 *  the LAN (e.g. for a private network demo) must consciously set
 *  ORCHESTRATOR_BIND_HOST=0.0.0.0 in addition to the other flags. */
function resolveBindHost(): string {
  const explicit = process.env.ORCHESTRATOR_BIND_HOST;
  if (explicit) return explicit;
  if (authDisabled() || COOKIE_SECRET_IS_DEV) return "127.0.0.1";
  return "0.0.0.0";
}
const HOST = resolveBindHost();

async function main() {
  // -- Fastify with Pino logger --
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  const log = app.log;

  // -- Plugins --
  await app.register(fastifyCookie, {
    secret: COOKIE_SECRET,
  });
  await app.register(fastifyWebsocket);

  // -- Database --
  log.info({ event: "db_init", path: DB_PATH }, "Initializing database");
  const db = initDatabase(DB_PATH);
  log.info({ event: "db_ready" }, "Database initialized");

  // -- Forgejo client --
  const forgejo = new ForgejoClient(FORGEJO_URL, FORGEJO_ORCHESTRATOR_TOKEN);
  if (FORGEJO_ORCHESTRATOR_TOKEN) {
    try {
      const user = await forgejo.getCurrentUser();
      log.info(
        { event: "forgejo_connected", user: user.login },
        "Forgejo connection verified",
      );
    } catch (err) {
      log.error(
        { event: "forgejo_connection_failed", err },
        "Failed to connect to Forgejo",
      );
    }
  } else {
    log.warn(
      { event: "forgejo_no_token" },
      "FORGEJO_ORCHESTRATOR_TOKEN not set — Forgejo client disabled",
    );
  }

  // -- Docker --
  try {
    initDocker();
    await ensureAgentNetwork();
    await initHostPathMap();
    const containers = await listContainers();
    log.info(
      { event: "docker_connected", managedContainers: containers.length },
      "Docker connection verified, agent-network ready",
    );
  } catch (err) {
    log.error(
      { event: "docker_connection_failed", err },
      "Failed to connect to Docker",
    );
  }

  // -- First-run host-capacity seeding --
  // On a fresh install, replace the static fallback resource pool with the
  // capacity Docker actually reports. Existing installs are left alone — the
  // operator's prior tuning takes precedence over re-detection.
  if (wasFirstRun()) {
    try {
      const capacity = await detectHostCapacity();
      updateSetting("max_agent_memory_mb", String(capacity.memory_total_mb));
      updateSetting("max_agent_cpu_cores", String(capacity.cpu_cores));
      log.info(
        {
          event: "host_capacity_seeded",
          source: capacity.source,
          memory_total_mb: capacity.memory_total_mb,
          cpu_cores: capacity.cpu_cores,
        },
        "Seeded resource pool from detected host capacity",
      );
    } catch (err) {
      log.warn(
        { event: "host_capacity_probe_failed", err },
        "Could not detect host capacity on first run; static defaults retained",
      );
    }
  }

  // -- State sync (WebSocket broadcast + Forgejo label sync) --
  initStateSync(forgejo, log);

  // -- Scheduler --
  const scheduler = new Scheduler(forgejo, log);

  // -- Startup recovery --
  await onStartup(forgejo, scheduler, log);

  // -- Verify webhooks --
  if (FORGEJO_ORCHESTRATOR_TOKEN) {
    await verifyWebhooks(forgejo, log);
  }

  // -- Authentication --
  await registerAuth(app);

  // -- Webhook endpoint (must be registered before other routes to get raw body parser) --
  await app.register(createWebhookRoutes(forgejo, scheduler));

  // -- Signed-in user identity --
  // /api/me reads the identity captured at /auth/callback from the
  // session cookie; the /api/* auth hook above gates it.
  await app.register(createMeRoutes());

  // -- REST API routes --
  await app.register(createTaskRoutes(forgejo, scheduler));
  await app.register(settingsRoutes);
  await app.register(createRepoRoutes(forgejo));
  await app.register(providerRoutes);
  await app.register(agentProfileRoutes);
  // MCP OAuth (Phase 3 Workstream C). Discovery + DCR + authorize +
  // token endpoints. These are NOT gated by MCP_ENABLED — the
  // discovery + DCR endpoints publish metadata about the MCP
  // endpoint's auth model and stay reachable independent of the
  // /mcp transport itself. The endpoints have their own auth model
  // (authorize → cookie session, token + register → public client +
  // PKCE), so the global /api/* hook deliberately doesn't fire on
  // them (it's an opt-in hook, not opt-out).
  await app.register(createMcpOAuthRoutes());
  // MCP transport (Phase 3 Workstream B + C). Gated by MCP_ENABLED=1;
  // when enabled, requires a valid OAuth bearer JWT (issued by the
  // mcp-oauth endpoints above). When disabled, returns a 503 stub
  // at /mcp.
  await app.register(createMcpRoutes({ forgejo, scheduler, log }));
  // Poller created here so status routes can access lastPollAt
  const poller = new Poller(forgejo, scheduler, log);
  await app.register(createStatusRoutes(scheduler, poller));

  // -- WebSocket endpoints --
  // dashboardWs is wired with a live scheduler.isPaused() getter so the
  // initial snapshot reflects the real paused state (F1). Previously
  // hardcoded to false, which left newly-connecting dashboards showing
  // "Running" against a paused scheduler until their first REST poll.
  await app.register(createDashboardWs({ isPaused: () => scheduler.isPaused() }));
  await app.register(outputWs);

  // -- Health route --
  app.get("/health", async () => ({ status: "ok" }));

  // -- Pause / Resume routes --
  // Both routes broadcast `status_changed` to all connected dashboards
  // (F2) so the paused indicator propagates immediately instead of
  // waiting for each client's 5-second /api/status poll cycle.
  app.post("/api/status/pause", async () => {
    scheduler.pause();
    broadcastStatusChanged(true);
    return { paused: true };
  });

  app.post("/api/status/resume", async () => {
    scheduler.resume();
    broadcastStatusChanged(false);
    return { paused: false };
  });

  // -- Static file serving for the UI build --
  const uiDistPath = path.resolve(__dirname, "../../ui/dist");
  try {
    await app.register(fastifyStatic, {
      root: uiDistPath,
      prefix: "/",
      wildcard: false,
    });

    // SPA fallback — serve index.html for client-side routes
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile("index.html", uiDistPath);
    });
  } catch {
    log.warn(
      { event: "ui_not_found", path: uiDistPath },
      "UI build not found — static serving disabled",
    );
  }

  // -- Start server --
  await app.listen({ port: PORT, host: HOST });
  log.info(
    {
      event: "server_started",
      port: PORT,
      host: HOST,
      auth_disabled: authDisabled(),
      cookie_secret_dev_fallback: COOKIE_SECRET_IS_DEV,
    },
    authDisabled() || COOKIE_SECRET_IS_DEV
      ? "Orchestrator started in DEGRADED mode — loopback bind only"
      : "Orchestrator server started",
  );

  // -- Start scheduler --
  scheduler.start();

  // -- Start fallback poller --
  poller.start();

  // -- Graceful shutdown --
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ event: "shutdown", signal }, "Shutting down");

    poller.stop();

    await gracefulShutdown(scheduler, log, async () => {
      db.close();
      await app.close();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
