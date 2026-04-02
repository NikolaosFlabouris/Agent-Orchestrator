import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyOAuth2 from '@fastify/oauth2';

const FORGEJO_URL = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
const OAUTH_CLIENT_ID = process.env.FORGEJO_OAUTH_CLIENT_ID ?? '';
const OAUTH_CLIENT_SECRET = process.env.FORGEJO_OAUTH_CLIENT_SECRET ?? '';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8080';
const COOKIE_NAME = 'orchestrator_session';

interface SessionData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp ms
}

/**
 * Register OAuth2 plugin and auth routes.
 * If OAuth credentials are not configured, auth is disabled (dev mode).
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    app.log.warn(
      { event: 'auth_disabled' },
      'FORGEJO_OAUTH_CLIENT_ID/SECRET not set — authentication disabled'
    );
    return;
  }

  // Register @fastify/oauth2 with Forgejo endpoints
  await app.register(fastifyOAuth2, {
    name: 'forgejoOAuth2',
    scope: [],
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
      const session: SessionData = {
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? '',
        expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
      };

      reply.setCookie(COOKIE_NAME, JSON.stringify(session), {
        path: '/',
        httpOnly: true,
        signed: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });

      return reply.redirect('/');
    } catch (err) {
      app.log.error({ event: 'oauth_callback_failed', err }, 'OAuth callback failed');
      return reply.redirect('/auth/login');
    }
  });

  // Logout route
  app.get('/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.redirect('/');
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
