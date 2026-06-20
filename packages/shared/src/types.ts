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
  /** Per-task agent profile override for the implementation (develop)
   *  stage. NULL = inherit from `repos.agent_profile_id`, which itself
   *  falls back to `settings.default_agent_profile_id`. The orchestrator
   *  resolves the full chain when launching. Also the terminal fallback
   *  for the review stage when no review profile is configured at any
   *  tier. */
  agent_profile_id: string | null;
  /** Per-task agent profile override for the review stage. NULL =
   *  inherit from `repos.review_agent_profile_id`, then
   *  `settings.default_review_agent_profile_id`, then finally the
   *  task's effective implementation profile. */
  review_agent_profile_id: string | null;
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
  /** Snapshot of profile.timeout_minutes captured at attempt-launch
   *  time. Used by alerts.checkAlerts to compute the stuck-task
   *  threshold so a profile edit mid-flight can't retroactively
   *  shorten the threshold for an already-running attempt (H5a).
   *  Null for pre-v22 attempts; consumers fall back to a live profile
   *  read in that case. */
  timeout_minutes_snapshot: number | null;
  /** Number of agent turns the run took, read from the harness's
   *  result.json `usage` block at completion. Immutable per-run effort
   *  fact (the run already happened — no snapshot-vs-live concern). NULL
   *  when the harness emitted no usage (pre-v29 rows, CLI harnesses with
   *  no machine-readable summary). NULL means "unknown", never 0. */
  num_turns: number | null;
  /** Input (prompt) tokens consumed by the run. Raw count — the
   *  orchestrator never derives a dollar cost; operators look up provider
   *  pricing themselves. NULL = unknown (see num_turns). */
  input_tokens: number | null;
  /** Output (completion) tokens produced by the run. Raw count. NULL =
   *  unknown. */
  output_tokens: number | null;
  /** Number of tool invocations the run made, when the harness reports
   *  it. NULL = unknown / not reported. */
  tool_calls: number | null;
}

/** Per-run effort metrics emitted by the in-container harness into
 *  result.json's `usage` block and persisted onto the attempt row by the
 *  completion path. Every field is optional: a harness that can't report a
 *  metric simply omits it, and the corresponding attempt column stays NULL.
 *  Raw counts only — cost is intentionally NOT computed here. */
export interface AgentUsage {
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: number;
}

/** The contract the orchestrator reads from a finished container's
 *  /output/result.json. Declared here so the scheduler, startup recovery,
 *  and shutdown drain all share one shape. `usage` is optional and
 *  backward-compatible — a harness that emits no usage behaves exactly as
 *  before. */
export interface AgentResult {
  status: 'success' | 'failure' | 'timeout';
  exit_code?: number;
  error_message?: string;
  usage?: AgentUsage;
}

export type AttemptRole = 'develop' | 'review';
export type AttemptStatus = 'running' | 'completed' | 'failed' | 'timeout';

export interface Repo {
  id: number;
  owner: string;
  name: string;
  base_branch: string;
  /** Per-repo default agent profile for the implementation (develop)
   *  stage. NULL = fall back to `settings.default_agent_profile_id`. */
  agent_profile_id: string | null;
  /** Per-repo default agent profile for the review stage. NULL = fall
   *  back to `settings.default_review_agent_profile_id`, then to the
   *  effective implementation profile. */
  review_agent_profile_id: string | null;
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
  merge_strategy: MergeStrategy;
 }

/** Operator-selectable merge strategies. The runtime in
 *  `packages/server/src/merge-strategy.ts` resolves this against the
 *  repo's Forgejo-side allowed set and may fall back to other Forgejo
 *  strategies (rebase-merge, fast-forward-only) when none of these
 *  three is allowed — but operators only choose from this list in the
 *  UI and on the wire. */
