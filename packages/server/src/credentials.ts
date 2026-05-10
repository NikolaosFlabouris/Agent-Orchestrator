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
  'FORGEJO_ORCHESTRATOR_TOKEN',
  'FORGEJO_AGENT_TOKEN',
  'FORGEJO_OAUTH_CLIENT_ID',
  'FORGEJO_OAUTH_CLIENT_SECRET',
  'FORGEJO_WEBHOOK_SECRET',
  'ORCHESTRATOR_URL',
] as const;
