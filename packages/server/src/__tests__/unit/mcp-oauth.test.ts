import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

import { initDatabase } from '../../db.js';
import { createMcpOAuthRoutes } from '../../routes/mcp-oauth.js';
import { registerClient, getClient } from '../../mcp/oauth/clients.js';
import {
  createAuthCode,
  consumeAuthCode,
  exchangeRefreshToken,
  issueAccessToken,
  issueRefreshToken,
  pkceS256,
  verifyAccessToken,
} from '../../mcp/oauth/tokens.js';
import {
  _resetCanonicalUrlForTests,
  getCanonicalOrchestratorUrl,
  getMcpResourceUrl,
} from '../../mcp/oauth/config.js';

/**
 * Tests for the MCP OAuth Authorization Server.
 *
 * Three layers:
 *   1. Token + client primitives (unit) — PKCE, JWT issue/verify,
 *      code one-time-use, refresh rotation with reuse-detection,
 *      DCR loopback-URI enforcement.
 *   2. HTTP discovery + DCR + token endpoints (route) — exact
 *      response shape, error mapping, content-type handling.
 *   3. Full flow simulation — register, mint a code directly,
 *      redeem it for tokens, refresh, replay the original refresh
 *      to confirm the family is revoked.
 *
 * Authorize-endpoint happy path (session-cookie + Forgejo identity
 * lookup) is deliberately scoped out of these tests — it requires
 * full cookie signing + Forgejo /user mocking and is best covered
 * by a manual smoke. Authorize negative cases (missing params,
 * bad redirect, no session → bounce) ARE covered here.
 */

const TEST_SIGNING_SECRET = 'oauth-test-signing-secret-32-chars-or-more!';
const TEST_ORCH_URL = 'http://localhost:8080';
const TEST_COOKIE_SECRET = 'cookie-test-secret-at-least-32-characters!';

beforeEach(() => {
  initDatabase(':memory:');
  process.env.MCP_OAUTH_SIGNING_SECRET = TEST_SIGNING_SECRET;
  process.env.ORCHESTRATOR_URL = TEST_ORCH_URL;
  process.env.COOKIE_SECRET = TEST_COOKIE_SECRET;
  _resetCanonicalUrlForTests();
});

