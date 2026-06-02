import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

import { COOKIE_NAME, registerLogoutRoute } from '../../auth.js';

/**
 * Tests for the hardened `POST /auth/logout` route.
 *
 * Covers the two security properties of the logout hardening:
 *   1. CSRF: logout is POST-only — a GET no longer ends a session.
 *   2. Token revocation: on logout we best-effort revoke the OAuth
 *      tokens at Forgejo's RFC 7009 endpoint, and a failed/absent
 *      endpoint never blocks the cookie clear + redirect.
 *
 * The route is registered in isolation via registerLogoutRoute so we
 * don't have to stand up the full @fastify/oauth2 plugin (which does
 * OIDC discovery against Forgejo at registration time).
 */

const TEST_COOKIE_SECRET = 'cookie-test-secret-at-least-32-characters!';

interface TestSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

async function buildLogoutApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie, { secret: TEST_COOKIE_SECRET });
  registerLogoutRoute(app);
  await app.ready();
  return app;
}

/** Build the `Cookie` header value for a valid signed session. */
function signedSessionCookie(session: TestSession): string {
  const signed = fastifyCookie.sign(JSON.stringify(session), TEST_COOKIE_SECRET);
  return `${COOKIE_NAME}=${encodeURIComponent(signed)}`;
}

/** Does the (possibly array-valued) set-cookie header clear the
 *  session cookie? clearCookie emits an empty value with an epoch
 *  expiry. */
function clearsSessionCookie(setCookie: string | string[] | undefined): boolean {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.some(
    (c) =>
      c.startsWith(`${COOKIE_NAME}=;`) &&
      /Expires=Thu, 01 Jan 1970/.test(c)
  );
}

const VALID_SESSION: TestSession = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_at: 0,
};

beforeEach(() => {
  process.env.COOKIE_SECRET = TEST_COOKIE_SECRET;
});

afterEach(() => {
  delete process.env.COOKIE_SECRET;
  vi.restoreAllMocks();
});

describe('POST /auth/logout', () => {
  it('clears the session cookie and 302-redirects to /signed-out', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildLogoutApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: signedSessionCookie(VALID_SESSION) },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/signed-out');
      expect(clearsSessionCookie(res.headers['set-cookie'])).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('attempts RFC 7009 revocation for both the refresh and access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildLogoutApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: signedSessionCookie(VALID_SESSION) },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Every call targets Forgejo's revocation endpoint with a POST.
      for (const call of fetchMock.mock.calls) {
        expect(String(call[0])).toMatch(/\/login\/oauth\/revoke$/);
        expect(call[1].method).toBe('POST');
      }
      const bodies = fetchMock.mock.calls.map((c) => String(c[1].body));
      expect(
        bodies.some(
          (b) => b.includes('token=refresh-xyz') && b.includes('token_type_hint=refresh_token')
        )
      ).toBe(true);
      expect(
        bodies.some(
          (b) => b.includes('token=access-abc') && b.includes('token_type_hint=access_token')
        )
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('still clears the cookie and redirects when revocation rejects (network error)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildLogoutApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: signedSessionCookie(VALID_SESSION) },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/signed-out');
      expect(clearsSessionCookie(res.headers['set-cookie'])).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('still clears the cookie and redirects when the revocation endpoint is absent (404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildLogoutApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: signedSessionCookie(VALID_SESSION) },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/signed-out');
      expect(clearsSessionCookie(res.headers['set-cookie'])).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('completes without attempting revocation when there is no session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildLogoutApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/auth/logout' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/signed-out');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /auth/logout', () => {
  it('does not log out — no POST route means GET 404s and the cookie survives', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildLogoutApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/logout',
        headers: { cookie: signedSessionCookie(VALID_SESSION) },
      });
      // GET is not a registered method for this path.
      expect(res.statusCode).toBe(404);
      expect(clearsSessionCookie(res.headers['set-cookie'])).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
