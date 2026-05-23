/**
 * OAuth token primitives — JWT access tokens, opaque rotating
 * refresh tokens, and one-time-use authorization codes.
 *
 * Access tokens are HS256 JWTs signed with the orchestrator's MCP
 * signing key (see `./config.ts resolveSigningKey`). Validation is
 * stateless — signature + audience + issuer + expiry — so the
 * /mcp bearer check is a single CPU operation, no DB hit.
 *
 * Refresh tokens are opaque random strings looked up in
 * `mcp_oauth_refresh`. On exchange the presented token is marked
 * `revoked_at` (rotation), a fresh token is issued in the same
 * `family_id`, and a replay of the rotated-out token revokes every
 * sibling in that family (reuse-detection — the entire client
 * session is invalidated).
 *
 * Authorization codes are opaque, PKCE-bound, audience-bound,
 * 60-second TTL, one-time-use. They live in `mcp_oauth_codes` and
 * are consumed inside a transaction so a concurrent double-redeem
 * loses cleanly.
 */

import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getDb } from '../../db.js';
import {
  MCP_ACCESS_TOKEN_TTL_SEC,
  MCP_AUTH_CODE_TTL_SEC,
  MCP_REFRESH_TOKEN_TTL_SEC,
  MCP_SCOPE,
  getCanonicalOrchestratorUrl,
  getMcpResourceUrl,
  resolveSigningKey,
} from './config.js';

const JWT_ALG = 'HS256' as const;

// ---------------------------------------------------------------------------
// Access tokens (JWT)
// ---------------------------------------------------------------------------

/** Custom claims we set on the access JWT. Standard claims (`iss`,
 *  `sub`, `aud`, `exp`, `iat`, `jti`) are also present; jose's
 *  `JWTPayload` types them. */
export interface AccessTokenClaims {
  iss: string;
  sub: string; // forgejo_user_login
  aud: string | string[]; // mcp resource URL
  exp: number;
  iat: number;
  jti: string;
  scope: string;
  client_id: string;
}

export interface IssuedAccessToken {
  access_token: string;
  /** Seconds until expiry, as returned in the OAuth `expires_in`
   *  field. Clients refresh proactively against this. */
  expires_in: number;
}

export async function issueAccessToken(input: {
  forgejo_user_login: string;
  client_id: string;
  scope?: string;
}): Promise<IssuedAccessToken> {
  const key = resolveSigningKey();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + MCP_ACCESS_TOKEN_TTL_SEC;
  const jti = randomBytes(16).toString('hex');

  const access_token = await new SignJWT({
    scope: input.scope ?? MCP_SCOPE,
    client_id: input.client_id,
  })
    .setProtectedHeader({ alg: JWT_ALG, typ: 'JWT' })
    .setIssuer(getCanonicalOrchestratorUrl())
    .setSubject(input.forgejo_user_login)
    .setAudience(getMcpResourceUrl())
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key);

  return { access_token, expires_in: MCP_ACCESS_TOKEN_TTL_SEC };
}

export type VerifyAccessTokenResult =
  | { ok: true; claims: AccessTokenClaims }
  | {
      ok: false;
      /** Stable enum for the /mcp bearer-validator to log. The
       *  outward response is always the same RFC 6750 `invalid_token`
       *  — we don't leak the precise reason to the client. */
      reason:
        | 'malformed'
        | 'bad_signature'
        | 'expired'
        | 'wrong_audience'
        | 'wrong_issuer'
        | 'other';
    };

/** Verify an access JWT. Validates signature (HS256 with the
 *  orchestrator's signing key), audience (must include the canonical
 *  MCP resource URL), issuer (byte-equal to the canonical
 *  orchestrator URL), and expiry. Stateless — no DB hit. */
