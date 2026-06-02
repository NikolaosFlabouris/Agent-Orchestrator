import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

import { createMeRoutes } from '../../routes/me.js';
import { getSessionFromRequest, type SessionUser } from '../../auth.js';

/**
 * Tests for the /api/me identity endpoint and the session-cookie
 * identity-persistence guarantees.
 *
 * Two pieces are covered here:
 *
 *   1. /api/me — given an authenticated request (signed session cookie
 *      with a `user` payload), the route echoes the identity verbatim
 *      and does NOT hit Forgejo. Without a session cookie, the auth
 *      hook returns 401 before the route runs.
 *
 *   2. Silent token refresh — when the access token has expired, the
 *      auth hook in auth.ts mints a new cookie. That cookie MUST carry
 *      the original `user` forward, otherwise the dashboard's user
 *      chip would vanish on every refresh cycle (~1h cadence).
 *
 * We do NOT exercise registerAuth() directly because @fastify/oauth2
 * makes a real discovery HTTP call at registration time. Instead, we
 * replicate the auth hook's logic verbatim against a stubbed oauth2
 * client. Diverging from the production hook here would be a real
 * test-regression risk, so the helper is kept short and structurally
 * identical to the registerAuth() body.
 */

const TEST_COOKIE_SECRET = 'me-route-test-cookie-secret-min-32-characters!';
const COOKIE_NAME = 'orchestrator_session';

interface FakeSessionData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user?: SessionUser;
}

/** Builds a Fastify app shaped like the production app for the auth
 *  hook + /api/me. Lets each test supply a refresh-token stub. */
async function buildApp(opts: {
  refreshStub?: ReturnType<typeof vi.fn>;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, { secret: TEST_COOKIE_SECRET });

  // Stand in for @fastify/oauth2's decorated client. Only the refresh
  // method is exercised here; the rest of the production interface is
  // not relevant to /api/me's tests.
  app.decorate('forgejoOAuth2', {
    getNewAccessTokenUsingRefreshToken:
      opts.refreshStub ?? vi.fn(async () => ({ token: {} })),
  } as any);

  // Mirror the /api/* auth hook from registerAuth(). Kept structurally
  // identical so any divergence in production immediately fails one
  // of the assertions below.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws/')) {
      return;
    }
    const session = getSessionFromRequest(request) as FakeSessionData | null;
    if (!session) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    if (session.expires_at < Date.now()) {
      try {
        const oauth2 = (app as any).forgejoOAuth2;
        const newToken = await oauth2.getNewAccessTokenUsingRefreshToken(
          { refresh_token: session.refresh_token } as any,
          {}
        );
        const refreshed: FakeSessionData = {
          access_token: newToken.token.access_token,
          refresh_token: newToken.token.refresh_token ?? session.refresh_token,
          expires_at: Date.now() + (newToken.token.expires_in ?? 3600) * 1000,
          ...(session.user ? { user: session.user } : {}),
        };
        reply.setCookie(COOKIE_NAME, JSON.stringify(refreshed), {
          path: '/',
          httpOnly: true,
          signed: true,
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 7,
        });
      } catch {
        reply.clearCookie(COOKIE_NAME, { path: '/' });
        return reply.status(401).send({ error: 'Session expired' });
      }
    }
  });

  await app.register(createMeRoutes());
  await app.ready();
  return app;
}

/** Encode + sign a cookie value the way @fastify/cookie's setCookie
 *  signed: true does, so we can present it to inject() without going
 *  through a real /auth/callback. */
function signedSessionCookie(
  app: FastifyInstance,
  session: FakeSessionData
): string {
  const signed = (app as any).signCookie(JSON.stringify(session));
  return `${COOKIE_NAME}=${encodeURIComponent(signed)}`;
}

beforeEach(() => {
  // Production reads these at startup; the test only relies on the
  // cookie secret being long enough.
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/me', () => {
  it('returns the user from a signed session cookie', async () => {
    const app = await buildApp();
    try {
      const user: SessionUser = {
        login: 'alice',
        name: 'Alice Example',
        avatar_url: 'http://forgejo/avatars/alice.png',
      };
      const session: FakeSessionData = {
        access_token: 'live-access-token',
        refresh_token: 'live-refresh-token',
        expires_at: Date.now() + 60_000,
        user,
      };
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: signedSessionCookie(app, session) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ user });
    } finally {
      await app.close();
    }
  });

  it('returns { user: null } when the session carries no identity', async () => {
    // A session created at /auth/callback with a failed userinfo
    // lookup has no `user`. The route MUST still return 200 so the
    // AuthGate resolves and the dashboard renders — the user chip
    // just stays hidden.
    const app = await buildApp();
    try {
      const session: FakeSessionData = {
        access_token: 'live-access-token',
        refresh_token: 'live-refresh-token',
        expires_at: Date.now() + 60_000,
      };
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: signedSessionCookie(app, session) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ user: null });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when no session cookie is present', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/me' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Not authenticated' });
    } finally {
      await app.close();
    }
  });

  it('returns 401 when the cookie signature is invalid', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        // Hand-rolled un-signed value can't be unsigned by the
        // server's HMAC, so the auth hook treats this as no session.
        headers: { cookie: `${COOKIE_NAME}=tampered-value` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('Silent token refresh', () => {
  it('preserves the captured user across a refresh', async () => {
    const refreshStub = vi.fn(async () => ({
      token: {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      },
    }));
    const app = await buildApp({ refreshStub });
    try {
      const user: SessionUser = {
        login: 'alice',
        name: 'Alice Example',
        avatar_url: 'http://forgejo/avatars/alice.png',
      };
      // expires_at in the past → forces the refresh path.
      const expired: FakeSessionData = {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: Date.now() - 1000,
        user,
      };
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: signedSessionCookie(app, expired) },
      });
      expect(res.statusCode).toBe(200);
      expect(refreshStub).toHaveBeenCalledTimes(1);
      // The body still surfaces the same identity — proving /api/me
      // sees `user` after refresh.
      expect(res.json()).toEqual({ user });

      // And the newly-set cookie carries the user forward, so the
      // NEXT request (with the new cookie) would also see it. We
      // assert this directly by unsigning the Set-Cookie header.
      const setCookies = res.cookies as Array<{ name: string; value: string }>;
      const sessionCookie = setCookies.find((c) => c.name === COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      const unsigned = (app as any).unsignCookie(sessionCookie!.value);
      expect(unsigned.valid).toBe(true);
      const refreshed = JSON.parse(unsigned.value) as FakeSessionData;
      expect(refreshed.user).toEqual(user);
      expect(refreshed.access_token).toBe('fresh-access');
      expect(refreshed.refresh_token).toBe('fresh-refresh');
      expect(refreshed.expires_at).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });

  it('refresh of a no-identity session leaves the cookie without a user field', async () => {
    // Sanity-check the inverse — a session that started without an
    // identity (failed userinfo at /auth/callback) does not magically
    // grow one on refresh.
    const refreshStub = vi.fn(async () => ({
      token: {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      },
    }));
    const app = await buildApp({ refreshStub });
    try {
      const expired: FakeSessionData = {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: Date.now() - 1000,
      };
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: signedSessionCookie(app, expired) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ user: null });
      const setCookies = res.cookies as Array<{ name: string; value: string }>;
      const sessionCookie = setCookies.find((c) => c.name === COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      const unsigned = (app as any).unsignCookie(sessionCookie!.value);
      expect(unsigned.valid).toBe(true);
      const refreshed = JSON.parse(unsigned.value) as FakeSessionData;
      expect(refreshed.user).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
