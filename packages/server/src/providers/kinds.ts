import type { ProviderKind, Provider } from '@orchestrator/shared';

/** Per-kind metadata: defaults, capability flags, and how the operator
 *  configures a provider of this kind in the UI form. The runtime uses
 *  this table to:
 *    - Validate operator-submitted provider rows (which fields are
 *      required for this kind?)
 *    - Resolve the actual env-var name to export to agent containers
 *      (the standard name read by the inference SDK / CLI for this kind)
 *    - Render kind-appropriate form fields in the UI
 *
 *  Each entry here is paired with a hand-rolled React form component on
 *  the client (`packages/ui/src/components/provider-forms/<kind>.tsx`).
 *  Adding a new kind requires editing this table, the shared
 *  `PROVIDER_KINDS` enum, and shipping the matching UI form. */
export interface ProviderKindSpec {
  kind: ProviderKind;
  display_name: string;
  /** Plain-English description shown in the Providers tab. */
  description: string;
  /** True when this kind requires `base_url` (self-hosted endpoint).
   *  False when the SDK uses a fixed cloud endpoint. */
  requires_base_url: boolean;
  /** Standard env var name the inference SDK / CLI reads for this kind.
   *  At launch the orchestrator exports the provider's resolved
   *  credential under THIS name into the agent container, regardless of
   *  whether the operator stored the credential as an env-var pointer
   *  (`api_key_env_var`) or inline (`auth_token`). */
  container_env_name: string | null;
  /** True when no auth is required at all (e.g., a vanilla Ollama with
   *  no front-door token). The Providers form should still allow an
   *  optional auth_token for setups that put basic-auth in front. */
  auth_optional: boolean;
}

const SPECS: Record<ProviderKind, ProviderKindSpec> = {
  anthropic: {
    kind: 'anthropic',
    display_name: 'Anthropic',
    description: 'Pay-per-token via the Anthropic API.',
    requires_base_url: false,
    container_env_name: 'ANTHROPIC_API_KEY',
    auth_optional: false,
  },
  'claude-subscription': {
    kind: 'claude-subscription',
    display_name: 'Claude.ai subscription',
    description:
      'Subscription billing via Claude.ai (Pro/Max). Only the Claude Code CLI harness can use this provider.',
    requires_base_url: false,
    container_env_name: 'CLAUDE_CODE_OAUTH_TOKEN',
    auth_optional: false,
  },
  openai: {
    kind: 'openai',
    display_name: 'OpenAI',
    description: 'Pay-per-token via the OpenAI API.',
    requires_base_url: false,
    container_env_name: 'OPENAI_API_KEY',
    auth_optional: false,
  },
  gemini: {
    kind: 'gemini',
    display_name: 'Google Gemini',
    description: 'Google AI Studio API. Includes Gemma open-weight models.',
    requires_base_url: false,
    container_env_name: 'GEMINI_API_KEY',
    auth_optional: false,
  },
  mistral: {
    kind: 'mistral',
    display_name: 'Mistral',
    description: 'Mistral AI API.',
    requires_base_url: false,
    container_env_name: 'MISTRAL_API_KEY',
    auth_optional: false,
  },
  deepseek: {
    kind: 'deepseek',
    display_name: 'DeepSeek',
    description: 'DeepSeek API.',
    requires_base_url: false,
    container_env_name: 'DEEPSEEK_API_KEY',
    auth_optional: false,
  },
  openrouter: {
    kind: 'openrouter',
    display_name: 'OpenRouter',
    description:
      'OpenRouter aggregator — routes to many upstream providers under one key.',
    requires_base_url: false,
    container_env_name: 'OPENROUTER_API_KEY',
    auth_optional: false,
  },
  ollama: {
    kind: 'ollama',
    display_name: 'Ollama (self-hosted)',
    description:
      'Local or remote Ollama server. Multi-instance: register one provider row per server.',
    requires_base_url: true,
    container_env_name: null, // Ollama is configured via opencode.json / pi models.json, not an env var.
    auth_optional: true,
  },
};

export function getProviderKindSpec(kind: ProviderKind): ProviderKindSpec {
  return SPECS[kind];
}

export function listProviderKinds(): ProviderKindSpec[] {
  return Object.values(SPECS);
}

/** Resolve the credential value the orchestrator should export into the
 *  agent container when launching against this provider. Returns null
 *  when no credential is needed (Ollama with no auth) OR when the
 *  configured credential isn't available (env var not set). The latter
 *  is a soft failure — caller decides what to do (typically fail the
 *  task with a clear error). */
export function resolveProviderCredential(provider: Provider): string | null {
  if (provider.auth_token) return provider.auth_token;
  if (provider.api_key_env_var) {
    const v = process.env[provider.api_key_env_var];
    return v && v.length > 0 ? v : null;
  }
  return null;
}

/** Build the env-var map to inject into the agent container for this
 *  provider. Keys are the SDK-standard names (per ProviderKindSpec);
 *  values are the resolved credentials. Entries with null credentials
 *  are omitted — the agent will fail at launch if the SDK requires
 *  auth, which is the correct loud failure. */
export function buildProviderEnv(provider: Provider): Record<string, string> {
  const spec = getProviderKindSpec(provider.kind);
  if (!spec.container_env_name) return {};
  const cred = resolveProviderCredential(provider);
  if (!cred) return {};
  return { [spec.container_env_name]: cred };
}