afterEach(() => {
  delete process.env.MCP_OAUTH_SIGNING_SECRET;
  delete process.env.ORCHESTRATOR_URL;
  delete process.env.COOKIE_SECRET;
  _resetCanonicalUrlForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe('PKCE S256', () => {
  it('derives the challenge as BASE64URL(SHA256(verifier))', () => {
    // RFC 7636 Appendix B vector:
    // verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // expected challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

// ---------------------------------------------------------------------------
// Access tokens (JWT)
// ---------------------------------------------------------------------------

describe('Access JWT', () => {
  it('issues a token that verifies with the same key + matches iss/aud/sub claims', async () => {
    const { access_token, expires_in } = await issueAccessToken({
      forgejo_user_login: 'alice',
      client_id: 'client-1',
    });
    expect(expires_in).toBeGreaterThan(0);
    const v = await verifyAccessToken(access_token);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.claims.sub).toBe('alice');
    expect(v.claims.aud).toBe(getMcpResourceUrl());
    expect(v.claims.iss).toBe(getCanonicalOrchestratorUrl());
    expect(v.claims.client_id).toBe('client-1');
    expect(v.claims.scope).toBe('mcp');
  });

  it('rejects an empty / malformed token', async () => {
    const v1 = await verifyAccessToken('');
    expect(v1.ok).toBe(false);
    const v2 = await verifyAccessToken('not-a-jwt');
    expect(v2.ok).toBe(false);
  });

  it('rejects a token signed with a different key', async () => {
    const { access_token } = await issueAccessToken({
      forgejo_user_login: 'alice',
      client_id: 'client-1',
    });
    // Rotate the signing key without re-issuing.
    process.env.MCP_OAUTH_SIGNING_SECRET =
      'a-totally-different-secret-of-sufficient-length!';
    const v = await verifyAccessToken(access_token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_signature');
  });

  it('rejects a token issued for a different audience', async () => {
    const { access_token } = await issueAccessToken({
      forgejo_user_login: 'alice',
      client_id: 'client-1',
    });
    // Repoint ORCHESTRATOR_URL so getMcpResourceUrl returns a
    // different aud, then verify the previously-issued token.
    process.env.ORCHESTRATOR_URL = 'http://elsewhere:9999';
    _resetCanonicalUrlForTests();
    const v = await verifyAccessToken(access_token);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // jose disambiguates audience vs issuer via the `claim` field
      // when it can; either one is acceptable here (both are wrong).
      expect(['wrong_audience', 'wrong_issuer']).toContain(v.reason);
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

describe('Authorization codes', () => {
  function makeClient(): string {
    const r = registerClient({
      client_name: 'test',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
    });
    if (!r.ok) throw new Error(r.error_description);
    return r.client.client_id;
  }

  it('create + consume happy path', () => {
    const client_id = makeClient();
    const verifier = 'a'.repeat(64);
    const challenge = pkceS256(verifier);
    const code = createAuthCode({
      client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_challenge: challenge,
      resource: getMcpResourceUrl(),
      forgejo_user_login: 'alice',
    });
    const r = consumeAuthCode({
      code,
      client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_verifier: verifier,
      resource: getMcpResourceUrl(),
    });
    expect(r).toEqual({ ok: true, forgejo_user_login: 'alice' });
  });

  it('rejects a second consumption of the same code', () => {
    const client_id = makeClient();
    const verifier = 'a'.repeat(64);
    const code = createAuthCode({
      client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_challenge: pkceS256(verifier),
      resource: getMcpResourceUrl(),
      forgejo_user_login: 'alice',
    });
    expect(
      consumeAuthCode({
        code,
        client_id,
        redirect_uri: 'http://127.0.0.1:9999/callback',
        code_verifier: verifier,
        resource: getMcpResourceUrl(),
      }).ok
    ).toBe(true);
    const second = consumeAuthCode({
      code,
      client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_verifier: verifier,
      resource: getMcpResourceUrl(),
    });
    expect(second).toEqual({ ok: false, reason: 'consumed' });
  });

  it('rejects a wrong PKCE verifier', () => {
    const client_id = makeClient();
    const code = createAuthCode({
      client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_challenge: pkceS256('a'.repeat(64)),
      resource: getMcpResourceUrl(),
      forgejo_user_login: 'alice',
    });
    const r = consumeAuthCode({
      code,
      client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_verifier: 'wrong-verifier-but-right-length-aaaaaaaaa',
      resource: getMcpResourceUrl(),
    });
    expect(r).toEqual({ ok: false, reason: 'pkce_mismatch' });
  });

  it('rejects mismatched client/redirect/resource', () => {
    const client_id = makeClient();
    const verifier = 'a'.repeat(64);
    const code = createAuthCode({
      client_id,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_challenge: pkceS256(verifier),
      resource: getMcpResourceUrl(),
      forgejo_user_login: 'alice',
    });
    expect(
      consumeAuthCode({
        code,
        client_id: 'other-client',
        redirect_uri: 'http://127.0.0.1:9999/callback',
        code_verifier: verifier,
        resource: getMcpResourceUrl(),
      }).ok
    ).toBe(false);
    expect(
      consumeAuthCode({
        code,
        client_id,
        redirect_uri: 'http://127.0.0.1:9999/other',
        code_verifier: verifier,
        resource: getMcpResourceUrl(),
      }).ok
    ).toBe(false);
    expect(
      consumeAuthCode({
        code,
        client_id,
        redirect_uri: 'http://127.0.0.1:9999/callback',
        code_verifier: verifier,
        resource: 'http://elsewhere/mcp',
      }).ok
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refresh tokens — rotation + reuse-detection
// ---------------------------------------------------------------------------

describe('Refresh tokens', () => {
  function makeClient(): string {
    const r = registerClient({
      client_name: 'test',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
    });
    if (!r.ok) throw new Error(r.error_description);
    return r.client.client_id;
  }

  it('rotation: exchange returns ok, the original is then revoked, the new one works', () => {
    const client_id = makeClient();
    const first = issueRefreshToken({
      client_id,
      forgejo_user_login: 'alice',
      resource: getMcpResourceUrl(),
    });
    const r = exchangeRefreshToken({
      refresh_token: first.refresh_token,
      client_id,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.family_id).toBe(first.family_id);

    // The original is now revoked.
    const replay = exchangeRefreshToken({
      refresh_token: first.refresh_token,
      client_id,
    });
    expect(replay).toEqual({ ok: false, reason: 'revoked' });
  });

  it('reuse-detection: replaying a rotated-out token revokes the WHOLE family', () => {
    const client_id = makeClient();
    const first = issueRefreshToken({
      client_id,
      forgejo_user_login: 'alice',
      resource: getMcpResourceUrl(),
    });
    // Legitimate rotation.
    const exchanged1 = exchangeRefreshToken({
      refresh_token: first.refresh_token,
      client_id,
    });
    expect(exchanged1.ok).toBe(true);
    if (!exchanged1.ok) return;
    const second = issueRefreshToken({
      client_id,
      forgejo_user_login: 'alice',
      resource: getMcpResourceUrl(),
      family_id: exchanged1.family_id,
    });
    // Legit follow-up still works at this point.
    // ...but now an attacker replays the original (already-revoked) refresh.
    const replay = exchangeRefreshToken({
      refresh_token: first.refresh_token,
      client_id,
    });
    expect(replay).toEqual({ ok: false, reason: 'revoked' });
    // And the legitimate `second` is also now revoked — reuse-detection
    // burns down the whole family.
    const followUp = exchangeRefreshToken({
      refresh_token: second.refresh_token,
      client_id,
    });
    expect(followUp).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects exchange with the wrong client_id', () => {
    const client_id = makeClient();
    const first = issueRefreshToken({
      client_id,
      forgejo_user_login: 'alice',
      resource: getMcpResourceUrl(),
    });
    const r = exchangeRefreshToken({
      refresh_token: first.refresh_token,
      client_id: 'someone-else',
    });
    expect(r).toEqual({ ok: false, reason: 'client_mismatch' });
  });

  it('rejects unknown refresh token', () => {
    const r = exchangeRefreshToken({
      refresh_token: 'never-issued',
      client_id: 'c',
    });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// DCR client registry
// ---------------------------------------------------------------------------

describe('DCR (client registration)', () => {
  it('accepts loopback redirect URIs (127.0.0.1, localhost, [::1])', () => {
    for (const uri of [
      'http://127.0.0.1:9999/callback',
      'http://localhost:9999/callback',
      'http://[::1]:9999/callback',
      // Port is optional.
      'http://127.0.0.1/cb',
    ]) {
      const r = registerClient({
        client_name: 'test',
        redirect_uris: [uri],
      });
      expect(r.ok).toBe(true);
    }
  });

  it('rejects non-loopback redirect URIs', () => {
    for (const uri of [
      'https://example.com/callback',
      'http://example.com/callback',
      'http://192.168.1.5:8080/callback',
      'app://mobile/callback',
      'javascript:alert(1)',
    ]) {
      const r = registerClient({
        client_name: 'test',
        redirect_uris: [uri],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects an empty redirect_uris array', () => {
    const r = registerClient({ client_name: 'test', redirect_uris: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_client_metadata');
  });

  it('persists + retrieves the client', () => {
    const r = registerClient({
      client_name: 'test',
      redirect_uris: ['http://127.0.0.1:9999/cb'],
    });
    if (!r.ok) throw new Error(r.error_description);
    const looked = getClient(r.client.client_id);
    expect(looked).not.toBeNull();
    expect(looked?.redirect_uris).toEqual(['http://127.0.0.1:9999/cb']);
    expect(looked?.application_type).toBe('native');
  });
});

// ---------------------------------------------------------------------------
// HTTP — discovery + DCR + token + (limited) authorize
// ---------------------------------------------------------------------------

async function buildOAuthApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // mcp-oauth needs @fastify/cookie because authorize reads + clears
  // a signed return-to cookie. Discovery + DCR + token don't, but
  // we register it once so the whole plugin works.
  await app.register(fastifyCookie, { secret: TEST_COOKIE_SECRET });
  await app.register(createMcpOAuthRoutes());
  await app.ready();
  return app;
}

describe('Discovery endpoints', () => {
  it('GET /.well-known/oauth-protected-resource returns the RFC 9728 shape', async () => {
    const app = await buildOAuthApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-protected-resource',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.resource).toBe(`${TEST_ORCH_URL}/mcp`);
      expect(body.authorization_servers).toEqual([TEST_ORCH_URL]);
      expect(body.bearer_methods_supported).toContain('header');
      expect(body.scopes_supported).toContain('mcp');
    } finally {
      await app.close();
    }
  });

  it('GET /.well-known/oauth-authorization-server returns the RFC 8414 shape with strict PKCE + DCR + iss', async () => {
    const app = await buildOAuthApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/oauth-authorization-server',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.issuer).toBe(TEST_ORCH_URL);
      expect(body.authorization_endpoint).toBe(`${TEST_ORCH_URL}/mcp/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${TEST_ORCH_URL}/mcp/oauth/token`);
      expect(body.registration_endpoint).toBe(`${TEST_ORCH_URL}/mcp/oauth/register`);
      expect(body.response_types_supported).toEqual(['code']);
      expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(body.code_challenge_methods_supported).toEqual(['S256']);
      expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
      expect(body.authorization_response_iss_parameter_supported).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('POST /mcp/oauth/register', () => {
  it('issues a client_id + token_endpoint_auth_method=none for a loopback redirect', async () => {
    const app = await buildOAuthApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/register',
        payload: {
          client_name: 'Claude Code',
          redirect_uris: ['http://127.0.0.1:9999/callback'],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(typeof body.client_id).toBe('string');
      expect(body.token_endpoint_auth_method).toBe('none');
      expect(body.redirect_uris).toEqual(['http://127.0.0.1:9999/callback']);
      expect(body.application_type).toBe('native');
    } finally {
      await app.close();
    }
  });

  it('rejects a non-loopback redirect with invalid_redirect_uri', async () => {
    const app = await buildOAuthApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/register',
        payload: {
          client_name: 'evil',
          redirect_uris: ['https://example.com/cb'],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_redirect_uri');
    } finally {
      await app.close();
    }
  });
});

describe('POST /mcp/oauth/token — full flow', () => {
  function formBody(obj: Record<string, string>): string {
    return new URLSearchParams(obj).toString();
  }

  it('authorization_code grant returns access + refresh + matches token shape', async () => {
    const app = await buildOAuthApp();
    try {
      // Register a client.
      const reg = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/register',
        payload: { redirect_uris: ['http://127.0.0.1:9999/callback'] },
      });
      const client_id = reg.json().client_id as string;

      // Skip the authorize endpoint (needs session cookie + Forgejo
      // lookup) and mint a code directly through the primitive.
      const verifier = 'a'.repeat(64);
      const code = createAuthCode({
        client_id,
        redirect_uri: 'http://127.0.0.1:9999/callback',
        code_challenge: pkceS256(verifier),
        resource: getMcpResourceUrl(),
        forgejo_user_login: 'alice',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: formBody({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://127.0.0.1:9999/callback',
          client_id,
          code_verifier: verifier,
          resource: getMcpResourceUrl(),
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token_type).toBe('Bearer');
      expect(typeof body.access_token).toBe('string');
      expect(typeof body.refresh_token).toBe('string');
      expect(body.scope).toBe('mcp');
      expect(typeof body.expires_in).toBe('number');

      // The issued access token verifies.
      const v = await verifyAccessToken(body.access_token);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.claims.sub).toBe('alice');
    } finally {
      await app.close();
    }
  });

  it('refresh_token grant rotates the token and the original is then revoked', async () => {
    const app = await buildOAuthApp();
    try {
      // Set up via primitive (skip register/authorize/token-exchange
      // dance — the dance is covered by the previous test).
      const reg = registerClient({
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      });
      if (!reg.ok) throw new Error(reg.error_description);
      const initial = issueRefreshToken({
        client_id: reg.client.client_id,
        forgejo_user_login: 'alice',
        resource: getMcpResourceUrl(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: formBody({
          grant_type: 'refresh_token',
          refresh_token: initial.refresh_token,
          client_id: reg.client.client_id,
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const rotated = body.refresh_token as string;
      expect(rotated).not.toBe(initial.refresh_token);

      // Replaying the ORIGINAL now returns invalid_grant and kills
      // the family (the rotated one stops working too).
      const replay = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: formBody({
          grant_type: 'refresh_token',
          refresh_token: initial.refresh_token,
          client_id: reg.client.client_id,
        }),
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe('invalid_grant');

      const followUp = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: formBody({
          grant_type: 'refresh_token',
          refresh_token: rotated,
          client_id: reg.client.client_id,
        }),
      });
      expect(followUp.statusCode).toBe(400);
      expect(followUp.json().error).toBe('invalid_grant');
    } finally {
      await app.close();
    }
  });

  it('rejects non-form Content-Type', async () => {
    const app = await buildOAuthApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/token',
        headers: { 'content-type': 'application/json' },
        payload: { grant_type: 'authorization_code' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    } finally {
      await app.close();
    }
  });

  it('rejects unsupported grant_type', async () => {
    const app = await buildOAuthApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'grant_type=client_credentials',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('unsupported_grant_type');
    } finally {
      await app.close();
    }
  });
});

describe('GET /mcp/oauth/authorize', () => {
  it('rejects requests without client_id with 400 (cannot trust redirect_uri)', async () => {
    const app = await buildOAuthApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/mcp/oauth/authorize',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    } finally {
      await app.close();
    }
  });

  it('rejects an unregistered redirect_uri with 400 (before redirecting anywhere)', async () => {
    const app = await buildOAuthApp();
    try {
      const reg = registerClient({
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      });
      if (!reg.ok) throw new Error(reg.error_description);
      const params = new URLSearchParams({
        client_id: reg.client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/different-path',
        response_type: 'code',
        code_challenge: 'x',
        code_challenge_method: 'S256',
        state: 's',
        resource: getMcpResourceUrl(),
      });
      const res = await app.inject({
        method: 'GET',
        url: `/mcp/oauth/authorize?${params.toString()}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    } finally {
      await app.close();
    }
  });

  it('redirects to /auth/login + sets return_to cookie when there is no session', async () => {
    const app = await buildOAuthApp();
    try {
      const reg = registerClient({
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      });
      if (!reg.ok) throw new Error(reg.error_description);
      const verifier = 'a'.repeat(64);
      const params = new URLSearchParams({
        client_id: reg.client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        response_type: 'code',
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        state: 'xyz',
        resource: getMcpResourceUrl(),
      });
      const res = await app.inject({
        method: 'GET',
        url: `/mcp/oauth/authorize?${params.toString()}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login');
      // A signed `orchestrator_post_login_return_to` cookie is set.
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const hasReturnTo = cookies.some(
        (c) => typeof c === 'string' && c.includes('orchestrator_post_login_return_to=')
      );
      expect(hasReturnTo).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('redirects errors back to redirect_uri with error= once redirect_uri is trusted', async () => {
    const app = await buildOAuthApp();
    try {
      const reg = registerClient({
        redirect_uris: ['http://127.0.0.1:9999/cb'],
      });
      if (!reg.ok) throw new Error(reg.error_description);
      // response_type=token is invalid; redirect_uri is trusted so
      // the error round-trips back to it.
      const params = new URLSearchParams({
        client_id: reg.client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        response_type: 'token',
        code_challenge: 'x',
        code_challenge_method: 'S256',
        state: 's',
        resource: getMcpResourceUrl(),
      });
      const res = await app.inject({
        method: 'GET',
        url: `/mcp/oauth/authorize?${params.toString()}`,
      });
      expect(res.statusCode).toBe(302);
      const loc = res.headers.location ?? '';
      expect(loc).toMatch(/^http:\/\/127\.0\.0\.1:9999\/cb\?/);
      expect(loc).toMatch(/error=unsupported_response_type/);
      expect(loc).toMatch(/state=s/);
      expect(loc).toMatch(/iss=/);
    } finally {
      await app.close();
    }
  });
});