export async function verifyAccessToken(
  token: string
): Promise<VerifyAccessTokenResult> {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const key = resolveSigningKey();
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: getCanonicalOrchestratorUrl(),
      audience: getMcpResourceUrl(),
      algorithms: [JWT_ALG],
    });
    // jose's JWTPayload is a generic Record; coerce to our shape.
    // The `iss`/`aud`/`exp` checks above guarantee the standard
    // claims are present and valid.
    return { ok: true, claims: payload as unknown as AccessTokenClaims };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? '';
    if (code === 'ERR_JWT_EXPIRED') return { ok: false, reason: 'expired' };
    if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
      return { ok: false, reason: 'bad_signature' };
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      // jose throws this for both wrong issuer and wrong audience.
      // We can disambiguate via the `claim` property on the error.
      const claim = (err as { claim?: string } | null)?.claim;
      if (claim === 'aud') return { ok: false, reason: 'wrong_audience' };
      if (claim === 'iss') return { ok: false, reason: 'wrong_issuer' };
    }
    if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID')
      return { ok: false, reason: 'malformed' };
    return { ok: false, reason: 'other' };
  }
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

/** Compute the PKCE S256 challenge for a code_verifier. Exported for
 *  the test suite; production only calls it inside `consumeAuthCode`. */
export function pkceS256(code_verifier: string): string {
  return createHash('sha256').update(code_verifier).digest('base64url');
}

export interface CreateAuthCodeInput {
  client_id: string;
  redirect_uri: string;
  /** PKCE S256 challenge as supplied in the authorize request. */
  code_challenge: string;
  /** Resource indicator (RFC 8707) — pinned to the issued access
   *  token's `aud` claim on exchange. */
  resource: string;
  forgejo_user_login: string;
}

/** Generate an opaque code, persist its binding, return it for the
 *  authorize-redirect step. The DB row carries a 60-second TTL. */
export function createAuthCode(input: CreateAuthCodeInput): string {
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    Date.now() + MCP_AUTH_CODE_TTL_SEC * 1000
  ).toISOString();
  getDb()
    .prepare(
      `INSERT INTO mcp_oauth_codes
         (code, client_id, redirect_uri, code_challenge, resource, forgejo_user_login, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      input.client_id,
      input.redirect_uri,
      input.code_challenge,
      input.resource,
      input.forgejo_user_login,
      expiresAt
    );
  return code;
}

export interface ConsumeAuthCodeInput {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
  /** Must equal the `resource` the code was bound to. */
  resource: string;
}

export type ConsumeAuthCodeReason =
  | 'not_found'
  | 'expired'
  | 'consumed'
  | 'client_mismatch'
  | 'redirect_mismatch'
  | 'resource_mismatch'
  | 'pkce_mismatch';

export type ConsumeAuthCodeResult =
  | { ok: true; forgejo_user_login: string }
  | { ok: false; reason: ConsumeAuthCodeReason };

/** Look up, validate, and consume an authorization code in a single
 *  transaction. Mismatches return discriminated reasons so the
 *  token endpoint can log diagnostically while returning a uniform
 *  `invalid_grant` to the client. */
export function consumeAuthCode(
  input: ConsumeAuthCodeInput
): ConsumeAuthCodeResult {
  const db = getDb();
  return db.transaction((): ConsumeAuthCodeResult => {
    const row = db
      .prepare(
        `SELECT client_id, redirect_uri, code_challenge, resource,
                forgejo_user_login, expires_at, consumed_at
         FROM mcp_oauth_codes WHERE code = ?`
      )
      .get(input.code) as
      | {
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          resource: string;
          forgejo_user_login: string;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.consumed_at) return { ok: false, reason: 'consumed' };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    if (row.client_id !== input.client_id) {
      return { ok: false, reason: 'client_mismatch' };
    }
    if (row.redirect_uri !== input.redirect_uri) {
      return { ok: false, reason: 'redirect_mismatch' };
    }
    if (row.resource !== input.resource) {
      return { ok: false, reason: 'resource_mismatch' };
    }
    if (pkceS256(input.code_verifier) !== row.code_challenge) {
      return { ok: false, reason: 'pkce_mismatch' };
    }
    // Mark consumed. Subsequent presentation of this code will hit
    // the `consumed_at` branch above and fail.
    db.prepare(
      `UPDATE mcp_oauth_codes SET consumed_at = datetime('now') WHERE code = ?`
    ).run(input.code);
    return { ok: true, forgejo_user_login: row.forgejo_user_login };
  })();
}

// ---------------------------------------------------------------------------
// Refresh tokens (opaque, rotating, reuse-detected)
// ---------------------------------------------------------------------------

export interface IssueRefreshInput {
  client_id: string;
  forgejo_user_login: string;
  resource: string;
  scope?: string;
  /** Provide to chain this refresh into an existing family (the
   *  rotation case). Omit to start a new family — the
   *  authorization_code grant path. */
  family_id?: string;
}

export interface IssuedRefreshToken {
  refresh_token: string;
  family_id: string;
}

export function issueRefreshToken(input: IssueRefreshInput): IssuedRefreshToken {
  const refresh_token = randomBytes(32).toString('base64url');
  const family_id = input.family_id ?? randomBytes(16).toString('hex');
  const expiresAt = new Date(
    Date.now() + MCP_REFRESH_TOKEN_TTL_SEC * 1000
  ).toISOString();
  getDb()
    .prepare(
      `INSERT INTO mcp_oauth_refresh
         (token_id, client_id, family_id, forgejo_user_login, resource, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      refresh_token,
      input.client_id,
      family_id,
      input.forgejo_user_login,
      input.resource,
      input.scope ?? MCP_SCOPE,
      expiresAt
    );
  return { refresh_token, family_id };
}

