/**
 * DCR (Dynamic Client Registration, RFC 7591) — client lifecycle.
 *
 * MCP clients (Claude Code, in our target deployment) auto-register
 * at first use by POSTing to `/mcp/oauth/register`. Each registration
 * gets a fresh opaque `client_id` and is restricted to **loopback
 * redirect URIs only** (RFC 8252) — the only category of redirect a
 * native MCP client can safely use without a pre-registered fixed
 * port.
 *
 * No `client_secret` is issued: per the Claude Code MCP-OAuth client
 * spike, the client always registers with
 * `token_endpoint_auth_method: "none"` (public client), and PKCE +
 * loopback-URI enforcement carry the security model.
 *
 * Persistence lives in `mcp_oauth_clients` (see db.ts createTables).
 */

import { randomBytes } from 'node:crypto';
import { getDb } from '../../db.js';

export interface RegisteredClient {
  client_id: string;
  client_name: string | null;
  /** Always loopback — enforced at registration time. */
  redirect_uris: string[];
  application_type: string;
  created_at: string;
}

export interface RegisterClientInput {
  client_name?: string;
  redirect_uris: string[];
  /** Forward-compatible field. We accept the value but only `"native"`
   *  is honoured today; anything else is normalised to `"native"`
   *  rather than rejected so a forward-rev client doesn't break. */
  application_type?: string;
}

export type RegisterClientResult =
  | { ok: true; client: RegisteredClient }
  | { ok: false; error: OAuthRegistrationError; error_description: string };

/** RFC 7591 §3.2.2 error codes we use. */
export type OAuthRegistrationError =
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata';

/** Loopback redirect URIs are the only category allowed for MCP
 *  native clients (RFC 8252 §7.3). We accept all three loopback
 *  forms: IPv4 literal, the literal `localhost` host, and the IPv6
 *  literal. Port is wildcard because Claude Code picks a random
 *  available port per session; path must be present (no bare host
 *  redirects). The literal `:port` is required to be numeric so
 *  malformed inputs fail loudly. */
const LOOPBACK_REDIRECT_RE = new RegExp(
  '^http://(?:' +
    '127\\.0\\.0\\.1|' +
    'localhost|' +
    '\\[::1\\]' +
    ')(?::\\d+)?/[^\\s]*$',
  'i'
);

function isLoopbackRedirect(uri: string): boolean {
  return LOOPBACK_REDIRECT_RE.test(uri);
}

/** Validate + persist a DCR registration. Returns the registered
 *  client on success, or a tagged OAuth error suitable for the
 *  endpoint to format into a `{ error, error_description }` JSON
 *  body with HTTP 400. */
export function registerClient(
  input: RegisterClientInput
): RegisterClientResult {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris must be a non-empty array of strings',
    };
  }
  for (const uri of input.redirect_uris) {
    if (typeof uri !== 'string' || !isLoopbackRedirect(uri)) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        error_description:
          `redirect_uri ${JSON.stringify(uri)} is not a loopback URL. ` +
          'Only http://127.0.0.1[:PORT]/PATH, http://localhost[:PORT]/PATH, ' +
          'or http://[::1][:PORT]/PATH are accepted (RFC 8252 §7.3).',
      };
    }
  }

  const client_id = randomBytes(16).toString('hex');
  const created_at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, application_type, created_at)
       VALUES (?, ?, ?, 'native', ?)`
    )
    .run(
      client_id,
      input.client_name ?? null,
      JSON.stringify(input.redirect_uris),
      created_at
    );

  return {
    ok: true,
    client: {
      client_id,
      client_name: input.client_name ?? null,
      redirect_uris: input.redirect_uris,
      application_type: 'native',
      created_at,
    },
  };
}

/** Look up a registered client by id. Hydrates `redirect_uris` from
 *  the JSON column. Returns null when not found OR when the row's
 *  JSON is malformed (defensive — operator hand-edit shouldn't
 *  crash the authorize endpoint). */
export function getClient(client_id: string): RegisteredClient | null {
  const row = getDb()
    .prepare(
      `SELECT client_id, client_name, redirect_uris, application_type, created_at
       FROM mcp_oauth_clients WHERE client_id = ?`
    )
    .get(client_id) as
    | {
        client_id: string;
        client_name: string | null;
        redirect_uris: string;
        application_type: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  let uris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed)) {
      uris = parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    return null;
  }
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: uris,
    application_type: row.application_type,
    created_at: row.created_at,
  };
}
