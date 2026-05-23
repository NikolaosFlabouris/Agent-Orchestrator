/**
 * MCP (Model Context Protocol) HTTP endpoint.
 *
 * Mounts the orchestrator's MCP server (`../mcp/server.ts`) onto
 * `/mcp` via the SDK's `StreamableHTTPServerTransport`, exposing the
 * `list_repos`, `list_agent_profiles`, and `create_task` tools to any
 * MCP client (Claude Code's plugin, …).
 *
 * Authentication:
 *   - Every request is gated by `validateBearer` which verifies an
 *     HS256 JWT (signature + iss + aud + exp) issued by the
 *     orchestrator's embedded OAuth Authorization Server in
 *     `../routes/mcp-oauth.ts`. Stateless — no DB hit on the hot
 *     path; the signing key comes from `../mcp/oauth/config.ts
 *     resolveSigningKey`.
 *   - On missing/invalid bearer we return 401 with
 *     `WWW-Authenticate: Bearer resource_metadata="…/.well-known/
 *     oauth-protected-resource"` so MCP clients can run discovery →
 *     DCR → authorize → token without any out-of-band hint from the
 *     operator.
 *   - The global `/api/*` + `/ws/*` auth hook in `auth.ts` is opt-in
 *     (early-returns on every other path), so `/mcp` is not also
 *     gated by the UI session cookie — bearer is the only credential
 *     this endpoint accepts.
 *
 * Transport + integration notes:
 *   - Stateless transport: one McpServer + one
 *     StreamableHTTPServerTransport per HTTP request, both closed in
 *     the `finally`. None of the three tools stream notifications
 *     between requests, so a session table would be wasted state.
 *   - The webhook route plugin (`./webhooks.ts`) registers an
 *     `application/json` buffer content-type parser inside its OWN
 *     plugin scope (Fastify encapsulates by default — the plugin is
 *     not wrapped with `fastify-plugin`), so that parser does NOT
 *     bleed into this plugin. We get the default JSON parser, which
 *     hands `request.body` to us as a parsed object — exactly what
 *     the SDK transport's `handleRequest(req, res, parsedBody)` wants.
 *   - `reply.hijack()` tells Fastify "I'll write the response myself";
 *     the SDK transport writes directly to `reply.raw` (Node
 *     `ServerResponse`).
 *
 * Gating:
 *   - `MCP_ENABLED=1` enables the transport. Anything else routes
 *     `/mcp` to a 503 diagnostic stub — operator opt-in, even though
 *     auth is now mandatory.
 */

import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type McpServerDeps } from '../mcp/server.js';
import { verifyAccessToken } from '../mcp/oauth/tokens.js';
import { getCanonicalOrchestratorUrl } from '../mcp/oauth/config.js';

/** Read `MCP_ENABLED` at plugin-registration time rather than module
 *  load. Anything other than the literal `"1"` keeps it disabled —
 *  including unset, empty string, or `"0"`. We want the explicit
 *  opt-in semantic, not the truthy-string semantic. Reading at
 *  registration also makes per-test env tweaks work without juggling
 *  module-cache invalidation. */
function isMcpEnabled(): boolean {
  return process.env.MCP_ENABLED === '1';
}