export interface ExchangeRefreshInput {
  refresh_token: string;
  client_id: string;
}

export interface ExchangeRefreshOk {
  ok: true;
  family_id: string;
  forgejo_user_login: string;
  resource: string;
  scope: string;
}

export type ExchangeRefreshReason =
  | 'not_found'
  | 'expired'
  | 'revoked'
  | 'client_mismatch';

export type ExchangeRefreshResult =
  | ExchangeRefreshOk
  | { ok: false; reason: ExchangeRefreshReason };

/** Validate + invalidate a presented refresh token in a single
 *  transaction. On success the caller issues a NEW refresh token in
 *  the returned `family_id` (so the chain is intact). On a `revoked`
 *  outcome (the token had already been rotated) we revoke every
 *  sibling in the family — that's the RFC 6749 §10.4 / OAuth 2.1
 *  refresh-rotation security model: a replayed refresh proves theft,
 *  so the entire client session is killed and the human must
 *  re-authorize. */
export function exchangeRefreshToken(
  input: ExchangeRefreshInput
): ExchangeRefreshResult {
  const db = getDb();
  return db.transaction((): ExchangeRefreshResult => {
    const row = db
      .prepare(
        `SELECT client_id, family_id, forgejo_user_login, resource, scope,
                expires_at, revoked_at
         FROM mcp_oauth_refresh WHERE token_id = ?`
      )
      .get(input.refresh_token) as
      | {
          client_id: string;
          family_id: string;
          forgejo_user_login: string;
          resource: string;
          scope: string | null;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.client_id !== input.client_id) {
      return { ok: false, reason: 'client_mismatch' };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    if (row.revoked_at) {
      // Reuse-detection: revoke every refresh in this family that
      // hasn't already been revoked. Forces re-authorization.
      db.prepare(
        `UPDATE mcp_oauth_refresh
         SET revoked_at = datetime('now')
         WHERE family_id = ? AND revoked_at IS NULL`
      ).run(row.family_id);
      return { ok: false, reason: 'revoked' };
    }
    // Happy path: rotate. Mark this token revoked; caller will
    // issue a successor in the same family.
    db.prepare(
      `UPDATE mcp_oauth_refresh
       SET revoked_at = datetime('now') WHERE token_id = ?`
    ).run(input.refresh_token);
    return {
      ok: true,
      family_id: row.family_id,
      forgejo_user_login: row.forgejo_user_login,
      resource: row.resource,
      scope: row.scope ?? MCP_SCOPE,
    };
  })();
}
