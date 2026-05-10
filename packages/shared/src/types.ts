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
  agent_tool: string | null;
  model: string | null;
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
  model: string | null;
}

export type AttemptRole = 'develop' | 'review';
export type AttemptStatus = 'running' | 'completed' | 'failed' | 'timeout';

export interface Repo {
  id: number;
  owner: string;
  name: string;
  base_branch: string;
  agent_tool: string;
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
   *  pre-agent time, since the script inherits the agent container's env
   *  including FORWARDED_KEYS. */
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

export interface AgentTool {
  id: string;
  display_name: string;
  type: AgentToolType;
  command_template: string | null;
  /** Flat key/value JSON. Forwarded as container env vars at launch. Keys
   *  that collide with FORWARDED_KEYS override the orchestrator's host
   *  values; arbitrary other keys are added to the container env. */
  env_vars: string;
  /** Optional config file path, relative to /repo (the workspace root inside
   *  the container). Set together with config_file_content. */
  config_file_path: string | null;
  /** Optional config file content (raw text). Set together with
   *  config_file_path. The orchestrator writes this to /repo/${path} before
   *  the agent container starts. */
  config_file_content: string | null;
  /** Per-tool wall-clock timeout (minutes). Required since schema v17 — no
   *  longer fall through to repo or global. The orchestrator passes this
   *  verbatim to the harness's container-lifetime guard. Form pre-fill for
   *  new tools is 2880 (48 h); seeded paid tools use 120 (2 h). */
  timeout_minutes: number;
  /** Concurrency pool this tool belongs to. Tools sharing a provider_id
   *  serialise against that provider's concurrency_limit; tools with null
   *  provider_id only have to fit in the host resource pool
   *  (settings.max_agent_memory_mb / max_agent_cpu_cores). */
  provider_id: string | null;
}

export type AgentToolType = 'sdk' | 'cli';

/** A provider represents an upstream resource (e.g. a specific Ollama server,
 *  an Anthropic API key's rate-limit bucket) whose concurrent use the
 *  orchestrator bounds via concurrency_limit. Two tools pointing at the same
 *  provider share a slot budget; tools on different providers run in parallel. */
export interface Provider {
  id: string;
  display_name: string;
  /** Max simultaneous agent containers that can use this provider.
   *  0 = paused (no tasks using this provider launch).
   *  Respected in addition to the host resource pool
   *  (settings.max_agent_memory_mb / max_agent_cpu_cores). */
  concurrency_limit: number;
  notes: string | null;
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
  default_model: string;
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
