import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { initDatabase, getDb } from '../../db.js';
import { providerRoutes } from '../../routes/providers.js';
import { agentProfileRoutes } from '../../routes/agent-profiles.js';
import { settingsRoutes } from '../../routes/settings.js';

/** Route-level test suite (F4).
 *
 *  These tests exercise the HTTP boundary via `app.inject()` — Fastify's
 *  in-process request driver — so the route handlers run end-to-end
 *  including validation, persistence, error codes, and the shared
 *  `isUniqueViolation` race protection. No real socket, no Docker, no
 *  Forgejo dependency.
 *
 *  Coverage focuses on the route logic added/changed by this branch:
 *    - C1: provider responses omit `auth_token`, include `has_auth_token`
 *    - H1: race-on-insert TOCTOU returns 409 not 500
 *    - H5: agent_profile_id empty/null/dangling handling
 *    - H7: save-time harness↔provider compat check
 *    - M1: empty PATCH body on /api/models/:pk rejected
 *    - M2: settings accepts null default_agent_profile_id
 *    - M4: deleteAgentProfile atomic check
 *    - M5: provider rejects both auth_token AND api_key_env_var
 *    - M6: base_url scheme allowlist
 *    - L:  MODEL_ID_RE first-char letter/digit
 *
 *  Repository and task routes aren't covered here because they require
 *  a ForgejoClient stub (registerWebhook + listIssues / listUserRepos
 *  external calls). Those land in a separate suite when we wire a
 *  Forgejo mock.
 */

async function buildApp(): Promise<FastifyInstance> {
  // Each test gets a fresh in-memory DB; routes share the module-level
  // _db singleton via getDb(), so re-initDatabase is the per-test reset.
  initDatabase(':memory:');
  const app = Fastify({ logger: false });
  await app.register(providerRoutes);
  await app.register(agentProfileRoutes);
  await app.register(settingsRoutes);
  await app.ready();
  return app;
}

describe('Provider routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('GET /api/providers omits auth_token (C1) and reports has_auth_token', async () => {
    // Seed an inline-auth_token provider via direct DB write — the route
    // would reject this on save, but we're testing the response shape.
    getDb()
      .prepare(
        `UPDATE providers SET auth_token = 'secret-xyz', api_key_env_var = NULL
         WHERE id = 'anthropic'`
      )
      .run();
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { providers: Array<Record<string, unknown>> };
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.auth_token).toBeUndefined();
    expect(anthropic!.has_auth_token).toBe(true);
    // Sanity: the literal value never appears in the JSON payload.
    expect(res.body).not.toContain('secret-xyz');
  });

  it('POST /api/providers rejects unknown kind', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: 'foo',
        display_name: 'foo',
        kind: 'not-a-real-kind',
        concurrency_limit: 1,
        api_key_env_var: 'X',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('kind must be one of');
  });

  it('POST /api/providers rejects base_url with non-http scheme (M6)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: 'evil',
        display_name: 'evil',
        kind: 'openai-compatible',
        concurrency_limit: 1,
        base_url: 'javascript:alert(1)',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/http:\/\/ or https:\/\//);
  });

  it('POST /api/providers rejects both auth_token AND api_key_env_var (M5)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: 'dual-creds',
        display_name: 'Dual',
        kind: 'anthropic',
        concurrency_limit: 1,
        auth_token: 'inline-secret',
        api_key_env_var: 'X',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not both/);
  });

  it('POST /api/providers requires base_url for openai-compatible (kind-spec validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: 'selfhosted-nourl',
        display_name: 'Self-hosted',
        kind: 'openai-compatible',
        concurrency_limit: 1,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/base_url is required/);
  });

  it('POST /api/providers happy path returns 201 with has_auth_token=false for env-var auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: 'my-anthropic',
        display_name: 'Anthropic (team)',
        kind: 'anthropic',
        concurrency_limit: 5,
        api_key_env_var: 'ANTHROPIC_API_KEY',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe('my-anthropic');
    expect(body.has_auth_token).toBe(false);
    expect(body.auth_token).toBeUndefined();
  });

  it('POST /api/providers returns 409 on duplicate id (H1: catches PK race)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: 'anthropic', // seeded by bootstrap
        display_name: 'duplicate',
        kind: 'anthropic',
        concurrency_limit: 1,
        api_key_env_var: 'ANTHROPIC_API_KEY',
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('PATCH /api/providers/:id preserves auth_token when body omits it', async () => {
    getDb()
      .prepare(
        `UPDATE providers SET auth_token = 'kept-secret', api_key_env_var = NULL
         WHERE id = 'anthropic'`
      )
      .run();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/providers/anthropic',
      payload: { display_name: 'Renamed Anthropic' },
    });
    expect(res.statusCode).toBe(200);
    // Wire response has has_auth_token but not auth_token.
    expect(res.json().has_auth_token).toBe(true);
    // DB still has the original token, untouched.
    const row = getDb()
      .prepare('SELECT auth_token FROM providers WHERE id = ?')
      .get('anthropic') as { auth_token: string };
    expect(row.auth_token).toBe('kept-secret');
  });

  it('DELETE /api/providers/:id returns 409 when models reference it', async () => {
    // The bootstrap seed creates anthropic with models, so it can't be deleted.
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/providers/anthropic',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/referenced by/);
  });
});

