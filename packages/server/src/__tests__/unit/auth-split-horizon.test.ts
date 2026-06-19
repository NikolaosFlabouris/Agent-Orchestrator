import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

/**
 * Split-horizon OIDC tests (two-tier URL model).
 *
 * The orchestrator and the host browser reach Forgejo at different
 * URLs: the browser follows the `authorize` redirect (FORGEJO_PUBLIC_URL)
 * while the orchestrator exchanges the code server-side against the
 * internal host (FORGEJO_URL). These tests pin both halves:
 *
 *   1. The `authorize` redirect targets FORGEJO_PUBLIC_URL.
 *   2. With only FORGEJO_URL set, the public host falls back to it
 *      (existing single-address deployments unchanged).
 *   3. The id_token `iss` is validated against FORGEJO_PUBLIC_URL, NOT
 *      the internal token host — covering the split-host token exchange.
 *
 * Env vars are read at module load in auth.ts, so each test sets the
 * environment and then dynamic-imports a fresh module instance via
 * vi.resetModules().
 */

const COOKIE_SECRET = 'cookie-test-secret-at-least-32-characters!';

const ENV_KEYS = [
  'FORGEJO_URL',
  'FORGEJO_PUBLIC_URL',
  'ORCHESTRATOR_URL',
  'FORGEJO_OAUTH_CLIENT_ID',
  'FORGEJO_OAUTH_CLIENT_SECRET',
  'NODE_ENV',
] as const;

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

/** Build an unsigned `header.payload.` JWT carrying the given claims.
 *  validateIdTokenIssuer never checks the signature, so `alg: none` is
 *  fine for these tests. */
function makeIdToken(claims: Record<string, unknown>): string {
  const seg = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg(claims)}.`;
}

/** Set env then dynamic-import a fresh auth module + build an app with
 *  the OAuth plugin registered. */
async function buildAuthApp(env: Record<string, string>): Promise<{
  app: FastifyInstance;
  auth: typeof import('../../auth.js');
}> {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.FORGEJO_OAUTH_CLIENT_ID = 'test-client-id';
  process.env.FORGEJO_OAUTH_CLIENT_SECRET = 'test-client-secret';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  vi.resetModules();
  const auth = await import('../../auth.js');
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, { secret: COOKIE_SECRET });
  await auth.registerAuth(app);
  await app.ready();
  return { app, auth };
}

describe('validateIdTokenIssuer', () => {
  it('accepts a matching issuer', async () => {
    const { validateIdTokenIssuer } = await import('../../auth.js');
    const token = makeIdToken({ iss: 'http://localhost:3000' });
    expect(validateIdTokenIssuer(token, 'http://localhost:3000')).toBe(true);
  });

  it('ignores trailing slashes on either side', async () => {
    const { validateIdTokenIssuer } = await import('../../auth.js');
    const token = makeIdToken({ iss: 'http://localhost:3000/' });
    expect(validateIdTokenIssuer(token, 'http://localhost:3000')).toBe(true);
  });

  it('rejects a mismatched issuer (e.g. the internal token host)', async () => {
    const { validateIdTokenIssuer } = await import('../../auth.js');
    const token = makeIdToken({ iss: 'http://forgejo:3000' });
    // Forgejo signs iss = public ROOT_URL; the internal host must NOT pass.
    expect(validateIdTokenIssuer(token, 'http://localhost:3000')).toBe(false);
  });

  it('passes through when there is no id_token (login must not hard-fail)', async () => {
    const { validateIdTokenIssuer } = await import('../../auth.js');
    expect(validateIdTokenIssuer(undefined, 'http://localhost:3000')).toBe(true);
  });

  it('rejects a present-but-unparseable id_token', async () => {
    const { validateIdTokenIssuer } = await import('../../auth.js');
    expect(validateIdTokenIssuer('not-a-jwt', 'http://localhost:3000')).toBe(false);
  });

  it('rejects an id_token with no iss claim', async () => {
    const { validateIdTokenIssuer } = await import('../../auth.js');
    const token = makeIdToken({ sub: 'alice' });
    expect(validateIdTokenIssuer(token, 'http://localhost:3000')).toBe(false);
  });
});

describe('authorize redirect (browser-facing host)', () => {
  it('redirects the browser to FORGEJO_PUBLIC_URL, not the internal host', async () => {
    const { app } = await buildAuthApp({
      FORGEJO_URL: 'http://forgejo-internal:3000',
      FORGEJO_PUBLIC_URL: 'http://forgejo-public.example:3000',
      ORCHESTRATOR_URL: 'http://localhost:8081',
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/auth/login' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(
        /^http:\/\/forgejo-public\.example:3000\/login\/oauth\/authorize\?/
      );
      // The internal host must never appear in a browser redirect.
      expect(res.headers.location).not.toContain('forgejo-internal');
    } finally {
      await app.close();
    }
  });

  it('falls back to FORGEJO_URL for the authorize host when FORGEJO_PUBLIC_URL is unset', async () => {
    const { app } = await buildAuthApp({
      FORGEJO_URL: 'http://forgejo-only:3000',
      ORCHESTRATOR_URL: 'http://localhost:8081',
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/auth/login' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(
        /^http:\/\/forgejo-only:3000\/login\/oauth\/authorize\?/
      );
    } finally {
      await app.close();
    }
  });
});

describe('/auth/callback id_token issuer validation', () => {
  /** Replace the plugin's code→token exchange with a stub that returns a
   *  token carrying the given id_token, so we exercise the callback's
   *  split-host iss check without a live Forgejo. */
  function stubTokenExchange(app: FastifyInstance, idToken: string): void {
    (app as unknown as { forgejoOAuth2: Record<string, unknown> }).forgejoOAuth2 =
      {
        getAccessTokenFromAuthorizationCodeFlow: async () => ({
          token: {
            access_token: 'access-abc',
            refresh_token: 'refresh-xyz',
            expires_in: 3600,
            id_token: idToken,
          },
        }),
      };
  }

  it('completes login when iss matches the public Forgejo URL', async () => {
    const { app, auth } = await buildAuthApp({
      FORGEJO_URL: 'http://forgejo-internal:3000',
      FORGEJO_PUBLIC_URL: 'http://forgejo-public.example:3000',
      ORCHESTRATOR_URL: 'http://localhost:8081',
    });
    // userinfo lookup is best-effort; stub it so it doesn't hit the network.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ preferred_username: 'alice' }),
      })
    );
    stubTokenExchange(
      app,
      makeIdToken({ iss: 'http://forgejo-public.example:3000' })
    );
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/callback?code=x&state=y',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/');
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      expect(cookies.some((c) => c.startsWith(`${auth.COOKIE_NAME}=`))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('rejects login when iss is the internal host instead of the public URL', async () => {
    const { app, auth } = await buildAuthApp({
      FORGEJO_URL: 'http://forgejo-internal:3000',
      FORGEJO_PUBLIC_URL: 'http://forgejo-public.example:3000',
      ORCHESTRATOR_URL: 'http://localhost:8081',
    });
    vi.stubGlobal('fetch', vi.fn());
    // iss = internal token host — must NOT be accepted.
    stubTokenExchange(app, makeIdToken({ iss: 'http://forgejo-internal:3000' }));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/callback?code=x&state=y',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login');
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
      // No session cookie minted on a rejected login.
      expect(cookies.some((c) => c.startsWith(`${auth.COOKIE_NAME}=` ) && !c.startsWith(`${auth.COOKIE_NAME}=;`))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
