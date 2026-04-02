import Fastify from 'fastify';
import path from 'node:path';
import { initDatabase } from './db.js';
import { ForgejoClient } from './forgejo.js';
import { initDocker, listContainers } from './docker.js';
import { Scheduler } from './scheduler.js';

const FORGEJO_URL = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
const FORGEJO_TOKEN = process.env.FORGEJO_TOKEN ?? '';
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'orchestrator.db');
const PORT = parseInt(process.env.PORT ?? '8080', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  // -- Fastify with Pino logger --
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  const log = app.log;

  // -- Database --
  log.info({ event: 'db_init', path: DB_PATH }, 'Initializing database');
  const db = initDatabase(DB_PATH);
  log.info({ event: 'db_ready' }, 'Database initialized');

  // -- Forgejo client --
  const forgejo = new ForgejoClient(FORGEJO_URL, FORGEJO_TOKEN);
  if (FORGEJO_TOKEN) {
    try {
      const user = await forgejo.getCurrentUser();
      log.info(
        { event: 'forgejo_connected', user: user.login },
        'Forgejo connection verified'
      );
    } catch (err) {
      log.error(
        { event: 'forgejo_connection_failed', err },
        'Failed to connect to Forgejo'
      );
    }
  } else {
    log.warn(
      { event: 'forgejo_no_token' },
      'FORGEJO_TOKEN not set — Forgejo client disabled'
    );
  }

  // -- Docker --
  try {
    initDocker();
    const containers = await listContainers();
    log.info(
      { event: 'docker_connected', managedContainers: containers.length },
      'Docker connection verified'
    );
  } catch (err) {
    log.error(
      { event: 'docker_connection_failed', err },
      'Failed to connect to Docker'
    );
  }

  // -- Scheduler --
  const scheduler = new Scheduler(forgejo, log);

  // -- Health route --
  app.get('/health', async () => ({ status: 'ok' }));

  // -- Pause / Resume routes --
  app.post('/api/status/pause', async () => {
    scheduler.pause();
    return { paused: true };
  });

  app.post('/api/status/resume', async () => {
    scheduler.resume();
    return { paused: false };
  });

  app.get('/api/status', async () => ({
    paused: scheduler.isPaused(),
    running: scheduler.isRunning(),
  }));

  // -- Start server --
  await app.listen({ port: PORT, host: HOST });
  log.info({ event: 'server_started', port: PORT }, 'Orchestrator server started');

  // -- Start scheduler --
  scheduler.start();

  // -- Graceful shutdown --
  const shutdown = async (signal: string) => {
    log.info({ event: 'shutdown', signal }, 'Shutting down');
    scheduler.stop();
    db.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
