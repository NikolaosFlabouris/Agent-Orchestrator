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

export const api = {
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
  getRepoIssues: (id: number) =>
    request<{ issues: IssueResponse[] }>('GET', `/api/repos/${id}/issues`),

  // -- Credentials --
  getCredentials: () =>
    request<{ credentials: CredentialStatus[] }>('GET', '/api/status/credentials'),

  // -- Tools --
  getTools: () =>
    request<{ tools: ToolResponse[] }>('GET', '/api/tools'),
  createTool: (data: Partial<ToolResponse>) =>
    request<ToolResponse>('POST', '/api/tools', data),
  updateTool: (id: string, data: Partial<ToolResponse>) =>
    request<ToolResponse>('PATCH', `/api/tools/${id}`, data),

  // -- Providers (concurrency pools) --
  getProviders: () =>
    request<{ providers: ProviderResponse[] }>('GET', '/api/providers'),
  createProvider: (data: Partial<ProviderResponse>) =>
    request<ProviderResponse>('POST', '/api/providers', data),
  updateProvider: (id: string, data: Partial<ProviderResponse>) =>
    request<ProviderResponse>('PATCH', `/api/providers/${id}`, data),
  deleteProvider: (id: string) =>
    request<void>('DELETE', `/api/providers/${id}`),
};

// -- Types --

export interface TaskResponse {
  id: number;
  issue_id: number;
  issue_title: string;
  repo: { id: number; owner: string; name: string } | null;
  branch_name: string | null;
  pr_number: number | null;
  status: string;
  queue_position: number | null;
  attempt: number;
  max_attempts: number;
  agent_tool: string | null;
  container_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  blocked_by: number[];
  /** Runtime health derived from container state. 'orphaned' means the
   *  task looks active but its container has vanished; the orchestrator
   *  will attempt recovery on the next sweep. Optional: POST/PATCH
   *  responses omit it. */
  health?: 'healthy' | 'orphaned' | 'idle';
  /** Human-readable container name if one is currently running.
   *  Only populated on the single-task detail endpoint. */
  container_name?: string | null;
  /** Computed effective tool: task.agent_tool if set, else repo.agent_tool. */
  effective_agent_tool_id: string | null;
  /** Whether the effective tool comes from the task override or the repo default. */
  agent_tool_source: 'task' | 'repo';
  /** The repo's configured baseline tool, regardless of any task-level override.
   *  Always present so the UI can label "Use repo default (<name>)" even when
   *  agent_tool_source === 'task'. */
  repo_agent_tool: string | null;
}

export interface TaskEventResponse {
  id: number;
  task_id: number;
  event_type: string;
  message: string;
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
  model: string | null;
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
  daily_completions: number;
  forgejo_base_url: string;
  forgejo_connected: boolean;
  uptime_seconds: number;
  /** Per-provider active-slot / concurrency-limit breakdown. Empty array when
   *  no providers are configured (pre-v4 install or opt-out). */
  providers: Array<{
    id: string;
    display_name: string;
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
  agent_tool?: string | null;
  model?: string | null;
  max_attempts?: number;
  human_merge?: boolean;
  human_review?: boolean;
}

export interface QueueTaskRequest {
  issue_id: number;
  repo_id: number;
  agent_tool?: string | null;
  max_attempts?: number | null;
  human_merge?: boolean;
  human_review?: boolean;
}

export type TaskAction =
  | { action: 'reorder'; queue_position: number }
  | { action: 'cancel'; reason?: string }
  | { action: 'force_approve' }
  | { action: 'force_fail'; reason?: string }
  | { action: 'reset' }
  | { action: 'requeue' }
  | { action: 'extend'; additional_attempts: number }
  | { agent_tool: string | null }
  | { max_attempts: number };

export interface RepoResponse {
  id: number;
  owner: string;
  name: string;
  base_branch: string;
  agent_tool: string;
  install_steps: InstallStep[];
  allow_script_steps: boolean;
  container_memory_mb: number | null;
  container_cpu_cores: number | null;
  merge_strategy: 'squash' | 'merge' | 'rebase';
}

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

export interface ToolResponse {
  id: string;
  display_name: string;
  type: string;
  command_template: string | null;
  env_vars: Record<string, string>;
  config_file_path: string | null;
  config_file_content: string | null;
  /** NOT NULL since schema v17. Form pre-fill for new tools is 2880. */
  timeout_minutes: number;
  provider_id: string | null;
}

export interface ProviderResponse {
  id: string;
  display_name: string;
  concurrency_limit: number;
  notes: string | null;
  /** Number of tool rows referencing this provider (from GET/PATCH/POST). */
  tools_using: number;
  /** Number of tasks currently holding a slot against this provider. */
  active_slots: number;
}

export interface CredentialStatus {
  name: string;
  configured: boolean;
  /** "orchestrator" — used by the orchestrator process itself.
   *  "forwarded" — included in FORWARDED_KEYS, sent into every agent container. */
  scope: 'orchestrator' | 'forwarded';
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
