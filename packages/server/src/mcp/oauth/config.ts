/**
 * MCP OAuth configuration: signing-key resolution, canonical URLs,
 * and protocol timing constants.
 *
 * Centralised here so every endpoint (PRM, AS metadata, authorize,
 * token, /mcp bearer validation) sees the exact same canonical URL
 * strings — the OAuth spec requires byte-equal issuer comparison
 * (RFC 3986 §6.2.1, also called out as a strict gotcha by the
 * Claude Code MCP-OAuth client spike), so a single source of truth
 * prevents drift between, say, `iss` in AS metadata and the `iss`
 * claim in issued JWTs.
 */

import { hkdfSync } from 'node:crypto';

/** HS256 dev fallback. Only used when the operator has opted into
 *  degraded security via `ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET=1`
 *  AND NODE_ENV !== 'production'. The orchestrator's boot path forces
 *  a 127.0.0.1 bind in that case, so a degraded MCP instance is
 *  unreachable from the LAN regardless. */
const DEV_SIGNING_SECRET_PLACEHOLDER =
  'orchestrator-mcp-dev-secret-change-in-production-please';

/** Access token TTL (seconds). One hour is the recommended default
 *  for OAuth-protected APIs — short enough that a leaked token can't
 *  be replayed for long, long enough that rotation overhead doesn't
 *  dominate. Claude Code's MCP client refreshes proactively at ~80%
 *  of `expires_in`, so the actual refresh cadence is ~48 minutes. */
export const MCP_ACCESS_TOKEN_TTL_SEC = 60 * 60;

/** Refresh token TTL (seconds). 30 days mirrors the typical OAuth
 *  refresh window; longer than this and the token effectively
 *  becomes a persistent credential. Each `refresh_token` grant
 *  rotates the token, so an idle client gets revoked at this
 *  horizon while an active one stays connected indefinitely. */
export const MCP_REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;

/** Authorization code TTL (seconds). RFC 6749 §4.1.2 says codes
 *  SHOULD be short-lived (10 min max); 60 seconds is conservative
 *  and matches OAuth 2.1 best-practice recommendations. */
export const MCP_AUTH_CODE_TTL_SEC = 60;

/** Single scope advertised today. The orchestrator does not yet
 *  distinguish read/write per MCP tool — a valid MCP token grants
 *  the same surface the cookie session does. */
export const MCP_SCOPE = 'mcp';

/** Canonical `ORCHESTRATOR_URL` form used everywhere downstream.
 *  Strips trailing slashes once at read time so we don't have to
 *  remember to do it at every call site. Cached for the process
 *  lifetime since the env var is read at boot. */
let _canonicalUrlCache: string | null = null;
export function getCanonicalOrchestratorUrl(): string {
  if (_canonicalUrlCache !== null) return _canonicalUrlCache;
  const raw = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8080';
  _canonicalUrlCache = raw.replace(/\/+$/, '');
  return _canonicalUrlCache;
}

/** Resource indicator (RFC 8707) for the MCP endpoint — the value
 *  that goes into the `resource` parameter on authorize/token, into
 *  the `aud` claim of the access JWT, and into the `resource`
 *  column of `mcp_oauth_codes` / `mcp_oauth_refresh`. The MCP
 *  endpoint's bearer-validator requires `aud` to include this. */
export function getMcpResourceUrl(): string {
  return `${getCanonicalOrchestratorUrl()}/mcp`;
}

/** Reset the cache. Test-only — production never re-reads
 *  `ORCHESTRATOR_URL` mid-process. */
export function _resetCanonicalUrlForTests(): void {
  _canonicalUrlCache = null;
}

/**
 * Resolve the HS256 signing key for MCP OAuth access JWTs. Returns
 * 32 raw bytes (Uint8Array) — the size HS256 wants.
 *
 * Precedence:
 *   1. `MCP_OAUTH_SIGNING_SECRET` (≥32 chars) — operator's explicit
 *      dedicated secret. Use this when you want to rotate the MCP
 *      signing key independently of the UI cookie secret.
 *   2. HKDF-SHA256(COOKIE_SECRET, info="mcp-oauth-jwt-hs256") —
 *      derived from the cookie secret using a distinct HKDF info
 *      label. COOKIE_SECRET is already enforced ≥32 chars in
 *      production (see index.ts resolveCookieSecret), so this is
 *      cryptographically equivalent to a dedicated 32-byte secret
 *      AND avoids forcing operators to manage a second env var on
 *      existing deployments. The info label is what makes this safe
 *      — HKDF guarantees the derived key is computationally
 *      independent of the parent for any distinct info value.
 *   3. Dev placeholder, only when NODE_ENV != 'production' AND
 *      `ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET=1` (the same flag
 *      that gates the cookie dev fallback in index.ts). The boot
 *      path forces a 127.0.0.1 bind whenever that flag is set, so
 *      the degraded MCP instance is unreachable from the LAN.
 *
 * Throws when none of the three is available — the boot path
 * surfaces this as a fatal startup error.
 */
export function resolveSigningKey(): Uint8Array {
  const direct = process.env.MCP_OAUTH_SIGNING_SECRET;
  if (typeof direct === 'string' && direct.length >= 32) {
    // HMAC keys can be any size; we don't truncate or pad. jose
    // accepts the raw bytes.
    return new TextEncoder().encode(direct);
  }

  const cookieSecret = process.env.COOKIE_SECRET;
  if (typeof cookieSecret === 'string' && cookieSecret.length >= 32) {
    const derived = hkdfSync(
      'sha256',
      Buffer.from(cookieSecret, 'utf-8'),
      // Empty salt is fine when the info label is unique and the
      // input keying material has sufficient entropy — see RFC 5869
      // §3.1. COOKIE_SECRET is ≥32 chars from `openssl rand -hex 32`
      // (the documented recipe), giving 128 bits of entropy, well
      // above the threshold.
      Buffer.alloc(0),
      Buffer.from('mcp-oauth-jwt-hs256'),
      32
    );
    return new Uint8Array(derived);
  }

  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET === '1'
  ) {
    return new TextEncoder().encode(DEV_SIGNING_SECRET_PLACEHOLDER);
  }

  throw new Error(
    'No strong secret available for MCP OAuth JWT signing. ' +
      'Either set MCP_OAUTH_SIGNING_SECRET (≥32 chars) explicitly, ' +
      'OR ensure COOKIE_SECRET is set (≥32 chars; openssl rand -hex 32) ' +
      'and the MCP signing key will be derived from it via HKDF. In ' +
      'production at least one of these is required.'
  );
}
