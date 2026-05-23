/**
 * MCP OAuth — discovery, DCR, authorize, and token endpoints.
 *
 * The orchestrator is the Authorization Server for /mcp. Five
 * endpoints live in this plugin:
 *
 *   - GET  /.well-known/oauth-protected-resource    (RFC 9728, PRM)
 *   - GET  /.well-known/oauth-authorization-server  (RFC 8414, AS metadata)
 *   - POST /mcp/oauth/register                      (RFC 7591, DCR)
 *   - GET  /mcp/oauth/authorize                     (RFC 6749 §4.1.1 + PKCE + RFC 8707)
 *   - POST /mcp/oauth/token                         (RFC 6749 §4.1.3 + §6 + PKCE)
 *
 * Wiring decisions (tied back to the Workstream C plan):
 *
 * 1. The plugin is encapsulated, so it can register a local
 *    `application/x-www-form-urlencoded` content-type parser on the
 *    token endpoint without disturbing JSON parsing elsewhere.
 *
 * 2. The global `/api/*` + `/ws/*` auth hook in auth.ts only fires on
 *    those prefixes, so none of these endpoints are intercepted by
 *    it. /mcp/oauth/authorize must still be human-authenticated —
 *    we read the orchestrator's session cookie directly via the
 *    exported `getSessionFromRequest` helper and, when absent,
 *    bounce through the existing Forgejo OAuth login flow with a
 *    signed `return_to` cookie that /auth/callback honours.
 *
 * 3. Tokens are HS256 JWTs (access) + opaque rotating refresh —
 *    primitives live in `../mcp/oauth/tokens.ts`. The client_id
 *    registry lives in `../mcp/oauth/clients.ts`. This file is just
 *    the HTTP plumbing: parse, validate, call primitive, format
 *    response.
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  getCanonicalOrchestratorUrl,
  getMcpResourceUrl,
  MCP_ACCESS_TOKEN_TTL_SEC,
  MCP_SCOPE,
} from '../mcp/oauth/config.js';
import {
  getClient,
  registerClient,
  type RegisterClientInput,
} from '../mcp/oauth/clients.js';
import {
  consumeAuthCode,
  createAuthCode,
  exchangeRefreshToken,
  issueAccessToken,
  issueRefreshToken,
} from '../mcp/oauth/tokens.js';
import {
  getSessionFromRequest,
  POST_LOGIN_RETURN_TO_COOKIE,
} from '../auth.js';

/** Forgejo URL used to resolve the user identity from the
 *  session's access token. The session cookie stores the Forgejo
 *  OAuth token; we exchange it for the user record on /authorize.
 *  Cached so we don't allocate a URL per request. */
const FORGEJO_URL = (process.env.FORGEJO_URL ?? 'http://forgejo:3000').replace(
  /\/+$/,
  ''
);

