/** Database row types matching the SQL schema exactly. */

export interface Task {
  id: number;
  issue_id: number;
  issue_title: string | null;
  repo_id: number;
  branch_name: string | null;
  pr_number: number | null;
  status: TaskStatus;
  queue_position: number | null;
  attempt: number;
  max_attempts: number;
  prep_failure_count: number;
  /** Per-task agent profile override. NULL = inherit from
   *  `repos.agent_profile_id`, which itself falls back to
   *  `settings.default_agent_profile_id`. The orchestrator resolves the
   *  full chain when launching. */
  agent_profile_id: string | null;
  container_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export type TaskStatus =
  | 'queued'
  | 'preparing'
  | 'in-progress'
  | 'in-review'
  | 'changes-needed'
  | 'merged'
  | 'failed'
  | 'cancelled'
  | 'awaiting-human-merge'
  | 'awaiting-human-review'
  | 'needs-human-review'
  | 'reset';

export interface Attempt {
  id: number;
  task_id: number;
  attempt_number: number | null;
  role: AttemptRole;
  status: AttemptStatus;
  verdict: string | null;
  started_at: string | null;
  completed_at: string | null;
  log_path: string | null;
  feedback: string | null;
  /** Snapshot of the model_id resolved at attempt-launch time. Stored on
   *  the attempt row so audit/usage records survive subsequent edits to
   *  the agent profile or its model row. */
  model_id: string | null;
  /** Snapshot of the harness id resolved at attempt-launch time. Same
   *  reasoning as model_id — robust against profile edits mid-task. */
  harness_id: string | null;
}

export type AttemptRole = 'develop' | 'review';
export type AttemptStatus = 'running' | 'completed' | 'failed' | 'timeout';

export interface Repo {
  id: number;
  owner: string;
  name: string;
  base_branch: string;
  /** Per-repo default agent profile. NULL = fall back to
   *  `settings.default_agent_profile_id`. */
  agent_profile_id: string | null;
  /** Ordered list of dependency-install steps the harness runs (sequentially,
   *  under a single `flock` on the shared cache mount) before the agent
   *  starts. Empty array = no install. Each entry is one of:
   *    - A typed package-manager step (npm-ci, pnpm-install, etc.) that the
   *      harness maps to a hardcoded command. No shell injection surface.
   *    - A `script` step pointing at a path inside the repo. Only honoured
   *      when this repo's `allow_script_steps` is true; the harness runs
   *      `bash <path>` with full container env. */
  install_steps: InstallStep[];
  /** Per-repo opt-in for the `script` install-step kind. Default false. The
   *  operator must flip this to allow committers to influence what runs at
   *  pre-agent time, since the script inherits the agent container env. */
  allow_script_steps: boolean;
  container_memory_mb: number | null;
  container_cpu_cores: number | null;
  /** Operator's preferred PR merge strategy. Honoured at merge time only
   *  if the repo's Forgejo-side allowed strategies include it; otherwise
   *  the orchestrator falls back to the first allowed style. */
  merge_strategy: 'squash' | 'merge' | 'rebase';
 }

/** Typed install steps. Most map to a fixed package-manager command; the
 *  `script` variant is the deliberately-gated escape hatch. */
export type InstallStep =
  | { kind: InstallStepKind; cwd?: string }
  | { kind: 'script'; path: string; cwd?: string };

export type InstallStepKind =
  | 'npm-ci'
  | 'npm-install'
  | 'yarn-install'
  | 'pnpm-install'
  | 'pip-requirements'
  | 'pip-pyproject'
  | 'uv-sync'
  | 'cargo-fetch'
  | 'go-mod-download';

/** Set of safe (non-script) step kinds, for runtime validation. */
export const INSTALL_STEP_KINDS: readonly InstallStepKind[] = [
  'npm-ci',
  'npm-install',
  'yarn-install',
  'pnpm-install',
  'pip-requirements',
  'pip-pyproject',
  'uv-sync',
  'cargo-fetch',
  'go-mod-download',
] as const;

// ---------------------------------------------------------------------------
// Provider / Model / Agent profile
// ---------------------------------------------------------------------------
//
// Three-layer config replaces the old monolithic `agent_tools` row:
//
//   provider — concrete connection identity (kind + credential + URL).
//              Cloud kinds are typically singletons; self-hosted kinds
//              (ollama) can have multiple instances.
//   model    — a model_id known to a specific provider. Composite identity:
//              (provider_id, model_id). Model strings are stored bare;
//              harnesses prefix `<kind>/...` when the binary expects it.
//   profile  — the operator-composed pairing: (harness_id, provider_id,
//              model_id, harness-specific config). What tasks reference.

/** Stable identifiers for the kinds of provider the orchestrator knows
 *  about. Adding a kind requires code (new harness support + new UI form
 *  in the Providers tab + new env-export logic). */
export type ProviderKind =
  | 'anthropic'
  | 'claude-subscription'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'deepseek'
  | 'openrouter'
  | 'ollama';

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  'anthropic',
  'claude-subscription',
  'openai',
  'gemini',
  'mistral',
  'deepseek',
  'openrouter',
  'ollama',
] as const;

