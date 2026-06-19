import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyOAuth2 from '@fastify/oauth2';

/** Internal (container-facing) Forgejo URL. Used for ALL server-side
 *  calls: OIDC token exchange + userinfo, REST API, and git. Reachable
 *  from inside the container network (a compose service name like
 *  `forgejo`), not necessarily from the host browser. */
const FORGEJO_URL = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
/** Browser-facing Forgejo URL for the split-horizon OIDC flow: the host
 *  the user's browser is redirected to for the `authorize` step, AND the
 *  `iss` Forgejo signs into the id_token (Forgejo sets `iss = ROOT_URL`).
 *  Falls back to FORGEJO_URL so existing single-address (e.g. LAN-IP)
 *  deployments keep working unchanged. */
const FORGEJO_PUBLIC_URL = process.env.FORGEJO_PUBLIC_URL ?? FORGEJO_URL;
const OAUTH_CLIENT_ID = process.env.FORGEJO_OAUTH_CLIENT_ID ?? '';
const OAUTH_CLIENT_SECRET = process.env.FORGEJO_OAUTH_CLIENT_SECRET ?? '';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8080';

/** Forgejo's OAuth2/OIDC endpoint paths. Stable across the Forgejo
 *  versions we target; split out as constants because we configure the
 *  authorize and token hosts separately (split-horizon) rather than
 *  letting single-issuer discovery derive both from one URL. */
const FORGEJO_AUTHORIZE_PATH = '/login/oauth/authorize';
const FORGEJO_TOKEN_PATH = '/login/oauth/access_token';
/** Name of the signed, httpOnly session cookie. Exported so tests can
 *  build a valid session for the logout route. */
