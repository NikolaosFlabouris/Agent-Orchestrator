import type {
  ReportsOverview,
  ReportsTimeseries,
  ReportsLeaderboard,
  LeaderboardGroupBy,
  ReportsDurations,
  DurationGroupBy,
  DurationMetric,
  ReportsFunnel,
  ReportsReliability,
  ReportsHeatmap,
  HeatmapMetric,
  ProfileGauge,
  ReportsTasksPage,
  ReportTasksSort,
  TaskStatus,
  TaskView,
  OrchestratorAlert,
} from '@orchestrator/shared';

const BASE = '';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    window.location.href = '/auth/login';
    throw new Error('Unauthorized — redirecting to login');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Common filter accepted by every `/api/reports/*` endpoint. `repos`
 *  omitted/empty = all repos; `from`/`to` omitted = the backend default
 *  window. Values are ISO strings (or `YYYY-MM-DD`, which the server parses
 *  as UTC midnight). */
export interface ReportQuery {
  repos?: number[];
  from?: string;
  to?: string;
}

/** Query for the paginated All Tasks browser (`GET /api/reports/tasks`).
 *  Extends the common ReportQuery with a status filter, free-text search,
 *  sort, and pagination. Empty fields are omitted so the server applies its
 *  defaults. */
export interface ReportTasksQuery extends ReportQuery {
  status?: TaskStatus;
  search?: string;
  sort?: ReportTasksSort;
  offset?: number;
  limit?: number;
}

/** Serialise a ReportQuery (plus the endpoint-specific `bucket`/`groupBy`)
 *  into a `?…` string, omitting empty params so the server falls back to its
 *  defaults. Mirrors the server-side `parseFilter` contract in reports.ts. */