export interface Provider {
  /** Operator-authored stable id (e.g. "anthropic-team", "ollama-gpu"). */
  id: string;
  display_name: string;
  /** Determines credential shape, env-var name, default base_url, and which
   *  harnesses can target this provider. See PROVIDER_KINDS. */
  kind: ProviderKind;
  /** Max simultaneous agent containers that can target this provider.
   *  0 = paused (no tasks using this provider launch). Independent from
   *  the host resource pool (settings.max_agent_memory_mb /
   *  max_agent_cpu_cores), which gates hardware capacity. */
  concurrency_limit: number;
  /** Connection URL. NULL for cloud kinds (uses kind's default endpoint).
   *  REQUIRED for self-hosted kinds (ollama). */
  base_url: string | null;
  /** Name of the orchestrator-side env var holding this provider's API
   *  key (e.g. 'ANTHROPIC_API_KEY'). The orchestrator reads from its own
   *  env at launch and exports the value into the agent container under
   *  the kind's standard name. NULL when auth_token is used instead. */
  api_key_env_var: string | null;
  /** Inline secret for self-hosted providers (Ollama bearer/basic auth)
   *  OR for cloud providers when the operator wants to multi-instance a
   *  kind without using env-var indirection. NULL when api_key_env_var is
   *  used or no auth is required. Stored in the DB as plaintext. */
  auth_token: string | null;
  /** Free-text operator notes. */
  notes: string | null;
}

export interface Model {
  /** Surrogate primary key. Operators reference models by (provider_id,
   *  model_id) but the FK from agent_profiles is to this surrogate. */
  id: number;
  /** FK → providers.id. Hard delete RESTRICTED if any models reference. */
  provider_id: string;
  /** Bare model identifier as the inference endpoint expects, without any
   *  provider prefix (e.g. 'claude-sonnet-4-6', 'qwen2.5-coder:14b').
   *  Harnesses that need '<provider>/<model>' form prefix at launch time. */
  model_id: string;
  display_name: string;
}

/** Stable identifiers for the harnesses the orchestrator knows about.
 *  Adding a harness requires code (new module + matching UI form
 *  component). */
export type HarnessId =
  | 'claude-sdk'
  | 'claude-code'
  | 'opencode'
  | 'pi';

export const HARNESS_IDS: readonly HarnessId[] = [
  'claude-sdk',
  'claude-code',
  'opencode',
  'pi',
] as const;

export interface AgentProfile {
  /** Operator-authored stable id. */
  id: string;
  display_name: string;
  /** Code-defined harness this profile uses. */
  harness_id: HarnessId;
  /** FK → models.id. The provider is reachable via the model. */
  model_pk: number;
  /** Harness-specific config (typed knobs the harness understands).
   *  Stored as JSON; the harness module owns its schema. Empty object
   *  if the harness has no operator-tunable knobs. */
  config_json: Record<string, unknown>;
  /** Wall-clock timeout (minutes) for an agent run using this profile.
   *  Form pre-fill for new profiles is 2880 (48h); paid-API typical is
   *  120 (2h). */
  timeout_minutes: number;
}

export interface Settings {
  schema_version: string;
  /** Max simultaneous agent-container memory (MB). Resource-pool layer
   *  for host capacity — sums each active container's
   *  `repos.container_memory_mb ?? DEFAULT_CONTAINER_MEMORY_MB`; a
   *  candidate launches only if its own size fits in the remaining pool. */
  max_agent_memory_mb: string;
  /** Max simultaneous agent-container CPU cores. Same composition as
   *  `max_agent_memory_mb` but for CPU. Both must allow launch. */
  max_agent_cpu_cores: string;
  /** Fallback agent profile when neither task nor repo specifies one.
   *  Set on first-run seed; operator can change via Global Settings. */
  default_agent_profile_id: string;
  last_shutdown: string;
}

export type SettingsKey = keyof Settings;

export interface TaskEvent {
  id: number;
  task_id: number;
  event_type: string;
  message: string;
  created_at: string;
}

export interface TaskStep {
  id: number;
  task_id: number;
  attempt_number: number;
  step_name: string;
  result: unknown;
  completed_at: string;
}
