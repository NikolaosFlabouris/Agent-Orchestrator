# 13. MCP Endpoint

The orchestrator can expose its task surface as a **Model Context Protocol** server at `/mcp`, consumable by MCP clients (Claude Code's `agent-orchestrator` plugin, primarily). This makes "create and queue a task" a first-class tool any developer can invoke from any project, with no Forgejo credentials, Docker access, or repo checkout required on the developer's machine — and, through the read-only tools, lets an agent analyse how the orchestrator and its models are actually performing without leaving the session.

The endpoint is OAuth-protected. The orchestrator is both the **MCP Resource Server** (validates bearer JWTs on `/mcp`) and the **OAuth 2.1 Authorization Server** (issues those tokens via discovery, DCR, authorize, and token endpoints). The human-identity step reuses the existing Forgejo-OAuth-backed UI login — no new IdP and no second account to manage.

For the architectural background see [00 - Architecture Overview](./00-architecture-overview.md). This document is the operator + developer runbook.

## Endpoint surface

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/.well-known/oauth-protected-resource` | GET | none | RFC 9728 Protected Resource Metadata. |
| `/.well-known/oauth-authorization-server` | GET | none | RFC 8414 Authorization Server Metadata. |
| `/mcp/oauth/register` | POST | none | RFC 7591 Dynamic Client Registration. Loopback redirect URIs only. |
| `/mcp/oauth/authorize` | GET | session cookie | PKCE-bound authorization-code issuance. Bounces through `/auth/login` when no session. |
| `/mcp/oauth/token` | POST | none (public client + PKCE) | Form-encoded `authorization_code` and `refresh_token` grants. |
| `/mcp` | POST/GET/DELETE | `Bearer <jwt>` | The MCP transport itself. Returns 503 when `MCP_ENABLED` ≠ `1`. |

Token model:
- **Access tokens** — HS256 JWTs, 1-hour TTL, audience-bound to `${ORCHESTRATOR_URL}/mcp`, validated statelessly at `/mcp`.
- **Refresh tokens** — opaque rows in `mcp_oauth_refresh`, 30-day TTL, **rotated on every exchange**. Replaying a rotated-out refresh revokes the entire token family — the OAuth 2.1 reuse-detection model.
- **Authorization codes** — opaque, PKCE-bound (S256), audience-bound, 60-second TTL, one-time-use.

## Tool surface

The server registers eight tools: three that manage work, five that read the orchestrator's telemetry. All five read tools are annotated `readOnlyHint: true` / `openWorldHint: false` and are side-effect free.

| Tool | Inputs | Returns |
|---|---|---|
| `list_repos` | *(none)* | Every registered repo with its effective implementation and review agent profile, and which tier each was resolved from. |
| `list_agent_profiles` | *(none)* | Every agent profile with its joined model / provider / usage stats. |
| `create_task` | `repo_id`, `title`, `description`, `dependencies?`, `agent_profile_id?`, `review_agent_profile_id?`, `max_attempts?`, `human_merge?`, `human_review?` | The created task + Forgejo issue. The only non-read-only tool. |
| `list_tasks` | `repo_id?`, `status?` (a `TaskStatus`), `limit?` (default 50, max 200), `offset?` | Tasks newest first: id, issue id/title, repo tuple, status, attempt/max_attempts, PR number, per-task profile overrides, created/started/completed timestamps. Plus `count`, `total`, `limit`, `offset`. No date window — covers all history. |
| `get_task` | `task_id` | `{ task, attempts, events, forgejo_links }` — the same data `GET /api/tasks/:id` returns, assembled by the same code (`services/task-detail.ts`), just with the three collections under their own keys. |
| `get_task_log` | `task_id`, `tail_lines?` (default 500, max 5000) | `{ log, total_lines, returned_lines, truncated }` — the tail of the task's `progress.log`, read from the live workspace or transparently from the gzipped archive once the workspace has been swept. |
| `query_attempts` | `repos?`, `from?`, `to?`, `model?`, `harness?`, `role?`, `status?`, `include_feedback?`, `limit?` (default 200, max 2000), `offset?` | `{ rows, count, limit, offset }` — the flat `ExportAttemptRow` records `GET /api/export/attempts` serves. **No default window**: omit `from`/`to` and you get all history. |
| `get_report` | `kind` (`overview`\|`timeseries`\|`leaderboard`\|`durations`\|`funnel`\|`reliability`\|`heatmap`), `repos?`, `from?`, `to?`, `bucket?` (timeseries/reliability), `group_by?` (leaderboard/durations), `metric?` (durations/heatmap) | `{ kind, report }`, where `report` is exactly what the matching `/api/reports/*` route returns. |

Every read tool is a thin wrapper: the queries are `db.ts`'s, the task-detail assembly is the REST endpoint's, the log lookup is the archive-aware reader, and the `repos`/`from`/`to` parsing is the reports routes' own `parseFilter`. An MCP answer therefore cannot disagree with the dashboard or the REST API.

### Data semantics

- **Units.** Every `*_seconds` field is wall-clock seconds. Token counts and turn/tool-call counts are raw; the orchestrator derives **no** dollar cost anywhere. Timestamps are ISO-8601 UTC.
- **`null` means unknown**, never 0 — a null `input_tokens` is a harness that reported no usage, not a free run.
- **Date window.** `get_report` defaults to the last `DEFAULT_REPORT_WINDOW_DAYS` (90) when `from`/`to` are omitted, matching the Reports page. `query_attempts` deliberately does not: an export that silently truncated to 90 days would corrupt whatever consumed it. `list_tasks` applies no window either.
- **Bounds are enforced server-side.** `limit` / `tail_lines` above their maxima are rejected (`Invalid input: …`) rather than silently clamped, so a client never analyses a truncated set believing it is complete.
- **Errors** use the same two prefixes `create_task` uses: `Invalid input: …` for a bad argument (unknown `kind`, a `group_by` that doesn't apply to the kind, an over-max `limit`) and `Not found: …` for an unknown task, repo, or missing log.

### Analysis workflow

The read tools are designed to be composed in this order:

1. **Compare** — `get_report kind=leaderboard group_by=model` (or `harness` / `repo`) to see which model merges the most tasks with the least effort; `kind=durations` for how long runs take; `kind=funnel` for where tasks drop out of the lifecycle; `kind=reliability` for the orchestrator's *own* incidents (prep failures, orphan recoveries, git outages) as opposed to the agents'.
2. **Drill down** — `query_attempts` for row-level analysis an aggregate can't answer ("every failed review attempt for model X, with its `error_message`"). For a full-history bulk pull, use the REST endpoint `GET /api/export/attempts?format=jsonl` instead of paging this tool.
3. **Investigate one task** — `list_tasks` to find it, `get_task` for its full state plus attempts and events, then `get_task_log` to read why a specific attempt failed. The log survives workspace retention, so old failures stay inspectable.

## Operator setup

The MCP endpoint requires the orchestrator to be in **non-degraded mode**: real OAuth (`FORGEJO_OAUTH_CLIENT_ID` + `FORGEJO_OAUTH_CLIENT_SECRET` configured), a strong `COOKIE_SECRET` (≥ 32 chars), and `ORCHESTRATOR_URL` set to the deployment's real reachable URL. The boot path already enforces these for any LAN-exposed orchestrator; the MCP endpoint inherits that posture.

### 1. Enable the endpoint

```bash
# .env
MCP_ENABLED=1
```

Anything other than the literal `"1"` keeps the transport disabled and `/mcp` returns a 503 stub. The discovery + OAuth endpoints remain reachable independently so a probing client gets coherent metadata regardless.

### 2. Configure the signing key

The HS256 key used to sign access JWTs can be supplied in either of two ways. Pick one:

- **Explicit dedicated secret** (recommended when you want to rotate the MCP signing key independently of the UI cookie secret):
  ```bash
  MCP_OAUTH_SIGNING_SECRET=$(openssl rand -hex 32)
  ```
- **Derived from `COOKIE_SECRET` via HKDF** (recommended for existing deployments — no new secret to manage). Leave `MCP_OAUTH_SIGNING_SECRET` unset and the orchestrator derives a cryptographically-independent key from your existing `COOKIE_SECRET` using HKDF-SHA256 with the distinct info label `mcp-oauth-jwt-hs256`. Since `COOKIE_SECRET` is already required ≥ 32 chars in production, this is cryptographically equivalent to a dedicated 32-byte secret.

Either way, the key is read at boot. **Rotating the key requires a restart**, and all currently-issued access + refresh tokens become invalid — connected clients re-authenticate transparently via `/mcp` on next use.

### 3. Pin `ORCHESTRATOR_URL` canonically

The OAuth issuer string must be **byte-equal** between AS metadata and the `iss` claim in JWTs (RFC 3986 §6.2.1, called out as a strict gotcha by Claude Code's MCP-OAuth client). The orchestrator strips trailing slashes once at boot, but everything else is byte-strict:

- ✅ `http://localhost:8081` and `https://orchestrator.example.com` — both work, neither has a trailing slash or port elision.
- ❌ `http://localhost:8081/` — trailing slash; the orchestrator will strip it but if you change it again post-deployment, existing tokens fail to validate.
- ❌ `https://orchestrator.example.com:443` — explicit default port. Strip it.
- ❌ Mixing case in the host (`HTTPS://orchestrator.example.com`) — Claude Code does byte-equal comparison, not case-folding.

Set it once and don't change it.

### 4. TLS termination (non-localhost deployments only)

OAuth 2.1 requires HTTPS for Authorization Server endpoints **off-loopback**. For a LAN-exposed orchestrator, put it behind a TLS-terminating reverse proxy (Caddy / nginx / Traefik) and set `ORCHESTRATOR_URL=https://...`. Local-only developments at `http://localhost:8081` are exempt (the OAuth loopback exception applies to both the redirect URIs Claude Code uses and the AS endpoints, since they're on the same loopback host).

The same proxy fronts the `/api/*` UI surface and `/webhooks/forgejo`. There's nothing MCP-specific about the proxy configuration beyond making sure `Host` and `X-Forwarded-Proto` are propagated correctly.

### 5. Forgejo OAuth app — already configured

The `/mcp/oauth/authorize` endpoint does **not** require a new Forgejo OAuth app. It reuses the same `FORGEJO_OAUTH_CLIENT_ID` / `FORGEJO_OAUTH_CLIENT_SECRET` the UI login uses; when an MCP authorize hits without a session cookie, the existing `/auth/login` → Forgejo → `/auth/callback` flow runs and Claude Code is bounced back to the orchestrator's authorize URL via the signed `return_to` cookie. One OAuth app covers both surfaces.

## Developer install

A developer on a fresh machine connects with three actions:

```bash
# 1. (one time) Add the orchestrator repo as a Claude Code marketplace.
#    Replace the URL with your team's git host.
claude plugin marketplace add <git-host>/<owner>/agent-orchestration

# 2. Install the plugin into user scope (available across every project).
claude plugin install agent-orchestrator@agent-orchestrator
```

Then configure the plugin's one knob — the orchestrator URL — through Claude Code's plugin settings UI (`/plugin` → select `agent-orchestrator` → "Configure"), or by setting it directly. The default is `http://localhost:8081` for a same-machine docker-compose install.

```bash
# 3. Test the connection.
claude
> /agent-orchestrator:create-task
```

On the first MCP tool invocation, Claude Code:

1. Receives a 401 from `/mcp` with the `WWW-Authenticate: Bearer resource_metadata="..."` header.
2. Fetches `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` to discover the OAuth config.
3. Calls `/mcp/oauth/register` (Dynamic Client Registration) to obtain a fresh `client_id` for this machine.
4. Opens the developer's browser at `/mcp/oauth/authorize`.
5. The orchestrator sees no session cookie, redirects to `/auth/login`, which bounces to Forgejo, which prompts the developer to authorize the orchestrator's OAuth app (or skips that if already signed in).
6. After `/auth/callback`, the orchestrator redirects back to the authorize endpoint, mints an authorization code (PKCE-bound), and redirects to Claude Code's loopback callback.
7. Claude Code POSTs to `/mcp/oauth/token` with the PKCE verifier, receives an access JWT + refresh token, and stores them in its credential store (OS keychain on macOS, encrypted file on Linux/Windows).
8. The original `/mcp` request retries with the bearer; tools succeed.

From this point on, Claude Code refreshes proactively at ~80% of the 1-hour TTL and the developer never sees the OAuth flow again unless the refresh token is revoked or expires (30 days idle).

To manage the connection later: `/mcp` in any Claude Code session shows the registered server, its auth state, and a "Clear authentication" option that revokes and re-prompts.

## Operations

### Rotating the signing key

```bash
# 1. Generate + set the new key in .env
MCP_OAUTH_SIGNING_SECRET=$(openssl rand -hex 32)

# 2. Restart the orchestrator
docker compose up -d
```

All issued access and refresh tokens become invalid. Connected clients return 401 on the next `/mcp` call, run `WWW-Authenticate` discovery, and silently re-authenticate via their existing OAuth flow (no developer action needed if their Forgejo session cookie is still valid; otherwise a one-click browser bounce).

If you derived the key from `COOKIE_SECRET` (no explicit `MCP_OAUTH_SIGNING_SECRET`), rotating the cookie secret has the same effect — it also rotates the derived MCP key. UI cookie sessions die too, so prefer the explicit secret if you need to rotate MCP tokens without invalidating browser logins.

### Revoking a specific developer

There's no per-client revoke endpoint today. To kick one developer:

1. Revoke their Forgejo account or rotate their Forgejo OAuth grant. Their refresh-token rotation will fail on the next attempt (Forgejo refuses to mint a new session cookie), Claude Code can't re-authorize, and they're locked out.
2. Or, for a more surgical kick, directly mark their refresh-token row in `mcp_oauth_refresh` as revoked (`UPDATE mcp_oauth_refresh SET revoked_at = datetime('now') WHERE forgejo_user_login = '<login>'`). Reuse-detection burns down their whole family on the next attempt.

A per-client revoke API would be a natural future addition; not blocking for v1.

### Inspecting registered clients

```sql
SELECT client_id, client_name, redirect_uris, created_at
FROM mcp_oauth_clients
ORDER BY created_at DESC;
```

Each DCR registration creates a new row. Stale clients (e.g. dev installed plugin, machine retired) accumulate harmlessly; their refresh tokens expire after 30 days of inactivity.

### Token TTLs

- Access: 1 hour
- Refresh: 30 days
- Authorization code: 60 seconds
- Forgejo session cookie (the human-identity layer): 7 days

These are compile-time constants in `packages/server/src/mcp/oauth/config.ts`. Change them deliberately — short access TTLs limit the blast radius of a leaked token; long refresh TTLs mean fewer re-auth prompts but more sessions to revoke if a machine is lost.

### Known limitations (v1)

- **No background pruning of expired rows.** Authorization codes and revoked refresh tokens stay in their tables after TTL. Volumes are small (one row per authorize/token call) so this is fine for a long time, but a periodic `DELETE FROM mcp_oauth_codes WHERE expires_at < datetime('now', '-1 day')` cron is worth adding eventually.
- **No per-tool scopes.** A valid MCP token grants the same surface a UI cookie session does. Fine-grained scoping (e.g., a token limited to the five read-only tools, with no `create_task`) is a future enhancement.
- **DCR is unauthenticated.** Any client that can reach the endpoint can register and start the OAuth flow. The loopback-redirect constraint means a stolen client_id is only useful from the legitimate user's machine, but if you need stricter onboarding, put the orchestrator on a private network.

## Troubleshooting

**`/mcp` returns 401 even after a fresh login.** Check that `MCP_OAUTH_SIGNING_SECRET` (or the `COOKIE_SECRET` it derives from) hasn't been rotated since the developer's tokens were issued. The orchestrator log will record `mcp_bearer_invalid` with a `reason` field (`bad_signature`, `expired`, `wrong_audience`, `wrong_issuer`) — diagnostic, not surfaced to the client.

**`Token failed validation` after a deploy.** Likely cause: `ORCHESTRATOR_URL` changed and the new canonical form doesn't match the `iss` claim on existing tokens. Either revert the URL change or accept that all sessions will re-auth.

**Developer sees `Refresh token has been revoked; re-authorize required` immediately after a successful login.** Suggests reuse-detection fired — typically because the developer has two Claude Code instances on the same machine racing to refresh the same token. Have them clear auth on one (`/mcp` → "Clear authentication") and re-login on the other.

**`invalid_redirect_uri` during DCR.** Claude Code is asking to register a redirect that isn't `http://127.0.0.1:PORT/callback`, `http://localhost:PORT/callback`, or `http://[::1]:PORT/callback`. This is intentional per RFC 8252 — native MCP clients should only use loopback redirects. If the developer's Claude Code is misbehaving, the fix is on the client side.

**The orchestrator is reachable but `/mcp/oauth/authorize` redirects to `/auth/login` and never comes back.** The signed `orchestrator_post_login_return_to` cookie isn't surviving the round trip — usually because the developer's browser is blocking lax-sameSite cookies in cross-site contexts, or `ORCHESTRATOR_URL` doesn't match the URL they typed. Verify the orchestrator URL is what you advertised and the cookie isn't being stripped.

**Webhook + MCP coexisting fine?** Yes. The webhook plugin scopes its `application/json` buffer parser to its own Fastify plugin scope, the MCP plugin gets the default JSON parser, and the MCP transport's own form-urlencoded parser on `/mcp/oauth/token` is scoped to the OAuth plugin. No interference.

## Cross-references

- [Quick Start](./quick-start.md) — first-boot orchestrator install.
- [01 - Forgejo Setup](./01-forgejo-setup.md) — Forgejo OAuth app + tokens.
- [07 - Deployment & Operations](./07-deployment-operations.md) — operational playbook.
- `packages/server/src/mcp/oauth/config.ts` — TTLs, signing-key resolution, canonical-URL helper.
- `packages/server/src/routes/mcp-oauth.ts` — endpoint implementations.
- `packages/server/src/routes/mcp.ts` — bearer-validated transport.
- `packages/server/src/mcp/server.ts` — `list_repos` / `list_agent_profiles` / `create_task`.
- `packages/server/src/mcp/read-tools.ts` — the five read-only telemetry tools.
- `packages/server/src/routes/reports.ts` / `routes/export.ts` — the REST siblings of `get_report` and `query_attempts`.
- `plugin/` — the Claude Code plugin distributed via this repo's marketplace.
