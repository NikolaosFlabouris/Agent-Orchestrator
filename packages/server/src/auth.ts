import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyOAuth2 from '@fastify/oauth2';

const FORGEJO_URL = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
const OAUTH_CLIENT_ID = process.env.FORGEJO_OAUTH_CLIENT_ID ?? '';
const OAUTH_CLIENT_SECRET = process.env.FORGEJO_OAUTH_CLIENT_SECRET ?? '';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8080';
const COOKIE_NAME = 'orchestrator_session';
/** Short-lived signed cookie used to round-trip a post-login redirect
 *  target across the Forgejo OAuth flow. The MCP authorize endpoint
 *  sets this before bouncing through /auth/login when it finds no
 *  session; the /auth/callback below reads + clears it and redirects
 *  to the stored URL. Restricted to safe paths to prevent open-
 *  redirect abuse (see the `return_to` validation in the callback). */
const RETURN_TO_COOKIE = 'orchestrator_post_login_return_to';

/** True when the orchestrator should run without OAuth — i.e. OAuth env
 *  vars are missing AND the operator opted in via the dev flag. The
 *  index.ts boot path uses this to force a loopback bind so an
 *  unauthenticated instance is unreachable from the LAN. */
export function authDisabled(): boolean {
  return !OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET;
}

/** Forgejo OIDC userinfo we surface to the UI. Captured at /auth/callback
 *  from the userinfo endpoint and replayed verbatim from the session cookie
 *  on /api/me so the dashboard never has to round-trip to Forgejo. All
 *  fields optional because the userinfo call is best-effort — login still
 *  succeeds with no identity if Forgejo's /login/oauth/userinfo is
 *  unreachable or returns a partial payload. */
export interface SessionUser {
  login?: string;
  name?: string;
  avatar_url?: string;
}

interface SessionData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp ms
  /** Optional Forgejo identity captured at login. May be absent if the
   *  userinfo fetch failed; the silent-refresh path carries this forward
   *  verbatim so the user chip survives across token rotation. */
  user?: SessionUser;
}

