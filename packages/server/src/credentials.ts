/**
 * Orchestrator-only secret env vars. These are read by the orchestrator
 * process itself; they are NEVER exported into agent containers.
 *
 * Provider-side credentials (ANTHROPIC_API_KEY etc.) are no longer
 * tracked here — each provider row carries its own `api_key_env_var`
 * (or `auth_token` inline), and the scheduler reads from one of those
 * at launch and exports the value into the agent container under the
 * provider kind's standard env name. See `providers/kinds.ts`.
 *
 * The Settings → Credentials UI reads from this list to show
 * configured/missing status for orchestrator-only secrets.
 */
export const ORCHESTRATOR_ENV_VARS = [
  // Connection to the Forgejo host the orchestrator drives.
  'FORGEJO_URL',
  'FORGEJO_ORCHESTRATOR_TOKEN',
  'FORGEJO_AGENT_TOKEN',
  'FORGEJO_WEBHOOK_SECRET',
  // OAuth app for /api/* authentication. Combined with COOKIE_SECRET
  // these gate the entire web/HTTP surface — the Credentials tab
  // surfacing them as "not set" is the operator's first warning that
  // they're running in the loud-warning degraded mode (see auth.ts +
  // index.ts resolveCookieSecret).
  'FORGEJO_OAUTH_CLIENT_ID',
  'FORGEJO_OAUTH_CLIENT_SECRET',
  'COOKIE_SECRET',
  // Public URL the orchestrator advertises for the OAuth callback and
  // webhook URLs.
  'ORCHESTRATOR_URL',
] as const;