function reportQuery(
  filter?: ReportQuery,
  extra?: {
    bucket?: 'day' | 'week';
    groupBy?: LeaderboardGroupBy | DurationGroupBy;
    metric?: DurationMetric | HeatmapMetric;
  }
): string {
  const qs = new URLSearchParams();
  if (filter?.repos && filter.repos.length > 0) {
    qs.set('repos', filter.repos.join(','));
  }
  if (filter?.from) qs.set('from', filter.from);
  if (filter?.to) qs.set('to', filter.to);
  if (extra?.bucket) qs.set('bucket', extra.bucket);
  if (extra?.groupBy) qs.set('groupBy', extra.groupBy);
  if (extra?.metric) qs.set('metric', extra.metric);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

export const api = {
  // -- Identity --
  getMe: () => request<MeResponse>('GET', '/api/me'),

  // -- Tasks --
  getTasks: (params?: { status?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return request<{ tasks: TaskResponse[] }>('GET', `/api/tasks${query ? '?' + query : ''}`);
  },
  getTask: (id: number) =>
    request<TaskDetailResponse>('GET', `/api/tasks/${id}`),
  recheckDependencies: (id: number) =>
    request<{ dependencies: TaskDependencyResponse[]; blocked: boolean }>(
      'POST',
      `/api/tasks/${id}/dependencies/recheck`
    ),
  createTask: (data: CreateTaskRequest) =>
    request<TaskResponse>('POST', '/api/tasks', data),
  queueTask: (data: QueueTaskRequest) =>
    request<TaskResponse>('POST', '/api/tasks/queue', data),
  patchTask: (id: number, body: TaskAction) =>
    request<TaskResponse>('PATCH', `/api/tasks/${id}`, body),

  // -- Status --
  getStatus: () =>
    request<StatusResponse>('GET', '/api/status'),
  getHostCapacity: () =>
    request<HostCapacityResponse>('GET', '/api/status/host-capacity'),
  /** Active alert conditions, recomputed server-side on every call.
   *  Deliberately a SEPARATE endpoint from `GET /api/status`: `checkAlerts`
   *  walks every task (plus its active attempt and resolved profile), which
   *  is far too much work to hang off the status poll the header depends on.
   *  The Dashboard piggybacks this onto the same 60s tick instead. */
  getAlerts: () =>
    request<{ alerts: OrchestratorAlert[] }>('GET', '/api/status/alerts'),
  pause: () => request('POST', '/api/status/pause'),
  resume: () => request('POST', '/api/status/resume'),

  // -- Settings --
  getSettings: () =>
    request<Record<string, unknown>>('GET', '/api/settings'),
  updateSettings: (updates: Record<string, unknown>) =>
    request<Record<string, unknown>>('PATCH', '/api/settings', updates),

  // -- Repos --
  getAvailableRepos: () =>
    request<{ repos: ForgejoRepoResponse[] }>('GET', '/api/repos/available'),
  getRepos: () =>
    request<{ repos: RepoResponse[] }>('GET', '/api/repos'),
  createRepo: (data: Partial<RepoResponse>) =>
    request<RepoResponse>('POST', '/api/repos', data),
  updateRepo: (id: number, data: Partial<RepoResponse>) =>
    request<RepoResponse>('PATCH', `/api/repos/${id}`, data),
  getRepoIssues: (id: number, opts?: { all?: boolean }) =>
    request<{ issues: IssueResponse[] }>(
      'GET',
      `/api/repos/${id}/issues${opts?.all ? '?all=true' : ''}`
    ),

  // -- Credentials --
  getCredentials: () =>
    request<{ credentials: CredentialStatus[] }>('GET', '/api/status/credentials'),

  // -- Providers (concrete connection identities + concurrency pools) --
  getProviderKinds: () =>
    request<{ kinds: ProviderKindSpec[] }>('GET', '/api/provider-kinds'),
  getProviders: () =>
    request<{ providers: ProviderResponse[] }>('GET', '/api/providers'),
  createProvider: (data: ProviderWriteRequest) =>
    request<ProviderResponse>('POST', '/api/providers', data),
  updateProvider: (id: string, data: ProviderWriteRequest) =>
    request<ProviderResponse>('PATCH', `/api/providers/${id}`, data),
  deleteProvider: (id: string) =>
    request<void>('DELETE', `/api/providers/${id}`),

  // -- Models (nested under each provider) --
  getProviderModels: (providerId: string) =>
    request<{ models: ModelResponse[] }>(
      'GET',
      `/api/providers/${encodeURIComponent(providerId)}/models`
    ),
  createModel: (providerId: string, data: { model_id: string; display_name: string }) =>
    request<ModelResponse>(
      'POST',
      `/api/providers/${encodeURIComponent(providerId)}/models`,
      data
    ),
  updateModel: (pk: number, data: Partial<Pick<ModelResponse, 'display_name'>>) =>
    request<ModelResponse>('PATCH', `/api/models/${pk}`, data),
  deleteModel: (pk: number) =>
    request<void>('DELETE', `/api/models/${pk}`),

  // -- Reports (read-only aggregates) --
  getReportOverview: (filter?: ReportQuery) =>
    request<ReportsOverview>(
      'GET',
      `/api/reports/overview${reportQuery(filter)}`
    ),
  getReportTimeseries: (filter?: ReportQuery, bucket?: 'day' | 'week') =>
    request<ReportsTimeseries>(
      'GET',
      `/api/reports/timeseries${reportQuery(filter, { bucket })}`
    ),
  getReportLeaderboard: (groupBy: LeaderboardGroupBy, filter?: ReportQuery) =>
    request<ReportsLeaderboard>(
      'GET',
      `/api/reports/leaderboard${reportQuery(filter, { groupBy })}`
    ),
  getReportDurations: (
    groupBy: DurationGroupBy,
    metric: DurationMetric,
    filter?: ReportQuery
  ) =>
    request<ReportsDurations>(
      'GET',
      `/api/reports/durations${reportQuery(filter, { groupBy, metric })}`
    ),
  getReportFunnel: (filter?: ReportQuery) =>
    request<ReportsFunnel>('GET', `/api/reports/funnel${reportQuery(filter)}`),
  getReportReliability: (filter?: ReportQuery, bucket?: 'day' | 'week') =>
    request<ReportsReliability>(
      'GET',
      `/api/reports/reliability${reportQuery(filter, { bucket })}`
    ),
  getReportHeatmap: (metric: HeatmapMetric, filter?: ReportQuery) =>
    request<ReportsHeatmap>(
      'GET',
      `/api/reports/heatmap${reportQuery(filter, { metric })}`
    ),
  /** Paginated "All Tasks" browser over the full task history. Combines the
   *  common report filter (repos + from/to) with a status filter, free-text
   *  search, sort, and offset/limit pagination. */
  getReportTasks: (params?: ReportTasksQuery) => {
    const qs = new URLSearchParams();
    if (params?.repos && params.repos.length > 0) {
      qs.set('repos', params.repos.join(','));
    }
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.status) qs.set('status', params.status);
    if (params?.search) qs.set('search', params.search);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.offset != null) qs.set('offset', String(params.offset));
    if (params?.limit != null) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return request<ReportsTasksPage>(
      'GET',
      `/api/reports/tasks${query ? '?' + query : ''}`
    );
  },
  /** Inline Create-Task performance gauge for one (repo, model, harness)
   *  combination. Advisory only — callers must tolerate the loading/empty/
   *  error states without blocking task creation. */
  getProfileGauge: (params: { repo: number; model: string; harness: string }) => {
    const qs = new URLSearchParams({
      repo: String(params.repo),
      model: params.model,
      harness: params.harness,
    });
    return request<ProfileGauge>(
      'GET',
      `/api/reports/profile-gauge?${qs.toString()}`
    );
  },

  // -- Harnesses (read-only registry) --
  getHarnesses: () =>
    request<{ harnesses: HarnessSpec[] }>('GET', '/api/harnesses'),

  // -- Agent profiles (harness + model + per-harness config) --
  getAgentProfiles: () =>
    request<{ profiles: AgentProfileResponse[] }>('GET', '/api/agent-profiles'),
  createAgentProfile: (data: Partial<AgentProfileResponse>) =>
    request<AgentProfileResponse>('POST', '/api/agent-profiles', data),
  updateAgentProfile: (id: string, data: Partial<AgentProfileResponse>) =>
    request<AgentProfileResponse>(
      'PATCH',
      `/api/agent-profiles/${encodeURIComponent(id)}`,
      data
    ),
  deleteAgentProfile: (id: string) =>
    request<void>('DELETE', `/api/agent-profiles/${encodeURIComponent(id)}`),
};

