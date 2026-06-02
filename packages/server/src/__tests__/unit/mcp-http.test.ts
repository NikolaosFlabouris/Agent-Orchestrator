import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { initDatabase, getDb } from '../../db.js';
import { createMcpRoutes } from '../../routes/mcp.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';
import {
  _resetCanonicalUrlForTests,
} from '../../mcp/oauth/config.js';
import { issueAccessToken } from '../../mcp/oauth/tokens.js';
import { registerClient } from '../../mcp/oauth/clients.js';

/**
 * HTTP integration test for the MCP endpoint.
 *
 * The unit tests in `mcp-tools.test.ts` exercise the tool surface via
 * `InMemoryTransport`. This file complements them by booting a real
 * Fastify app, mounting `createMcpRoutes` over the real
 * `StreamableHTTPServerTransport`, and connecting a real
 * `StreamableHTTPClientTransport` to it over a localhost socket — so
 * we catch any breakage at the Fastify ↔ MCP SDK transport seam (the
 * exact spot Workstream B's plan flagged as the integration risk:
 * encapsulated content-type parsers, `reply.hijack()` semantics,
 * `request.raw`/`reply.raw` handoff to the SDK).
 *
 * Kept small on purpose — one happy path for each tool — and gated
 * behind `MCP_ENABLED=1` set per-test, since the env flag is read at
 * plugin-registration time.
 */

interface Booted {
  app: FastifyInstance;
  url: URL;
  client: Client;
  triggerTick: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
}

let booted: Booted | null = null;

function insertRepo(): number {
  const result = getDb()
    .prepare(
      `INSERT INTO repos (owner, name, base_branch, agent_profile_id, install_steps, allow_script_steps, container_memory_mb, container_cpu_cores, merge_strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('acme', 'frontend', 'main', null, '[]', 0, null, null, 'squash');
  return result.lastInsertRowid as number;
}

async function bootApp(): Promise<Booted> {
  initDatabase(':memory:');
  // Env required by the MCP transport gate AND the bearer validator
  // (which reads MCP_OAUTH_SIGNING_SECRET to verify JWTs).
  process.env.MCP_ENABLED = '1';
  process.env.MCP_OAUTH_SIGNING_SECRET =
    'test-signing-secret-must-be-at-least-32-chars-long';
  // Pin ORCHESTRATOR_URL so JWT iss/aud match the canonical URL the
  // server uses. Reset the cached canonical URL because earlier
  // tests in the same worker may have populated it with the
  // default.
  process.env.ORCHESTRATOR_URL = 'http://localhost:8080';
  _resetCanonicalUrlForTests();

  const createIssue = vi
    .fn()
    .mockResolvedValue({ number: 200, title: 'wire title' });
  const replaceLabelByNames = vi.fn().mockResolvedValue(undefined);
  const getIssue = vi
    .fn()
    .mockResolvedValue({ number: 200, title: 'wire title' });
  const triggerTick = vi.fn();

  const forgejoStub = {
    createIssue,
    replaceLabelByNames,
    getIssue,
  } as unknown as ForgejoClient;

  const app = Fastify({ logger: false });
  await app.register(
    createMcpRoutes({
      forgejo: forgejoStub,
      scheduler: { triggerTick } as Pick<Scheduler, 'triggerTick'>,
    })
  );
  // Bind to a random free port on loopback.
  const listenAddr = await app.listen({ host: '127.0.0.1', port: 0 });
  // `listen` returns the resolved address as a string like
  // "http://127.0.0.1:54321"; pull the port off it.
  const port = Number(new URL(listenAddr).port);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  // Mint a real bearer JWT for the test client. Skip the HTTP DCR
  // + authorize + token dance and call the primitives directly —
  // those paths are covered by the mcp-oauth route tests; this
  // file is about the Fastify ↔ MCP SDK transport seam.
  const reg = registerClient({
    client_name: 'wire-test',
    redirect_uris: ['http://127.0.0.1:9999/callback'],
  });
  if (!reg.ok) throw new Error(`Test client registration failed: ${reg.error_description}`);
  const access = await issueAccessToken({
    forgejo_user_login: 'wire-test-user',
    client_id: reg.client.client_id,
  });

  const client = new Client({ name: 'wire-test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${access.access_token}` },
    },
  });
  await client.connect(transport);

  return { app, url, client, triggerTick, createIssue };
}

beforeEach(async () => {
  booted = await bootApp();
});

afterEach(async () => {
  if (!booted) return;
  await booted.client.close();
  await booted.app.close();
  booted = null;
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_OAUTH_SIGNING_SECRET;
  delete process.env.ORCHESTRATOR_URL;
  _resetCanonicalUrlForTests();
});