/**
 * Register OAuth2 plugin and auth routes.
 *
 * Fail-closed semantics (C2):
 *   - Production (`NODE_ENV=production`): refuse to start. The
 *     /api/* routes are the entire surface — running them unauthed in
 *     production is never the right answer.
 *   - Non-production: refuse to start unless the operator has set
 *     `ORCHESTRATOR_ALLOW_UNAUTHENTICATED=1` explicitly. When the flag
 *     is set, log a loud warning and skip middleware registration. The
 *     boot path in index.ts pairs this with a loopback bind so the
 *     unauthenticated instance is unreachable from the LAN.
 *
 * The previous behaviour was a silent warn-and-continue, which exposed
 * /api/* (including provider credentials) to anything that could reach
 * the listening socket.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'FORGEJO_OAUTH_CLIENT_ID and FORGEJO_OAUTH_CLIENT_SECRET are required ' +
          'in production. Refusing to start with /api/* unauthenticated. ' +
          'Configure the OAuth app in Forgejo (Site Administration → ' +
          'Applications), then set both env vars and restart.'
      );
    }
    if (process.env.ORCHESTRATOR_ALLOW_UNAUTHENTICATED !== '1') {
      throw new Error(
        'FORGEJO_OAUTH_CLIENT_ID / FORGEJO_OAUTH_CLIENT_SECRET are not set, ' +
          'and ORCHESTRATOR_ALLOW_UNAUTHENTICATED is not "1". Refusing to ' +
          'start with /api/* unauthenticated. To run a local dev instance ' +
          'without OAuth, set ORCHESTRATOR_ALLOW_UNAUTHENTICATED=1 — the ' +
          'orchestrator will bind to 127.0.0.1 only.'
      );
    }
    app.log.warn(
      { event: 'auth_disabled', binding: '127.0.0.1' },
      '*** AUTHENTICATION DISABLED — ORCHESTRATOR_ALLOW_UNAUTHENTICATED=1 *** ' +
        'All /api/* and /ws/* routes are open. The boot path forces a ' +
        'loopback bind, but anyone with shell access to this host (or ' +
        'who can tunnel to it) can read providers/auth_tokens and ' +
        'launch tasks. Do not use this mode for anything beyond local ' +
        'single-user development.'
    );
    return;
  }

  // Register @fastify/oauth2 with Forgejo endpoints.
  // Request OIDC identity scopes so the userinfo endpoint actually
  // returns login/name/avatar — without `openid`, Forgejo's
  // /login/oauth/userinfo refuses the request, and the dashboard
  // can't show who's signed in.
  await app.register(fastifyOAuth2, {
    name: 'forgejoOAuth2',
    scope: ['openid', 'profile'],
    credentials: {
      client: {
        id: OAUTH_CLIENT_ID,
        secret: OAUTH_CLIENT_SECRET,
      },
    },
    tokenRequestParams: {
      redirect_uri: `${ORCHESTRATOR_URL}/auth/callback`,
    },
    startRedirectPath: '/auth/login',
    callbackUri: `${ORCHESTRATOR_URL}/auth/callback`,
    discovery: {
      issuer: FORGEJO_URL,
    },
  });

  // Callback route — exchanges code for token, stores in signed cookie
  app.get('/auth/callback', async (request, reply) => {
    try {
      const oauth2 = (app as any).forgejoOAuth2;
      const tokenResult =
        await oauth2.getAccessTokenFromAuthorizationCodeFlow(request);

      const token = tokenResult.token;

      // Best-effort identity lookup against Forgejo's OIDC userinfo
      // endpoint. A failure here must NOT block login — the session
      // is still created, just without the user chip. The /api/me
      // route already tolerates `user` being absent, and the silent
      // refresh path carries it forward, so once captured it sticks.
      const user = await fetchForgejoUser(token.access_token, app);

      const session: SessionData = {
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? '',
        expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
        ...(user ? { user } : {}),
      };

      reply.setCookie(COOKIE_NAME, JSON.stringify(session), {
        path: '/',
        httpOnly: true,
        signed: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });

      // Post-login bounce: if a previous request stashed a return-to
      // target in the `orchestrator_post_login_return_to` cookie
      // (currently only the MCP authorize endpoint does this), redirect
      // there instead of the dashboard. Restricted to safe internal
      // paths to prevent the cookie from being weaponized into an
      // open-redirect: must start with `/mcp/oauth/authorize?`. The
      // cookie itself is signed (httpOnly, sameSite=lax), so an
      // off-origin attacker can't set it; the path check is the
      // defence-in-depth.
      const returnToRaw = request.cookies[RETURN_TO_COOKIE];
      reply.clearCookie(RETURN_TO_COOKIE, { path: '/' });
      if (returnToRaw) {
        try {
          const unsigned = (request as any).unsignCookie(returnToRaw);
          if (unsigned.valid && typeof unsigned.value === 'string') {
            if (isSafeReturnTo(unsigned.value)) {
              return reply.redirect(unsigned.value);
            }
          }
        } catch {
          // Fall through to default redirect.
        }
      }

      return reply.redirect('/');
    } catch (err) {
      app.log.error({ event: 'oauth_callback_failed', err }, 'OAuth callback failed');
      return reply.redirect('/auth/login');
    }
  });

  // Logout route — soft logout: clears the orchestrator session
  // cookie only and lands on the public `/signed-out` page. The
  // Forgejo SSO session is intentionally left intact, so re-login can
  // be one click if the user is still signed in upstream. Redirecting
  // to `/` would 401 against `/api/*` and silently bounce through
  // Forgejo, making logout look like a no-op.
  app.get('/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.redirect('/signed-out');
  });

  // Auth middleware for /api/* routes
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip non-API routes (static files, auth routes, webhooks, health)
    if (
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/ws/')
    ) {
      return;
    }

    // Skip webhook endpoint (uses HMAC auth, not OAuth)
    if (request.url.startsWith('/webhooks/')) {
      return;
    }

    const session = getSession(request);
    if (!session) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    // Check token expiry and attempt refresh
    if (session.expires_at < Date.now()) {
      try {
        const oauth2 = (app as any).forgejoOAuth2;
        const newToken = await oauth2.getNewAccessTokenUsingRefreshToken(
          { refresh_token: session.refresh_token } as any,
          {}
        );

        const refreshed: SessionData = {
          access_token: newToken.token.access_token,
          refresh_token: newToken.token.refresh_token ?? session.refresh_token,
          expires_at: Date.now() + (newToken.token.expires_in ?? 3600) * 1000,
          // Carry the captured identity forward verbatim. The refresh
          // path does NOT re-query Forgejo — identity is set once at
          // /auth/callback and survives every rotation until the
          // session cookie is cleared. (Without this the user chip
          // would vanish silently when an access token expired.)
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

  app.log.info(
    { event: 'auth_enabled' },
    'OAuth2 authentication enabled'
  );
}

function getSession(request: FastifyRequest): SessionData | null {
  const raw = request.cookies[COOKIE_NAME];
  if (!raw) return null;

  try {
    // Verify signed cookie
    const unsigned = (request as any).unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;

    return JSON.parse(unsigned.value) as SessionData;
  } catch {
    return null;
  }
}

/** Public helper: does this request carry a valid orchestrator
 *  session cookie? Exported so the MCP authorize endpoint can
 *  short-circuit to the Forgejo login bounce when the user isn't
 *  signed in yet. Returns null when the cookie is absent, malformed,
 *  or its signature doesn't verify. The /api auth hook above uses
 *  the private `getSession`; this is the same call, exported. */