// -- Types --

/** Forgejo identity captured at login. Fields are optional because the
 *  /auth/callback userinfo lookup is best-effort — a session can exist
 *  with no identity attached. `user` is null when auth is disabled. */
export interface AuthUser {
  login?: string;
  name?: string;
  avatar_url?: string;
}

export interface MeResponse {
  user: AuthUser | null;
}

/** The task object every task endpoint returns AND every dashboard
 *  WebSocket event carries. Defined once in `@orchestrator/shared`
 *  (`TaskView`) and produced by a single server-side serializer, so REST
 *  and WS payloads cannot drift apart — see packages/server/src/task-view.ts.
 *  Aliased here because the rest of the client refers to it by the
 *  `*Response` naming convention. */
export type TaskResponse = TaskView;

export type DependencyState =
  | 'satisfied'
  | 'manually-satisfied'
  | 'open'
  | 'in-progress'
  | 'failed'
  | 'missing'
  | 'error'
  | 'cycle';

export interface TaskDependencyResponse {
  id: number;
  task_id: number;
  /** Issue (or PR) number in the task's repo. */
  dep_issue_number: number;
  state: DependencyState;
  /** Evidence/reason, e.g. "merged via task #12 / PR #52". */
  detail: string | null;
  /** Raw checkbox state from the issue body (`- [x]` = manual override). */
  checked: boolean;
  first_seen_at: string;
  last_evaluated_at: string | null;
}

export interface TaskEventResponse {
  id: number;
  task_id: number;
  event_type: string;
  message: string;
  /** ISO 8601 UTC string (e.g. `"2026-05-12T12:31:59.123Z"`). Legacy rows
   *  written before the fix for issue #72 may still hold the naive
   *  `"YYYY-MM-DD HH:MM:SS"` format; the UI normalizes those on read. */
  created_at: string;
}

export interface TaskDetailResponse extends TaskResponse {
  attempts: AttemptResponse[];
  events: TaskEventResponse[];
  forgejo_links: Record<string, string>;
}