describe('MCP HTTP transport — real wire', () => {
  it('completes the initialize handshake and lists the three tools', async () => {
    const { client } = booted!;
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['create_task', 'list_agent_profiles', 'list_repos']);
  });

  it('list_repos round-trips the structured content over HTTP', async () => {
    insertRepo();
    const { client } = booted!;
    const result = await client.callTool({ name: 'list_repos', arguments: {} });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      repos: Array<{ owner: string; name: string }>;
    };
    expect(sc.repos).toHaveLength(1);
    expect(sc.repos[0]).toMatchObject({ owner: 'acme', name: 'frontend' });
  });

  it('create_task goes through the real Fastify ↔ SDK seam and inserts a task', async () => {
    const repoId = insertRepo();
    const { client, triggerTick, createIssue } = booted!;
    const result = await client.callTool({
      name: 'create_task',
      arguments: { repo_id: repoId, title: 'wire t', description: 'wire d' },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      task: { issue_id: number; status: string };
      issue: { number: number };
    };
    expect(sc.issue.number).toBe(200);
    expect(sc.task.issue_id).toBe(200);
    expect(sc.task.status).toBe('queued');
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(triggerTick).toHaveBeenCalledTimes(1);
  });
});

describe('MCP HTTP transport — bearer validation', () => {
  // These tests boot their own app (not the shared `booted` one) so
  // they can issue raw HTTP requests without the SDK client doing
  // OAuth-flow plumbing on our behalf.
  let app: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    if (booted) {
      await booted.client.close();
      await booted.app.close();
      booted = null;
    }
    initDatabase(':memory:');
    process.env.MCP_ENABLED = '1';
    process.env.MCP_OAUTH_SIGNING_SECRET =
      'test-signing-secret-must-be-at-least-32-chars-long';
    process.env.ORCHESTRATOR_URL = 'http://localhost:8080';
    _resetCanonicalUrlForTests();

    app = Fastify({ logger: false });
    await app.register(
      createMcpRoutes({
        forgejo: {} as ForgejoClient,
        scheduler: { triggerTick: vi.fn() } as Pick<Scheduler, 'triggerTick'>,
      })
    );
    const listenAddr = await app.listen({ host: '127.0.0.1', port: 0 });
    port = Number(new URL(listenAddr).port);
  });

  afterEach(async () => {
    await app.close();
    delete process.env.MCP_ENABLED;
    delete process.env.MCP_OAUTH_SIGNING_SECRET;
    delete process.env.ORCHESTRATOR_URL;
    _resetCanonicalUrlForTests();
  });

  it('returns 401 + WWW-Authenticate when the Authorization header is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toMatch(/^Bearer /);
    expect(wwwAuth).toContain('resource_metadata=');
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it("returns 401 when Authorization isn't Bearer scheme", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic abc' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the JWT signature is bad', async () => {
    // Issue a valid token, then corrupt the signature so the HMAC
    // fails. We flip the FIRST character of the signature segment,
    // NOT the last: a 32-byte HS256 signature base64url-encodes to 43
    // chars whose final char carries only 4 meaningful bits (the low
    // 2 are zero padding), so ~1/16 of single-char substitutions there
    // (e.g. 'U' -> 'X') decode to the SAME bytes — the token still
    // verifies, sails past the bearer check, and the SDK transport
    // answers 406 (missing Accept header) instead of 401. That was the
    // source of an intermittent "expected 406 to be 401" flake. Every
    // non-final char carries 6 meaningful bits, so flipping the first
    // one always changes the decoded signature and the HMAC fails.
    const reg = registerClient({
      client_name: 't',
      redirect_uris: ['http://127.0.0.1:9999/cb'],
    });
    if (!reg.ok) throw new Error(reg.error_description);
    const access = await issueAccessToken({
      forgejo_user_login: 'alice',
      client_id: reg.client.client_id,
    });
    const [header, payload, signature] = access.access_token.split('.');
    const flippedSig = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    const tampered = `${header}.${payload}.${flippedSig}`;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tampered}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the token was issued with a different signing key', async () => {
    const reg = registerClient({
      client_name: 't',
      redirect_uris: ['http://127.0.0.1:9999/cb'],
    });
    if (!reg.ok) throw new Error(reg.error_description);
    const access = await issueAccessToken({
      forgejo_user_login: 'alice',
      client_id: reg.client.client_id,
    });
    // Rotate the signing secret AFTER issue — the previously-valid
    // token now fails signature verification.
    process.env.MCP_OAUTH_SIGNING_SECRET =
      'rotated-secret-after-issue-still-32-chars-min';
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access.access_token}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('MCP HTTP transport — gated off', () => {
  // This block boots its OWN app with MCP_ENABLED unset, so it sees
  // the 503 diagnostic stub instead of the live transport. We tear
  // down the default `bootApp()` from beforeEach first.
  beforeEach(async () => {
    if (booted) {
      await booted.client.close();
      await booted.app.close();
      booted = null;
    }
    delete process.env.MCP_ENABLED;
  });

  it('returns 503 with an mcp_disabled body when MCP_ENABLED is unset', async () => {
    initDatabase(':memory:');
    const app = Fastify({ logger: false });
    await app.register(
      createMcpRoutes({
        forgejo: {} as ForgejoClient,
        scheduler: { triggerTick: vi.fn() } as Pick<Scheduler, 'triggerTick'>,
      })
    );
    const listenAddr = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(listenAddr).port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('mcp_disabled');
    } finally {
      await app.close();
    }
  });
});
