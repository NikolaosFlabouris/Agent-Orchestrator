import type { Repo } from '@orchestrator/shared';
import { getRepos } from './db.js';
import type { ForgejoClient } from './forgejo.js';
import type { FastifyBaseLogger } from 'fastify';

const WEBHOOK_SECRET = process.env.FORGEJO_WEBHOOK_SECRET ?? '';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8080';
/** Container-facing orchestrator URL. The webhook target Forgejo
 *  registers must be reachable from the Forgejo *container* (a compose
 *  service name like `orchestrator`), which is not the same as the
 *  browser-facing ORCHESTRATOR_URL. Falls back to ORCHESTRATOR_URL so
 *  existing single-address (e.g. LAN-IP) deployments are unchanged. */
const ORCHESTRATOR_INTERNAL_URL =
  process.env.ORCHESTRATOR_INTERNAL_URL ?? ORCHESTRATOR_URL;

function getWebhookUrl(): string {
  return `${ORCHESTRATOR_INTERNAL_URL}/webhooks/forgejo`;
}

/**
 * Register a webhook on a Forgejo repo for the orchestrator.
 */
export async function registerWebhook(
  repo: Repo,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  const webhookUrl = getWebhookUrl();

  try {
    // Check if a webhook already exists for this URL
    const hooks = await forgejo.listHooks(repo);
    const existing = hooks.find((h) => h.config.url === webhookUrl);

    if (existing) {
      log.info(
        { event: 'webhook_exists', repo: `${repo.owner}/${repo.name}`, hook_id: existing.id },
        'Webhook already registered'
      );
      return;
    }

    // Register new webhook
    await forgejo.createHook(repo, {
      type: 'forgejo',
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret: WEBHOOK_SECRET,
      },
      events: ['issues', 'issue_comment', 'pull_request'],
      active: true,
    });

    log.info(
      { event: 'webhook_registered', repo: `${repo.owner}/${repo.name}` },
      'Webhook registered'
    );
  } catch (err) {
    log.error(
      { event: 'webhook_registration_failed', repo: `${repo.owner}/${repo.name}`, err },
      'Failed to register webhook'
    );
  }
}

/**
 * Delete the orchestrator's webhook from a Forgejo repo.
 */
export async function deleteWebhook(
  repo: Repo,
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  const webhookUrl = getWebhookUrl();

  try {
    const hooks = await forgejo.listHooks(repo);
    const ours = hooks.find((h) => h.config.url === webhookUrl);

    if (ours) {
      await forgejo.deleteHook(repo, ours.id);
      log.info(
        { event: 'webhook_deleted', repo: `${repo.owner}/${repo.name}`, hook_id: ours.id },
        'Webhook deleted'
      );
    }
  } catch (err) {
    log.warn(
      { event: 'webhook_delete_failed', repo: `${repo.owner}/${repo.name}`, err },
      'Failed to delete webhook'
    );
  }
}

/**
 * On startup, verify existing webhooks match the current orchestrator URL.
 * Register missing webhooks, log stale ones.
 */
export async function verifyWebhooks(
  forgejo: ForgejoClient,
  log: FastifyBaseLogger
): Promise<void> {
  const repos = getRepos();
  const webhookUrl = getWebhookUrl();

  log.info(
    { event: 'webhook_verify_start', repo_count: repos.length, url: webhookUrl },
    'Verifying webhooks'
  );

  for (const repo of repos) {
    try {
      const hooks = await forgejo.listHooks(repo);
      const ours = hooks.find((h) => h.config.url === webhookUrl);

      if (!ours) {
        log.info(
          { event: 'webhook_missing', repo: `${repo.owner}/${repo.name}` },
          'Webhook missing — registering'
        );
        await registerWebhook(repo, forgejo, log);
      } else if (!ours.active) {
        log.warn(
          { event: 'webhook_inactive', repo: `${repo.owner}/${repo.name}`, hook_id: ours.id },
          'Webhook exists but is inactive'
        );
      }
    } catch (err) {
      log.warn(
        { event: 'webhook_verify_error', repo: `${repo.owner}/${repo.name}`, err },
        'Failed to verify webhook'
      );
    }
  }

  log.info({ event: 'webhook_verify_complete' }, 'Webhook verification complete');
}