export interface AttemptResponse {
  id: number;
  attempt_number: number;
  role: string;
  status: string;
  verdict: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** Snapshot of the model_id used at attempt-launch. */
  model_id: string | null;
  /** Snapshot of the harness used at attempt-launch. */
  harness_id: string | null;
  /** Per-run effort metrics read from the harness at completion. NULL =
   *  unknown (harness emitted no usage); never conflate with a real 0. */
  num_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_calls: number | null;
  /** PR code-churn stats captured at review/merge time (#116). NULL =
   *  unknown (a develop attempt, a pre-#116 row, or a failed PR fetch);
   *  never conflate with a real 0. */
  changed_files: number | null;
  additions: number | null;
  deletions: number | null;
  feedback: string | null;
}

export interface StatusResponse {
  state: string;
  /** Host resource pool — utilisation vs cap on each dimension. */
  host_pool: {
    memory_used_mb: number;
    memory_total_mb: number;
    cpu_used_cores: number;
    cpu_total_cores: number;
  };
  queue_depth: number;
  forgejo_base_url: string;
  forgejo_connected: boolean;
  uptime_seconds: number;
  /** Per-provider active-slot / concurrency-limit breakdown. */
  providers: Array<{
    id: string;
    display_name: string;
    kind: ProviderKind;
    concurrency_limit: number;
    active_slots: number;
  }>;
}

export interface HostCapacityResponse {
  /** 'docker' = detected via the Docker daemon (true container ceiling).
   *  'os' = fallback when the daemon was unreachable (orchestrator's view of
   *  the host, may differ from what Docker can actually allocate). */
  source: 'docker' | 'os';
  memory_total_mb: number;
  cpu_cores: number;
}

export interface CreateTaskRequest {
  repo_id: number;
  title: string;
  description: string;
  /** Issue numbers this task waits for — written into the issue body as
   *  the canonical `## Dependencies` checklist. */
  dependencies?: number[];
  /** Per-task implementation profile override. Null inherits from repo / global default. */
  agent_profile_id?: string | null;
  /** Per-task review profile override. Null inherits (repo review default
   *  → global review default → implementation profile). */
  review_agent_profile_id?: string | null;
  max_attempts?: number;
  human_merge?: boolean;
  human_review?: boolean;
}

export interface QueueTaskRequest {
  issue_id: number;
  repo_id: number;
  /** Issue numbers to ADD to the issue's `## Dependencies` section. */
  dependencies?: number[];
  agent_profile_id?: string | null;
  review_agent_profile_id?: string | null;
  max_attempts?: number | null;
  human_merge?: boolean;
  human_review?: boolean;
}

export type TaskAction =
  | { action: 'reorder'; queue_position: number }
  | { action: 'cancel'; reason?: string }
  | { action: 'close'; reason?: string }
  | { action: 'force_approve' }
  | { action: 'force_fail'; reason?: string }
  | { action: 'reset' }
  | { action: 'requeue' }
  | { action: 'extend'; additional_attempts: number }
  | { agent_profile_id: string | null }
  | { review_agent_profile_id: string | null }
  | { max_attempts: number };

export interface RepoResponse {
  id: number;
  owner: string;
  name: string;
  base_branch: string;
  /** Repo-default implementation profile. Null falls back to
   *  settings.default_agent_profile_id. */
  agent_profile_id: string | null;
  /** Repo-default review profile. Null falls back to
   *  settings.default_review_agent_profile_id, then the implementation
   *  profile. */
  review_agent_profile_id: string | null;
  install_steps: InstallStep[];
  allow_script_steps: boolean;
  container_memory_mb: number | null;
  container_cpu_cores: number | null;
  merge_strategy: 'squash' | 'merge' | 'rebase';
}

// -- Install steps --

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

export type InstallStep =
  | { kind: InstallStepKind; cwd?: string }
  | { kind: 'script'; path: string; cwd?: string };

/** Display label per kind for the dropdown. The literal command on the
 *  right-hand side is informational — it's also hardcoded server-side. */
export const INSTALL_STEP_LABELS: Record<InstallStepKind, string> = {
  'npm-ci': 'npm ci',
  'npm-install': 'npm install',
  'yarn-install': 'yarn install',
  'pnpm-install': 'pnpm install',
  'pip-requirements': 'pip install -r requirements.txt',
  'pip-pyproject': 'pip install -e .',
  'uv-sync': 'uv sync',
  'cargo-fetch': 'cargo fetch',
  'go-mod-download': 'go mod download',
};

