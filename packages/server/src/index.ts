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
import { createWebhookRoutes } from "./routes/webhooks.js";
import { dashboardWs } from "./ws/dashboard.js";
import { outputWs } from "./ws/output.js";
import { registerAuth } from "./auth.js";
import { initStateSync } from "./state-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORGEJO_URL = process.env.FORGEJO_URL ?? "http://forgejo:3000";
const FORGEJO_ORCHESTRATOR_TOKEN = process.env.FORGEJO_ORCHESTRATOR_TOKEN ?? "";
// Container layout invariants: the persistence volume is mounted at /data,
// SQLite lives at the root of it, and Fastify binds 0.0.0.0:8080 because the
// docker-compose port mapping forwards 8081→8080. Changing any of these
// requires a matching change to docker-compose.yml + Dockerfile.
//
// DB_PATH is env-overridable so `npm run dev` outside the container can
// point at a local file (e.g. `DB_PATH=./dev.db npm run dev`) without
// needing a /data mount. PORT/HOST stay fixed because they're paired
// with the docker-compose port mapping.
const DB_PATH = process.env.DB_PATH ?? "/data/orchestrator.db";
const PORT = 8080;
const HOST = "0.0.0.0";
const COOKIE_SECRET =
  process.env.COOKIE_SECRET ?? "orchestrator-dev-secret-change-in-production";

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

  // -- REST API routes --
  await app.register(createTaskRoutes(forgejo, scheduler));
  await app.register(settingsRoutes);
  await app.register(createRepoRoutes(forgejo));
  await app.register(providerRoutes);
  await app.register(agentProfileRoutes);
  // Poller created here so status routes can access lastPollAt
  const poller = new Poller(forgejo, scheduler, log);
  await app.register(createStatusRoutes(scheduler, poller));

  // -- WebSocket endpoints --
  await app.register(dashboardWs);
  await app.register(outputWs);

  // -- Health route --
  app.get("/health", async () => ({ status: "ok" }));

  // -- Pause / Resume routes --
  app.post("/api/status/pause", async () => {
    scheduler.pause();
    return { paused: true };
  });

  app.post("/api/status/resume", async () => {
    scheduler.resume();
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
    { event: "server_started", port: PORT },
    "Orchestrator server started",
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