export function createMcpOAuthRoutes(): FastifyPluginAsync {
  return async function mcpOAuthRoutes(app: FastifyInstance): Promise<void> {
    // -- Local form-urlencoded parser, scoped to this plugin -----------
    // The token endpoint requires application/x-www-form-urlencoded per
    // OAuth 2.1 §3.2.1.2. Other plugins keep the default JSON parser.
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const parsed = Object.fromEntries(
            new URLSearchParams(body as string)
          );
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    // ── Protected Resource Metadata (RFC 9728) ──────────────────────
    app.get('/.well-known/oauth-protected-resource', async () => {
      return {
        resource: getMcpResourceUrl(),
        authorization_servers: [getCanonicalOrchestratorUrl()],
        bearer_methods_supported: ['header'],
        scopes_supported: [MCP_SCOPE],
      };
    });

    // ── Authorization Server Metadata (RFC 8414) ────────────────────
    app.get('/.well-known/oauth-authorization-server', async () => {
      const base = getCanonicalOrchestratorUrl();
      return {
        issuer: base,
        authorization_endpoint: `${base}/mcp/oauth/authorize`,
        token_endpoint: `${base}/mcp/oauth/token`,
        registration_endpoint: `${base}/mcp/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: [MCP_SCOPE],
      };
    });

    // ── DCR — POST /mcp/oauth/register ──────────────────────────────
    app.post('/mcp/oauth/register', async (request, reply) => {
      const body = request.body as Partial<RegisterClientInput> | undefined;
      if (!body || typeof body !== 'object') {
        return replyOAuthError(
          reply,
          400,
          'invalid_client_metadata',
          'Request body must be a JSON object'
        );
      }
      const result = registerClient({
        client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
        redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
        application_type:
          typeof body.application_type === 'string' ? body.application_type : undefined,
      });
      if (!result.ok) {
        return replyOAuthError(reply, 400, result.error, result.error_description);
      }
      // RFC 7591 §3.2.1 — 201 with the client metadata. We don't
      // issue a client_secret (public client) and don't currently
      // support registration_access_token / configuration_endpoint,
      // so the response is minimal.
      return reply.status(201).send({
        client_id: result.client.client_id,
        client_id_issued_at: Math.floor(
          new Date(result.client.created_at).getTime() / 1000
        ),
        client_name: result.client.client_name ?? undefined,
        redirect_uris: result.client.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: result.client.application_type,
      });
    });

    // ── Authorize — GET /mcp/oauth/authorize ────────────────────────
    app.get('/mcp/oauth/authorize', async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const client_id = stringOrEmpty(q.client_id);
      const response_type = stringOrEmpty(q.response_type);
      const redirect_uri = stringOrEmpty(q.redirect_uri);
      const code_challenge = stringOrEmpty(q.code_challenge);
      const code_challenge_method = stringOrEmpty(q.code_challenge_method);
      const state = stringOrEmpty(q.state);
      const resource = stringOrEmpty(q.resource);
      const scope = stringOrEmpty(q.scope);

      // Errors that happen BEFORE we can trust redirect_uri are
      // surfaced as a plain JSON 400 — per RFC 6749 §4.1.2.1, redirect
      // with `error=` is only used once the redirect_uri itself is
      // known-good. Anything else risks bouncing an attacker-supplied
      // URL.
      if (!client_id) {
        return replyOAuthError(reply, 400, 'invalid_request', 'client_id is required');
      }
      const client = getClient(client_id);
      if (!client) {
        return replyOAuthError(reply, 400, 'invalid_client', 'Unknown client_id');
      }
      if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
        return replyOAuthError(
          reply,
          400,
          'invalid_request',
          'redirect_uri must exactly match one of the URIs registered for this client'
        );
      }
      // From here on we can safely redirect errors back to the
      // client's redirect_uri (with `error=` query params), per spec.
      if (response_type !== 'code') {
        return redirectOAuthError(
          reply,
          redirect_uri,
          state,
          'unsupported_response_type',
          'Only response_type=code is supported'
        );
      }
      if (!code_challenge || code_challenge_method !== 'S256') {
        return redirectOAuthError(
          reply,
          redirect_uri,
          state,
          'invalid_request',
          'PKCE is required: code_challenge + code_challenge_method=S256'
        );
      }
      if (!resource || resource !== getMcpResourceUrl()) {
        return redirectOAuthError(
          reply,
          redirect_uri,
          state,
          'invalid_target',
          `resource must equal ${getMcpResourceUrl()} (RFC 8707)`
        );
      }
      if (scope && scope !== MCP_SCOPE) {
        return redirectOAuthError(
          reply,
          redirect_uri,
          state,
          'invalid_scope',
          `Only scope='${MCP_SCOPE}' is supported`
        );
      }

      // Resolve the human via the orchestrator session cookie. If
      // none, stash the current authorize URL in a signed cookie and
      // bounce through /auth/login → Forgejo OAuth; /auth/callback
      // reads the cookie and brings us back here.
      const session = getSessionFromRequest(request);
      if (!session) {
        const returnTo = request.url; // includes the query string
        reply.setCookie(POST_LOGIN_RETURN_TO_COOKIE, returnTo, {
          path: '/',
          httpOnly: true,
          signed: true,
          sameSite: 'lax',
          maxAge: 60 * 10, // 10 minutes — bounce window
        });
        return reply.redirect('/auth/login');
      }

      // Resolve the Forgejo user identity. The session cookie holds
      // the Forgejo OAuth access token; we call /api/v1/user to learn
      // who they are. A failure here means the Forgejo token is bad
      // (revoked or expired) — clear the cookie and bounce.
      let forgejoUserLogin: string;
      try {
        const userRes = await fetch(`${FORGEJO_URL}/api/v1/user`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!userRes.ok) {
          throw new Error(`Forgejo /user returned ${userRes.status}`);
        }
        const user = (await userRes.json()) as { login?: string };
        if (!user.login) throw new Error('Forgejo /user payload missing login');
        forgejoUserLogin = user.login;
      } catch (err) {
        app.log.warn(
          { event: 'mcp_authorize_user_lookup_failed', err },
          'Failed to resolve Forgejo user from session token'
        );
        return redirectOAuthError(
          reply,
          redirect_uri,
          state,
          'access_denied',
          'Could not resolve user identity from the orchestrator session.'
        );
      }

      // Mint the code + redirect back to the client.
      const code = createAuthCode({
        client_id,
        redirect_uri,
        code_challenge,
        resource,
        forgejo_user_login: forgejoUserLogin,
      });
      const target = new URL(redirect_uri);
      target.searchParams.set('code', code);
      if (state) target.searchParams.set('state', state);
      // RFC 9207 — include `iss` so the client can validate against
      // its recorded issuer (mix-up attack mitigation).
      target.searchParams.set('iss', getCanonicalOrchestratorUrl());
      return reply.redirect(target.toString());
    });

    // ── Token — POST /mcp/oauth/token ───────────────────────────────
    app.post('/mcp/oauth/token', async (request, reply) => {
      const ct = (request.headers['content-type'] ?? '').toString();
      if (!ct.startsWith('application/x-www-form-urlencoded')) {
        return replyOAuthError(
          reply,
          400,
          'invalid_request',
          'Content-Type must be application/x-www-form-urlencoded'
        );
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const grant_type = stringOrEmpty(body.grant_type);

      if (grant_type === 'authorization_code') {
        return handleAuthorizationCodeGrant(body, reply, app);
      }
      if (grant_type === 'refresh_token') {
        return handleRefreshTokenGrant(body, reply, app);
      }
      return replyOAuthError(
        reply,
        400,
        'unsupported_grant_type',
        'Supported grant_types: authorization_code, refresh_token'
      );
    });
  };
}

// ---------------------------------------------------------------------------
// Grant handlers
// ---------------------------------------------------------------------------

async function handleAuthorizationCodeGrant(
  body: Record<string, unknown>,
  reply: FastifyReply,
  app: FastifyInstance
): Promise<FastifyReply> {
  const code = stringOrEmpty(body.code);
  const redirect_uri = stringOrEmpty(body.redirect_uri);
  const client_id = stringOrEmpty(body.client_id);
  const code_verifier = stringOrEmpty(body.code_verifier);
  const resource = stringOrEmpty(body.resource);

  if (!code || !redirect_uri || !client_id || !code_verifier || !resource) {
    return replyOAuthError(
      reply,
      400,
      'invalid_request',
      'Required: code, redirect_uri, client_id, code_verifier, resource'
    );
  }

  const consumed = consumeAuthCode({
    code,
    client_id,
    redirect_uri,
    code_verifier,
    resource,
  });
  if (!consumed.ok) {
    app.log.info(
      { event: 'mcp_token_grant_failed', grant: 'authorization_code', reason: consumed.reason },
      `authorization_code rejected: ${consumed.reason}`
    );
    return replyOAuthError(reply, 400, 'invalid_grant', mapCodeReason(consumed.reason));
  }

  const refresh = issueRefreshToken({
    client_id,
    forgejo_user_login: consumed.forgejo_user_login,
    resource,
  });
  const access = await issueAccessToken({
    client_id,
    forgejo_user_login: consumed.forgejo_user_login,
    scope: MCP_SCOPE,
  });

  return reply.status(200).send({
    access_token: access.access_token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
    refresh_token: refresh.refresh_token,
    scope: MCP_SCOPE,
  });
}

async function handleRefreshTokenGrant(
  body: Record<string, unknown>,
  reply: FastifyReply,
  app: FastifyInstance
): Promise<FastifyReply> {
  const refresh_token = stringOrEmpty(body.refresh_token);
  const client_id = stringOrEmpty(body.client_id);

  if (!refresh_token || !client_id) {
    return replyOAuthError(
      reply,
      400,
      'invalid_request',
      'Required: refresh_token, client_id'
    );
  }

  const exchanged = exchangeRefreshToken({ refresh_token, client_id });
  if (!exchanged.ok) {
    app.log.info(
      { event: 'mcp_token_grant_failed', grant: 'refresh_token', reason: exchanged.reason },
      `refresh_token rejected: ${exchanged.reason}`
    );
    return replyOAuthError(reply, 400, 'invalid_grant', mapRefreshReason(exchanged.reason));
  }

  const newRefresh = issueRefreshToken({
    client_id,
    forgejo_user_login: exchanged.forgejo_user_login,
    resource: exchanged.resource,
    scope: exchanged.scope,
    family_id: exchanged.family_id,
  });
  const access = await issueAccessToken({
    client_id,
    forgejo_user_login: exchanged.forgejo_user_login,
    scope: exchanged.scope,
  });

  return reply.status(200).send({
    access_token: access.access_token,
    token_type: 'Bearer',
    expires_in: access.expires_in,
    refresh_token: newRefresh.refresh_token,
    scope: exchanged.scope,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function replyOAuthError(
  reply: FastifyReply,
  status: number,
  error: string,
  error_description: string
): FastifyReply {
  return reply.status(status).send({ error, error_description });
}

function redirectOAuthError(
  reply: FastifyReply,
  redirect_uri: string,
  state: string,
  error: string,
  error_description: string
): FastifyReply {
  let target: URL;
  try {
    target = new URL(redirect_uri);
  } catch {
    // Should be unreachable because we validate the URL came from
    // the registered set, but if not, fall back to JSON.
    return replyOAuthError(reply, 400, error, error_description);
  }
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', error_description);
  if (state) target.searchParams.set('state', state);
  target.searchParams.set('iss', getCanonicalOrchestratorUrl());
  return reply.redirect(target.toString());
}

function mapCodeReason(reason: string): string {
  // We expose a single `invalid_grant` to the client regardless of
  // the precise reason — leaking which check failed helps an attacker
  // narrow in. The server log line above carries the detail.
  return reason === 'expired'
    ? 'Authorization code expired'
    : 'Authorization code is invalid';
}

function mapRefreshReason(reason: string): string {
  return reason === 'revoked'
    ? 'Refresh token has been revoked; re-authorize required'
    : reason === 'expired'
      ? 'Refresh token expired'
      : 'Refresh token is invalid';
}
