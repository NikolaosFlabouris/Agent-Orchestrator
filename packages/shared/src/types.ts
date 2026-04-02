/** Database row types matching the SQL schema exactly. */

export interface Task {
  id: number;
  issue_id: number;
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
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  cost_usd: number | null;
}

export type AttemptRole = 'develop' | 'review';
export type AttemptStatus = 'running' | 'completed' | 'failed' | 'timeout';

export interface Repo {
  id: number;
  owner: string;
  name: string;
  base_branch: string;
  image_type: string;
  agent_tool: string;
  pre_agent_script: string | null;
  model: string | null;
  max_turns: number | null;
  timeout_minutes: number | null;
  container_memory_mb: number | null;
  container_cpu_cores: number | null;
  last_image_build: string | null;
}

export interface AgentTool {
  id: string;
  display_name: string;
  type: AgentToolType;
  command_template: string | null;
  env_vars: string;
  auth_type: string;
  auth_config: string;
}

export type AgentToolType = 'sdk' | 'cli';

export interface Settings {
  schema_version: string;
  max_concurrency: string;
  default_max_attempts: string;
  agent_timeout_minutes: string;
  default_model: string;
  default_max_turns: string;
  poll_interval_seconds: string;
  merge_strategy: string;
  model_pricing: string;
  workspace_retention_days: string;
  disk_threshold_bytes: string;
  default_container_memory_mb: string;
  default_container_cpu_cores: string;
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
