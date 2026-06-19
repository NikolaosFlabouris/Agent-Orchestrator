import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo } from '@orchestrator/shared';

/**
 * Webhook target tier tests (two-tier URL model).
 *
 * The webhook Forgejo registers must point at the orchestrator's
 * CONTAINER-facing URL (ORCHESTRATOR_INTERNAL_URL), because Forgejo is
 * itself a container and reaches the orchestrator over the docker
 * network — not at the browser-facing ORCHESTRATOR_URL. When
 * ORCHESTRATOR_INTERNAL_URL is unset it falls back to ORCHESTRATOR_URL
 * so existing single-address deployments are unchanged.
 *
 * webhooks.ts reads its env vars at module load, so each test sets the
 * environment and dynamic-imports a fresh module via vi.resetModules().
 */

const ENV_KEYS = ['ORCHESTRATOR_URL', 'ORCHESTRATOR_INTERNAL_URL'] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

const REPO: Repo = {
  id: 1,
  owner: 'acme',
  name: 'widgets',
} as unknown as Repo;

const LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as import('fastify').FastifyBaseLogger;

/** Capture the webhook URL that registerWebhook hands to createHook. */
async function capturedWebhookUrl(
  env: Record<string, string>
): Promise<string> {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  vi.resetModules();
  const { registerWebhook } = await import('../../webhooks.js');

  const createHook = vi.fn().mockResolvedValue({ id: 1 });
  const forgejo = {
    listHooks: vi.fn().mockResolvedValue([]),
    createHook,
  } as unknown as import('../../forgejo.js').ForgejoClient;

  await registerWebhook(REPO, forgejo, LOG);

  expect(createHook).toHaveBeenCalledTimes(1);
  return createHook.mock.calls[0][1].config.url as string;
}

describe('webhook target URL', () => {
  it('uses ORCHESTRATOR_INTERNAL_URL (container-facing) when set', async () => {
    const url = await capturedWebhookUrl({
      ORCHESTRATOR_URL: 'http://localhost:8081',
      ORCHESTRATOR_INTERNAL_URL: 'http://orchestrator:8080',
    });
    expect(url).toBe('http://orchestrator:8080/webhooks/forgejo');
  });

  it('falls back to ORCHESTRATOR_URL when ORCHESTRATOR_INTERNAL_URL is unset', async () => {
    const url = await capturedWebhookUrl({
      ORCHESTRATOR_URL: 'http://192.168.1.30:8081',
    });
    expect(url).toBe('http://192.168.1.30:8081/webhooks/forgejo');
  });
});