describe('Model routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('POST /api/providers/:id/models rejects bad model_id leading char (L)', async () => {
    // MODEL_ID_RE requires first char to be alphanumeric; ':foo' fails.
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/anthropic/models',
      payload: { model_id: ':invalid', display_name: 'Bad' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/providers/:id/models accepts a well-formed model_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/anthropic/models',
      payload: { model_id: 'claude-test-1', display_name: 'Test 1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().model_id).toBe('claude-test-1');
  });

  // ---- Optional per-model context window. The column is nullable and
  // "unset" (NULL) must stay distinguishable from any real token count,
  // because the harnesses branch on it to decide whether to emit a
  // context-window key into their generated config at all. ----
  it('POST /api/providers/:id/models defaults context_window to null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/anthropic/models',
      payload: { model_id: 'claude-test-noctx', display_name: 'No ctx' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().context_window).toBeNull();
  });

  it('POST /api/providers/:id/models stores a supplied context_window', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/anthropic/models',
      payload: {
        model_id: 'claude-test-ctx',
        display_name: 'With ctx',
        context_window: 32768,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().context_window).toBe(32768);
  });

  it('POST /api/providers/:id/models rejects a non-positive-integer context_window', async () => {
    for (const context_window of [0, -1, 1.5, 'lots']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/providers/anthropic/models',
        payload: {
          model_id: 'claude-test-badctx',
          display_name: 'Bad ctx',
          context_window,
        },
      });
      expect(res.statusCode, `context_window=${context_window}`).toBe(400);
      expect(res.json().error).toMatch(/context_window/);
    }
  });

  it('PATCH /api/models/:pk sets and clears context_window', async () => {
    const sonnet = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'"
      )
      .get() as { id: number };

    const set = await app.inject({
      method: 'PATCH',
      url: `/api/models/${sonnet.id}`,
      payload: { context_window: 200000 },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().context_window).toBe(200000);

    // An explicit null clears it back to "use the harness default".
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/models/${sonnet.id}`,
      payload: { context_window: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().context_window).toBeNull();
  });

  it('PATCH /api/models/:pk leaves context_window alone when the key is absent', async () => {
    const sonnet = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'"
      )
      .get() as { id: number };
    await app.inject({
      method: 'PATCH',
      url: `/api/models/${sonnet.id}`,
      payload: { context_window: 65536 },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/models/${sonnet.id}`,
      payload: { display_name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().display_name).toBe('Renamed');
    expect(res.json().context_window).toBe(65536);
  });

  it('PATCH /api/models/:pk rejects a non-positive-integer context_window', async () => {
    const sonnet = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'"
      )
      .get() as { id: number };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/models/${sonnet.id}`,
      payload: { context_window: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/context_window/);
  });

  it('PATCH /api/models/:pk rejects model_id changes (H5 immutability)', async () => {
    const sonnet = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'"
      )
      .get() as { id: number };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/models/${sonnet.id}`,
      payload: { model_id: 'something-else' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/immutable/);
  });

  it('PATCH /api/models/:pk with empty body returns 400 (M1)', async () => {
    const sonnet = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'"
      )
      .get() as { id: number };
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/models/${sonnet.id}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/No editable fields/);
  });

  it('DELETE /api/models/:pk returns 409 when profiles use it', async () => {
    const sonnet = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'"
      )
      .get() as { id: number };
    // The bootstrap profile references this model, so deletion is refused.
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/models/${sonnet.id}`,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('Agent profile routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('POST /api/agent-profiles rejects incompatible harness↔provider (H7)', async () => {
    // claude-sdk only supports kind=anthropic. Seed an openai-only model
    // and try to point a claude-sdk profile at it.
    const openaiModel = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'openai' AND model_id = 'gpt-4o'"
      )
      .get() as { id: number };
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-profiles',
      payload: {
        id: 'sdk-openai',
        display_name: 'SDK on OpenAI',
        harness_id: 'claude-sdk',
        model_pk: openaiModel.id,
        config_json: {},
        timeout_minutes: 120,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not support provider kind/);
  });

  it('POST /api/agent-profiles rejects bad timeout_minutes', async () => {
    const sonnet = getDb()
      .prepare(
        "SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'"
      )
      .get() as { id: number };
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-profiles',
      payload: {
        id: 'bad-timeout',
        display_name: 'Bad',
        harness_id: 'claude-sdk',
        model_pk: sonnet.id,
        config_json: {},
        timeout_minutes: 0,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/positive integer/);
  });

  it('POST /api/agent-profiles returns 409 on duplicate id (H1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-profiles',
      payload: {
        id: 'default-claude-sdk', // seeded by bootstrap
        display_name: 'dupe',
        harness_id: 'claude-sdk',
        model_pk: 1,
        config_json: {},
        timeout_minutes: 120,
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('DELETE /api/agent-profiles/:id refuses to delete the global default (M4)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agent-profiles/default-claude-sdk',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/global default/);
  });
});

describe('Settings routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('GET /api/settings returns the seeded default_agent_profile_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.default_agent_profile_id).toBe('default-claude-sdk');
    expect(body.max_agent_memory_mb).toBeTypeOf('number');
  });

  it('PATCH /api/settings rejects unknown keys', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { some_made_up_key: 'value' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /api/settings rejects pointer to a non-existent agent profile', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { default_agent_profile_id: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not found/);
  });

  it('PATCH /api/settings accepts null default_agent_profile_id (M2)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { default_agent_profile_id: null },
    });
    expect(res.statusCode).toBe(200);
    // After clearing, the GET no longer reports the key.
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = after.json();
    expect(body.default_agent_profile_id).toBeUndefined();
  });

  it('PATCH /api/settings rejects max_agent_memory_mb of 0', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { max_agent_memory_mb: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /api/settings accepts a valid default_review_agent_profile_id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: {
        default_review_agent_profile_id: 'default-claude-code-subscription',
      },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().default_review_agent_profile_id).toBe(
      'default-claude-code-subscription'
    );
  });

  it('PATCH /api/settings rejects a dangling default_review_agent_profile_id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { default_review_agent_profile_id: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not found/);
  });

  it('PATCH /api/settings accepts null default_review_agent_profile_id (clears to implementation fallback)', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: {
        default_review_agent_profile_id: 'default-claude-code-subscription',
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { default_review_agent_profile_id: null },
    });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().default_review_agent_profile_id).toBeUndefined();
  });
});
