/**
 * Provider credentials forwarded from the orchestrator's host environment
 * into every agent container at launch.
 *
 * Schema v9 dropped the per-tool `auth_type` and `auth_config` columns. The
 * tool spec no longer declares its own credentials; instead, the orchestrator
 * forwards a fixed set of well-known LLM provider keys to every container,
 * and whichever underlying CLI/SDK the tool invokes picks up whatever it
 * needs. Unused keys sit harmlessly in the container's env.
 *
 * Threat model: the agent already has full shell access inside its sandbox,
 * so a compromised agent could leak any credential we forward to it. Widening
 * from one key to N widens the leak surface but does not introduce a new class
 * of risk. If you need stronger isolation, the right layer is per-task egress
 * controls or short-lived per-task credentials, not per-tool gating.
 *
 * To add a new provider: append its env-var name here. The Settings →
 * Credentials view reads from this list to show configured/missing status.
 */
export const FORWARDED_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
] as const;