export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export const MERGE_STRATEGIES: readonly MergeStrategy[] = [
  'squash',
  'merge',
  'rebase',
] as const;

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
  /** Fallback REVIEW-stage profile when neither the task nor its repo
   *  specifies one. Unlike `default_agent_profile_id` this key is unset
   *  by default — when absent, the review stage falls back to the
   *  task's effective implementation profile (today's single-profile
   *  behavior). */
  default_review_agent_profile_id: string;
}

export type SettingsKey = keyof Settings;

export interface TaskEvent {
  id: number;
  task_id: number;
  event_type: string;
  message: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Task dependencies
// ---------------------------------------------------------------------------
//
// A queued task can declare dependencies on other issues in its repo via
// checklist items under a `## Dependencies` heading in the issue body
// (`- [ ] #38`). The issue body is the source of truth; the orchestrator
// keeps `task_dependencies` rows as a synced projection (re-derived from
// the body on every evaluation) for the scheduler gate and the UI.
//
// A dependency is complete when its issue is closed. "Blocked" is never a
// TaskStatus — it is computed at read time from these records and only
// rendered in the orchestrator UI.

export type DependencyState =
  | 'satisfied'            // dep issue closed (or its orchestrator task merged)
  | 'manually-satisfied'   // checked box override (`- [x] #N`) in the issue body
  | 'open'                 // dep issue open
  | 'in-progress'          // dep issue open + its orchestrator task actively running
  | 'failed'               // dep issue open + its orchestrator task failed/cancelled/reset
  | 'missing'              // dep issue does not exist (404)          → blocks
  | 'error'                // fetch failure, no prior satisfied state → blocks
  | 'cycle';               // dependency cycle among queued tasks     → blocks

/** Dependency states that allow the dependent task to launch. */
export const SATISFIED_DEP_STATES: ReadonlySet<DependencyState> = new Set([
  'satisfied',
  'manually-satisfied',
] as DependencyState[]);

export interface TaskDependency {
  id: number;
  task_id: number;
  /** Issue (or PR — Forgejo shares numbering) number in the task's repo. */
  dep_issue_number: number;
  state: DependencyState;
  /** Human-readable evidence/reason, e.g. "merged via task #12 / PR #52". */
  detail: string | null;
  /** Raw checkbox state from the last body parse. */
  checked: boolean;
  first_seen_at: string;
  last_evaluated_at: string | null;
}

export interface TaskStep {
  id: number;
  task_id: number;
  attempt_number: number;
  step_name: string;
  result: unknown;
  completed_at: string;
}

// ---------------------------------------------------------------------------
// Reports API (read-only aggregates)
// ---------------------------------------------------------------------------
//
// Server-side aggregation of the orchestrator's task/attempt/event history
// into KPI roll-ups, time series, and per-group leaderboards. All three
// endpoints accept the common filter (`repos`, `from`, `to`) and return
// pre-aggregated rows so the Reports UI can render charts without shipping
// raw rows or doing client-side reduction.
//
// Duration metrics are reported in SECONDS. `from` is inclusive, `to`
// exclusive. Unless noted, a metric is computed over the "cohort" of tasks
// CREATED within [from, to) (optionally narrowed to `repos`).

/** Common filter applied to every report endpoint. */
export interface ReportFilter {
  /** Repo ids the report is scoped to, or null for all repos. */
  repos: number[] | null;
  /** Inclusive lower bound (ISO-8601). */
  from: string;
  /** Exclusive upper bound (ISO-8601). */
  to: string;
}

/** Mean + percentile summary of a set of durations (seconds). All fields
 *  are null when the filtered set is empty. */
export interface DurationStats {
  /** Number of values in the set. */
  count: number;
  /** Arithmetic mean (seconds), or null when count = 0. */
  avg_seconds: number | null;
  /** 50th percentile (nearest-rank), or null when count = 0. */
  p50_seconds: number | null;
  /** 90th percentile (nearest-rank), or null when count = 0. */
  p90_seconds: number | null;
}

export interface ReportsOverview {
  range: { from: string; to: string };
  repos: number[] | null;
  /** Tasks created in range, grouped by status. Every TaskStatus key is
   *  present (0 when none). */
  status_counts: Record<TaskStatus, number>;
  /** Total tasks created in range (sum of status_counts). */
  total_tasks: number;
  /** merged / (merged + failed + cancelled) over the created-in-range
   *  cohort, or null when no task in the cohort reached a terminal state. */
  success_rate: number | null;
  /** The terminal-state tallies the success rate is derived from. */
  terminal_counts: { merged: number; failed: number; cancelled: number };
  /** Throughput within range: tasks whose created_at falls in range, and
   *  tasks whose completed_at falls in range with status = merged. These
   *  use literal range membership (not the created cohort) so they line up
   *  with the timeseries endpoint. */
  throughput: { tasks_created: number; tasks_merged: number };
  /** Point-in-time backlog (NOT date-filtered): queued tasks, and the
   *  subset of those with at least one unsatisfied dependency. */
  backlog: { queued: number; blocked: number };
  /** completed_at − started_at across develop-role attempts in the cohort. */
  implementation_duration: DurationStats;
  /** completed_at − started_at across review-role attempts in the cohort. */
  review_duration: DurationStats;
  /** completed_at − created_at across merged tasks in the cohort. */
  lead_time: DurationStats;
  /** Average number of develop-role attempts per implemented task (1 = a
   *  single pass). Averaged over cohort tasks that have ≥1 develop attempt;
   *  `task_count` is that denominator. avg is null when it is 0. */
  rework: { avg: number | null; task_count: number };
}

export interface ReportsTimeseriesBucket {
  /** Bucket start as a YYYY-MM-DD date (the day, or the Monday of the week). */
  bucket: string;
  tasks_created: number;
  tasks_merged: number;
}

export interface ReportsTimeseries {
  range: { from: string; to: string };
  bucket: 'day' | 'week';
  series: ReportsTimeseriesBucket[];
}

export type LeaderboardGroupBy = 'model' | 'harness' | 'repo';

export interface LeaderboardRow {
  /** Grouping key: model_id, harness_id, or repo id (as a string). */
  key: string;
  /** Human-readable label (repo "owner/name"; otherwise same as key). */
  label: string;
  task_count: number;
  success_rate: number | null;
  terminal_counts: { merged: number; failed: number; cancelled: number };
  avg_implementation_seconds: number | null;
  avg_review_seconds: number | null;
  avg_rework: number | null;
  /** Average agent turns per attempt across attempts in this group that
   *  reported a turn count. Attempts with NULL num_turns are excluded from
   *  the average (not counted as 0). NULL when no attempt in the group
   *  reported turns. */
  avg_num_turns: number | null;
  /** Average total tokens (input + output) per attempt across attempts in
   *  this group that reported token usage. NULL-usage attempts are excluded
   *  from the average. NULL when no attempt reported tokens. */
  avg_total_tokens: number | null;
  /** Summed input tokens across the group (0 when none reported). Raw count
   *  for operators to price externally — no cost is computed here. */
  total_input_tokens: number;
  /** Summed output tokens across the group (0 when none reported). */
  total_output_tokens: number;
  verdicts: { approved: number; changes_needed: number; unclear: number };
}

export interface ReportsLeaderboard {
  range: { from: string; to: string };
  group_by: LeaderboardGroupBy;
  rows: LeaderboardRow[];
}

// ---------------------------------------------------------------------------
// Advanced reporting (durations distribution / funnel / reliability / heatmap)
// ---------------------------------------------------------------------------

/** Distributions and the funnel group by the per-attempt model/harness
 *  snapshot — the same keys the leaderboard uses (repo grouping isn't
 *  meaningful for a per-attempt duration distribution). */
export type DurationGroupBy = 'model' | 'harness';
/** Which attempt-role duration the distribution endpoint summarises. */
export type DurationMetric = 'implementation' | 'review';

/** Full percentile summary of a set of durations (seconds) for one group.
 *  Percentiles are nearest-rank. All stat fields are null when count = 0. */
export interface DurationDistribution {
  /** Grouping key (model_id or harness_id). */
  key: string;
  /** Human-readable label (same as key today; reserved for future maps). */
  label: string;
  count: number;
  min_seconds: number | null;
  p50_seconds: number | null;
  p90_seconds: number | null;
  p99_seconds: number | null;
  max_seconds: number | null;
  avg_seconds: number | null;
}

export interface ReportsDurations {
  range: { from: string; to: string };
  group_by: DurationGroupBy;
  metric: DurationMetric;
  groups: DurationDistribution[];
}

/** One stage of the lifecycle funnel. `count` is the number of cohort tasks
 *  that ever reached this stage; the conversion ratios are 0..1 (null when
 *  the denominator is 0). */
export interface FunnelStage {
  /** Stable stage key (created | preparing | in-progress | in-review | merged). */
  stage: string;
  /** Human-readable label. */
  label: string;
  count: number;
  /** count / first-stage count (overall conversion from "created"). */
  pct_of_created: number | null;
  /** count / previous-stage count (step conversion). null for the first stage. */
  pct_of_previous: number | null;
}

export interface ReportsFunnel {
  range: { from: string; to: string };
  repos: number[] | null;
  stages: FunnelStage[];
}

/** Total operational-incidence counts over the range. */
export interface ReliabilityCounts {
  /** `container_timeout_kill` events. */
  timeout_kills: number;
  /** `orphan_detected` events. */
  orphans_detected: number;
  /** `orphan_recovery_triggered` events. */
  orphans_recovered: number;
  /** `orphan_recovery_exhausted` events (recovery gave up). */
  orphans_exhausted: number;
  /** `review_deferred` events. */
  review_deferrals: number;
  /** Sum of `tasks.prep_failure_count` over the cohort (created-in-range,
   *  repo-filtered). Point-in-time counters rather than timestamped events,
   *  so they appear in the totals + per-repo breakdown but NOT the series. */
  prep_failures: number;
}

/** Per-bucket incidence for the reliability time-series. Prep failures are
 *  omitted (they carry no per-incident timestamp — see ReliabilityCounts). */
export interface ReliabilityTimeseriesBucket {
  /** Bucket start as YYYY-MM-DD (the day, or the Monday of the week). */
  bucket: string;
  timeout_kills: number;
  orphans_detected: number;
  orphans_recovered: number;
  orphans_exhausted: number;
  review_deferrals: number;
}

/** Per-repo reliability breakdown row. */
export interface ReliabilityRepoRow {
  /** Repo id as a string. */
  key: string;
  /** "owner/name". */
  label: string;
  timeout_kills: number;
  orphans_detected: number;
  orphans_recovered: number;
  orphans_exhausted: number;
  review_deferrals: number;
  prep_failures: number;
}

export interface ReportsReliability {
  range: { from: string; to: string };
  repos: number[] | null;
  bucket: 'day' | 'week';
  counts: ReliabilityCounts;
  series: ReliabilityTimeseriesBucket[];
  by_repo: ReliabilityRepoRow[];
}

/** Which activity drives the heatmap: task launches (created) or merges. */
export type HeatmapMetric = 'created' | 'merged';

/** One populated heatmap cell. Only non-zero cells are returned; the UI
 *  fills the rest of the 7×24 grid with zero. */
export interface HeatmapCell {
  /** Day of week, 0=Sunday … 6=Saturday (UTC, matches strftime('%w')). */
  dow: number;
  /** Hour of day, 0…23 (UTC). */
  hour: number;
  count: number;
}

export interface ReportsHeatmap {
  range: { from: string; to: string };
  metric: HeatmapMetric;
  cells: HeatmapCell[];
  /** Largest single-cell count (0 when empty) — the UI's colour-scale max. */
  max: number;
}