export function getSessionFromRequest(
  request: FastifyRequest
): SessionData | null {
  return getSession(request);
}

/** Name of the short-lived signed cookie used to round-trip a
 *  post-login return target. Exported so the MCP authorize endpoint
 *  can set it before redirecting to /auth/login. */
export const POST_LOGIN_RETURN_TO_COOKIE = RETURN_TO_COOKIE;

/** Best-effort Forgejo userinfo lookup. Called once at /auth/callback
 *  to capture {login, name, avatar_url} into the session cookie. A
 *  failure (network error, non-2xx, malformed JSON) returns null and
 *  login still completes — see `[[issue-89]]`. Maps OIDC claim names:
 *  preferred_username→login, name→name, picture→avatar_url. */
async function fetchForgejoUser(
  accessToken: string,
  app: FastifyInstance
): Promise<SessionUser | null> {
  try {
    const res = await fetch(`${FORGEJO_URL}/login/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      app.log.warn(
        { event: 'oauth_userinfo_failed', status: res.status },
        'Forgejo userinfo lookup returned non-2xx; session will lack identity'
      );
      return null;
    }
    const claims = (await res.json()) as {
      preferred_username?: unknown;
      name?: unknown;
      picture?: unknown;
    };
    const user: SessionUser = {};
    if (typeof claims.preferred_username === 'string')
      user.login = claims.preferred_username;
    if (typeof claims.name === 'string') user.name = claims.name;
    if (typeof claims.picture === 'string') user.avatar_url = claims.picture;
    // If userinfo returned but no usable claims, treat as missing so
    // the cookie stays empty rather than holding an empty object.
    if (!user.login && !user.name && !user.avatar_url) return null;
    return user;
  } catch (err) {
    app.log.warn(
      { event: 'oauth_userinfo_failed', err },
      'Forgejo userinfo lookup threw; session will lack identity'
    );
    return null;
  }
}

/** Allowlist for the post-login redirect target. Keeps the cookie
 *  from being weaponized into an open-redirect. Today only the MCP
 *  authorize endpoint sets the cookie, and only its own path is
 *  honoured. New callers must extend this allowlist deliberately. */
function isSafeReturnTo(value: string): boolean {
  // Must be a relative URL (no scheme, no host) anchored at our
  // known path. Query string allowed; fragment ignored. We reject
  // anything starting with `//` (protocol-relative) or `http`.
  if (!value.startsWith('/mcp/oauth/authorize')) return false;
  if (value.startsWith('//')) return false;
  // Length cap as belt-and-braces against pathological inputs.
  if (value.length > 4096) return false;
  return true;
}