// -- Providers, models, harnesses, agent profiles --

export type ProviderKind =
  | 'anthropic'
  | 'claude-subscription'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'deepseek'
  | 'openrouter'
  | 'ollama';

export interface ProviderKindSpec {
  kind: ProviderKind;
  display_name: string;
  description: string;
  requires_base_url: boolean;
  container_env_name: string | null;
  auth_optional: boolean;
}

export interface ProviderResponse {
  id: string;
  display_name: string;
  kind: ProviderKind;
  concurrency_limit: number;
  base_url: string | null;
  /** Presence-only flag for the inline auth token. The literal value is
   *  database-internal and never returned by the API (C1). The UI shows
   *  "**** (stored)" with explicit Replace / Clear affordances and only
   *  PATCHes `auth_token` when the operator actually edits it. */
  has_auth_token: boolean;
  api_key_env_var: string | null;
  notes: string | null;
  /** How many models reference this provider. */
  models_count: number;
  /** Number of tasks currently holding a slot against this provider. */
  active_slots: number;
}

/** Write-only payload for POST /api/providers and PATCH /api/providers/:id.
 *  Mirrors `ProviderResponse` minus the read-only stat fields, and
 *  includes the write-only `auth_token` (string to set, null to clear,
 *  absent to leave the stored value untouched). */
export interface ProviderWriteRequest {
  id?: string;
  display_name?: string;
  kind?: ProviderKind;
  concurrency_limit?: number;
  base_url?: string | null;
  /** Write-only. Absent → preserve stored value. null/'' → clear. string →
   *  replace. The GET response never contains this field; the form must
   *  never echo it back unless the operator explicitly edited it. */
  auth_token?: string | null;
  api_key_env_var?: string | null;
  notes?: string | null;
}

export interface ModelResponse {
  id: number;
  provider_id: string;
  model_id: string;
  display_name: string;
}

/** The set of harness ids the client currently knows about. New
 *  harnesses added server-side without a corresponding client deploy
 *  appear at runtime — `HarnessId` widens to `string` so that case
 *  doesn't fail typecheck or runtime narrowing, but the literal union
 *  still gives autocomplete / exhaustiveness hints in switch-like
 *  blocks for the known set. Concretely:
 *    - `harness.id === 'claude-sdk'` continues to narrow correctly.
 *    - An unknown id from the server (e.g. a new 'cursor' harness) is
 *      still assignable to `HarnessId` and flows through dropdowns
 *      and lookups without TS errors.
 *  See `HarnessConfigForm` in Settings/AgentProfileSettings.tsx for the
 *  fall-through "no config UI" handling of unknown ids. */
export type KnownHarnessId = 'claude-sdk' | 'claude-code' | 'opencode' | 'pi';
export type HarnessId = KnownHarnessId | (string & {});

export interface HarnessSpec {
  id: HarnessId;
  display_name: string;
  runtime: 'sdk' | 'cli';
  supported_provider_kinds: ProviderKind[];
}

export interface AgentProfileResponse {
  id: string;
  display_name: string;
  harness_id: HarnessId;
  /** FK to models.id (surrogate). The provider is reachable via the model. */
  model_pk: number;
  config_json: Record<string, unknown>;
  timeout_minutes: number;
  /** Stat: how many repos default to this profile. */
  repos_using: number;
  /** Stat: how many tasks have this profile as a per-task override. */
  tasks_using: number;
  /** Convenience: surface the resolved provider+model so the UI doesn't
   *  need to walk the chain itself. */
  provider_id: string | null;
  model_id: string | null;
}

export interface CredentialStatus {
  name: string;
  configured: boolean;
  /** "orchestrator" — used by the orchestrator process itself.
   *  "provider" — points at a provider's `api_key_env_var`. */
  scope: 'orchestrator' | 'provider';
  /** Set when scope='provider'. */
  provider_id: string | null;
}

export interface ForgejoRepoResponse {
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
}

export interface IssueResponse {
  id: number;
  title: string;
  created_at: string;
}