export function createMcpRoutes(deps: McpServerDeps): FastifyPluginAsync {
  return async function mcpRoutes(app: FastifyInstance): Promise<void> {
    if (!isMcpEnabled()) {
      // Register a tiny diagnostic endpoint so an operator probing
      // /mcp gets a clear "disabled" response instead of the SPA
      // fallback's index.html. No body parsing, no transport.
      app.all('/mcp', async (_request, reply) => {
        return reply.status(503).send({
          error: 'mcp_disabled',
          message:
            'The MCP endpoint is disabled. Set MCP_ENABLED=1 in the ' +
            'orchestrator environment and restart to enable. When ' +
            'enabled, /mcp requires a valid OAuth bearer JWT — clients ' +
            'discover the auth flow via the WWW-Authenticate header ' +
            'and the /.well-known/oauth-* endpoints (which remain ' +
            'reachable regardless of MCP_ENABLED).',
        });
      });
      app.log.info(
        { event: 'mcp_disabled' },
        'MCP endpoint registered as disabled — set MCP_ENABLED=1 to enable'
      );
      return;
    }

    app.log.info(
      { event: 'mcp_enabled' },
      'MCP endpoint enabled at /mcp (OAuth 2.1 bearer required)'
    );

    /** WWW-Authenticate value advertised on every 401 from /mcp.
     *  Points clients at the Protected Resource Metadata document so
     *  Claude Code can run its discovery → DCR → OAuth flow. The
     *  PRM lives in the mcp-oauth route plugin (index.ts registers
     *  that one too). */
    const wwwAuthenticate = (): string =>
      'Bearer ' +
      `resource_metadata="${getCanonicalOrchestratorUrl()}/.well-known/oauth-protected-resource"`;

    /** Validate the Authorization: Bearer header. Returns the
     *  verified claims on success, or null after writing a 401
     *  response to `reply`. Centralised so the four /mcp methods
     *  all agree on the failure shape. */
    const validateBearer = async (
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<true | false> => {
      const header = request.headers['authorization'];
      if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
        reply
          .status(401)
          .header('WWW-Authenticate', wwwAuthenticate())
          .send({
            error: 'invalid_token',
            error_description: 'Missing Bearer token',
          });
        return false;
      }
      const token = header.slice('Bearer '.length).trim();
      const result = await verifyAccessToken(token);
      if (!result.ok) {
        app.log.info(
          { event: 'mcp_bearer_invalid', reason: result.reason },
          `MCP bearer rejected: ${result.reason}`
        );
        reply
          .status(401)
          .header('WWW-Authenticate', wwwAuthenticate())
          .send({
            error: 'invalid_token',
            error_description: 'Token failed validation',
          });
        return false;
      }
      return true;
    };

    const handle = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!(await validateBearer(request, reply))) return;
      // One McpServer + one StreamableHTTPServerTransport per HTTP
      // request (stateless mode). Both close at the end of the
      // request — no shared state, no session table to leak across
      // tenants. The cost is the per-request `connect()` handshake;
      // for our tool-call workload (three small tools, no streaming)
      // this is negligible compared to the network round trip.
      const server = createMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });

      reply.hijack();

      try {
        await server.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (err) {
        app.log.error(
          {
            event: 'mcp_request_failed',
            method: request.method,
            err,
          },
          'MCP request handler threw'
        );
        // Best-effort error response if the SDK hasn't already
        // started writing one. (After SSE streaming begins,
        // headersSent is true and we leave it alone.)
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader('Content-Type', 'application/json');
          reply.raw.end(
            JSON.stringify({ error: 'mcp_internal_error' })
          );
        } else {
          try {
            reply.raw.end();
          } catch {
            /* socket already gone */
          }
        }
      } finally {
        // Best-effort cleanup. In stateless mode the transport has
        // already shut down by the time handleRequest resolves; this
        // is defence against future internal state and exceptional
        // exits.
        try {
          await transport.close();
        } catch {
          /* already closed */
        }
        try {
          await server.close();
        } catch {
          /* already closed */
        }
      }
    };

    // The MCP Streamable HTTP transport accepts:
    //   - POST: the standard JSON-RPC request channel.
    //   - GET:  SSE stream for server-initiated notifications. We expose
    //          it so a future stateful-mode upgrade is wire-compatible;
    //          stateless mode treats it as a no-op.
    //   - DELETE: explicit session termination (stateful mode only); we
    //          expose for spec compliance.
    app.post('/mcp', handle);
    app.get('/mcp', handle);
    app.delete('/mcp', handle);
  };
}