export const COOKIE_NAME = 'orchestrator_session';
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
    // PKCE: single-issuer discovery used to auto-select this from
    // Forgejo's published metadata. The split-horizon config below
    // configures the endpoints explicitly (no discovery), so request
    // S256 directly — Forgejo supports it.
    pkce: 'S256',
    credentials: {
      client: {
        id: OAUTH_CLIENT_ID,
        secret: OAUTH_CLIENT_SECRET,
      },
      // Split-horizon OIDC. Discovery couples every endpoint to one
      // issuer host, but no single Forgejo URL is reachable from both
      // the host browser AND inside the container network. So configure
      // the two hosts explicitly:
      //   * authorizeHost = FORGEJO_PUBLIC_URL — the browser follows
      //     this redirect, so it must be browser-reachable.
      //   * tokenHost     = FORGEJO_URL — the orchestrator exchanges the
      //     code server-side, so it must be container-reachable.
      // (`@fastify/oauth2` / `simple-oauth2` support separate
      // authorizeHost / tokenHost for exactly this case.)
      auth: {
        authorizeHost: FORGEJO_PUBLIC_URL,
        authorizePath: FORGEJO_AUTHORIZE_PATH,
        tokenHost: FORGEJO_URL,
        tokenPath: FORGEJO_TOKEN_PATH,
      },
    },
    tokenRequestParams: {
      redirect_uri: `${ORCHESTRATOR_URL}/auth/callback`,
    },
    startRedirectPath: '/auth/login',
    callbackUri: `${ORCHESTRATOR_URL}/auth/callback`,
  });

  // Callback route — exchanges code for token, stores in signed cookie
  app.get('/auth/callback', async (request, reply) => {
    try {
      const oauth2 = (app as any).forgejoOAuth2;
      const tokenResult =
        await oauth2.getAccessTokenFromAuthorizationCodeFlow(request);

      const token = tokenResult.token;

      // Split-horizon OIDC issuer check. The code was exchanged against
      // the internal token host (FORGEJO_URL), but Forgejo signs the
      // id_token `iss` as its ROOT_URL — the public/browser-facing URL —
      // so validate against FORGEJO_PUBLIC_URL, NOT the host we just
      // talked to. Rejects a token minted by an unexpected issuer.
      if (!validateIdTokenIssuer(token.id_token, FORGEJO_PUBLIC_URL)) {
        app.log.error(
          { event: 'oauth_iss_mismatch' },
          'OIDC id_token issuer did not match the expected public Forgejo URL'
        );
        return reply.redirect('/auth/login');
      }

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

  registerLogoutRoute(app);

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

/**
 * Registers the `POST /auth/logout` route.
 *
 * Pulled out of registerAuth so it can be exercised in isolation by
 * tests — standing up the full @fastify/oauth2 plugin performs OIDC
 * discovery against Forgejo at registration time, which we don't want
 * in a unit test of the logout flow.
 *
 * Why POST: a state-changing GET is reachable via a top-level cross-
 * origin navigation (a hostile link or <img src> would suffice), which
 * would let any other origin force a logout. POST + `sameSite=lax` on
 * the session cookie closes that gap: a cross-site form POST carries
 * no session cookie, so the handler runs without a session and the
 * attacker's POST is a no-op for the victim. No CSRF token needed.
 *
 * The handler reads nothing from the request body, but a browser form
 * submit sends `application/x-www-form-urlencoded` by default (even with
 * an empty body), and Fastify rejects a POST whose Content-Type has no
 * registered parser with a 415 *before* the handler runs — regardless of
 * whether the handler touches the body. So the route's context must have
 * a urlencoded parser. We register one scoped to an encapsulated plugin
 * (mirroring routes/mcp-oauth.ts) rather than polluting the root context.
 *
 * Logout stays soft: we best-effort revoke the OAuth tokens at Forgejo
 * so they don't remain valid server-side until natural expiry, then
 * clear the cookie. We do NOT bounce through Forgejo's SSO logout —
 * signing out of the orchestrator must not sign the user out of
 * Forgejo.
 */
export function registerLogoutRoute(app: FastifyInstance): void {
  void app.register(async (scoped) => {
    // The Sign out control is an HTML <form method="post">, which the
    // browser submits as application/x-www-form-urlencoded. The handler
    // ignores the parsed value, but Fastify still needs a parser for that
    // content-type registered in this context or it 415s before the
    // handler runs. Scoped to this plugin so the root context keeps only
    // the default JSON/text parsers.
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    scoped.post('/auth/logout', async (request, reply) => {
      const session = getSession(request);
      if (session) {
        await revokeForgejoTokens(app, session);
      }
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return reply.redirect('/signed-out');
    });
  });
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

/** Best-effort RFC 7009 revocation against Forgejo's
 *  `/login/oauth/revoke`. Called on logout so the OAuth tokens stop
 *  being valid server-side immediately rather than lingering until
 *  natural expiry. Failure here MUST NOT block logout: a 404 (older
 *  Forgejo without the endpoint), a network error, or any non-2xx
 *  response is logged and swallowed. RFC 7009 says one token per
 *  request, so we issue separate calls for the refresh token and the
 *  access token. */
async function revokeForgejoTokens(
  app: FastifyInstance,
  session: SessionData
): Promise<void> {
  const tokens: Array<{ token: string; hint: 'refresh_token' | 'access_token' }> = [];
  if (session.refresh_token) {
    tokens.push({ token: session.refresh_token, hint: 'refresh_token' });
  }
  if (session.access_token) {
    tokens.push({ token: session.access_token, hint: 'access_token' });
  }
  for (const { token, hint } of tokens) {
    try {
      const body = new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      });
      // Hard deadline so a stalled connection (accepted then hung —
      // network partition, overloaded Forgejo) can't delay the logout
      // redirect. The AbortError surfaces as a thrown rejection and is
      // caught + swallowed below like any other failure.
      const res = await fetch(`${FORGEJO_URL}/login/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 404) {
        // Older Forgejo build without RFC 7009 support — nothing to do.
        app.log.debug(
          { event: 'oauth_revoke_unavailable', hint },
          'Forgejo revocation endpoint not present; skipping'
        );
        return;
      }
      if (!res.ok) {
        app.log.debug(
          { event: 'oauth_revoke_failed', hint, status: res.status },
          'Forgejo token revocation returned non-2xx; ignoring'
        );
      }
    } catch (err) {
      app.log.debug(
        { event: 'oauth_revoke_error', hint, err },
        'Forgejo token revocation threw; ignoring'
      );
    }
  }
}

/**
 * Validate the OIDC id_token issuer for the split-horizon flow.
 *
 * Forgejo signs `iss` into the id_token as its configured ROOT_URL,
 * which is the browser-facing/public URL — so the expected value is
 * `FORGEJO_PUBLIC_URL`, NOT the internal token host the orchestrator
 * exchanged the code against. This is the check that makes the
 * split-horizon safe: the browser and the orchestrator reach Forgejo
 * at different URLs, but the token must still come from the one
 * Forgejo we trust.
 *
 * Returns:
 *   - true  when there is no id_token to check. Forgejo always issues
 *           one with the `openid` scope, but a missing token must not
 *           hard-fail login — keeps older/edge setups working.
 *   - true  when the token's `iss` matches `expectedPublicUrl`
 *           (trailing slashes ignored on both sides).
 *   - false when an id_token is present but its `iss` is missing,
 *           unparseable, or doesn't match.
 *
 * The signature is NOT verified: the id_token arrives over the
 * server-side token-exchange channel straight from Forgejo (it never
 * passes through the browser), so we trust the transport and only
 * confirm the minting issuer.
 *
 * Exported so the split-horizon behaviour can be unit-tested without
 * standing up the full OAuth plugin.
 */
export function validateIdTokenIssuer(
  idToken: string | undefined,
  expectedPublicUrl: string
): boolean {
  if (!idToken) return true;
  const parts = idToken.split('.');
  if (parts.length < 2) return false;
  let iss: unknown;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    ) as { iss?: unknown };
    iss = payload.iss;
  } catch {
    return false;
  }
  if (typeof iss !== 'string') return false;
  const strip = (u: string): string => u.replace(/\/+$/, '');
  return strip(iss) === strip(expectedPublicUrl);
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
