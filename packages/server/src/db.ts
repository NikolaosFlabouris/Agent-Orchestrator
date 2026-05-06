import Database from 'better-sqlite3';
import type {
  Task,
  TaskStatus,
  Attempt,
  AttemptRole,
  AttemptStatus,
  Repo,
  AgentTool,
  Provider,
  TaskEvent,
  SettingsKey,
} from '@orchestrator/shared';

const CURRENT_SCHEMA_VERSION = 6;

let _db: Database.Database;

/**
 * Initialize the database, create tables, run migrations, seed defaults.
 * Returns the database instance.
 */
export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode for crash resilience and better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Retry busy queries for up to 5 seconds
  db.pragma('busy_timeout = 5000');
  // Enforce foreign keys
  db.pragma('foreign_keys = ON');

  createTables(db);
  runMigrations(db);

  _db = db;
  return db;
}

/** Get the initialized database instance. */
export function getDb(): Database.Database {
  if (!_db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      base_branch TEXT DEFAULT 'main',
      image_type TEXT NOT NULL,
      agent_tool TEXT NOT NULL,
      pre_agent_script TEXT,
      model TEXT,
      max_turns INTEGER,
      timeout_minutes INTEGER,
      container_memory_mb INTEGER,
      container_cpu_cores INTEGER,
      UNIQUE(owner, name)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      issue_id INTEGER NOT NULL,
      issue_title TEXT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      branch_name TEXT,
      pr_number INTEGER,
      status TEXT NOT NULL,
      queue_position INTEGER,
      attempt INTEGER DEFAULT 1,
      max_attempts INTEGER DEFAULT 3,
      prep_failure_count INTEGER DEFAULT 0,
      agent_tool TEXT,
      model TEXT,
      container_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(issue_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_repo_id ON tasks(repo_id);

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      attempt_number INTEGER,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT,
      started_at TEXT,
      completed_at TEXT,
      log_path TEXT,
      feedback TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      model TEXT,
      cost_usd REAL
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_task_id ON attempts(task_id);

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      -- Per-provider concurrency cap. 0 means "paused" (no task assigned to
      -- this provider launches). NULL is not allowed. The scheduler still
      -- respects settings.max_concurrency as an absolute ceiling across all
      -- providers.
      concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_tools (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      type TEXT NOT NULL,
      command_template TEXT,
      env_vars TEXT NOT NULL DEFAULT '{}',
      auth_type TEXT NOT NULL,
      auth_config TEXT NOT NULL DEFAULT '{}',
      -- Optional per-tool timeout. Null = fall through to repo then global.
      timeout_minutes INTEGER,
      -- Optional provider this tool belongs to, for concurrency pooling.
      -- Null = tool has no pool; counts against the global max_concurrency
      -- ceiling only.
      provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);

    CREATE TABLE IF NOT EXISTS task_steps (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      attempt_number INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      result_json TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, attempt_number, step_name)
    );

    CREATE INDEX IF NOT EXISTS idx_task_steps_task_attempt
      ON task_steps(task_id, attempt_number);
  `);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function runMigrations(db: Database.Database): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const version = row ? parseInt(row.value, 10) : 0;

  if (version < 1) {
    seedDefaultSettings(db);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '1')"
    ).run();
  }

  if (version < 2) {
    // Add task_events table (created by CREATE TABLE IF NOT EXISTS above for new installs,
    // this migration handles existing databases upgrading from version 1)
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
    `);
    db.prepare("UPDATE settings SET value = '2' WHERE key = 'schema_version'").run();
  }

  if (version < 3) {
    // Per-tool timeout override. Null means fall through to repo/global.
    // Useful for raising the limit on free/local tools (e.g. OpenCode + Ollama
    // on a 30B parameter model) without loosening API-backed tool budgets.
    const cols = db
      .prepare("PRAGMA table_info(agent_tools)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'timeout_minutes')) {
      db.exec('ALTER TABLE agent_tools ADD COLUMN timeout_minutes INTEGER');
    }
    db.prepare("UPDATE settings SET value = '3' WHERE key = 'schema_version'").run();
  }

  if (version < 4) {
    // Provider-scoped concurrency pools. A provider represents an upstream
    // resource (e.g. a specific Ollama server, an Anthropic API key's rate-
    // limit bucket) and carries a concurrency_limit. Tools assigned to the
    // same provider serialise; tools on different providers run in parallel.
    // Tools with NULL provider_id count against settings.max_concurrency only
    // (preserves pre-v4 semantics verbatim for existing installs — no tools
    // are auto-assigned; the user opts in by creating providers in the UI).
    db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
        notes TEXT
      );
    `);
    const toolCols = db
      .prepare("PRAGMA table_info(agent_tools)")
      .all() as Array<{ name: string }>;
    if (!toolCols.some((c) => c.name === 'provider_id')) {
      db.exec(
        'ALTER TABLE agent_tools ADD COLUMN provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL'
      );
    }
    db.prepare("UPDATE settings SET value = '4' WHERE key = 'schema_version'").run();
  }

  if (version < 5) {
    // Rewrite legacy agent_tools command_templates that inlined the prompt
    // via "${TASK_PROMPT}" to the safe "$(cat {{PROMPT_FILE}})" form. The
    // legacy form exposed shell metacharacters in user-authored issue bodies
    // to bash -c, causing non-trivial prompts to be parsed as commands and
    // the agent to never start. harness-cli.sh no longer honours the legacy
    // placeholder, so this rewrite is required for pre-v5 installs to keep
    // working after the harness images are rebuilt.
    const legacyRows = db
      .prepare(
        "SELECT id, command_template FROM agent_tools WHERE command_template LIKE '%${TASK_PROMPT}%'"
      )
      .all() as Array<{ id: string; command_template: string }>;
    const updateTpl = db.prepare(
      'UPDATE agent_tools SET command_template = ? WHERE id = ?'
    );
    for (const row of legacyRows) {
      const migrated = row.command_template
        .replace(/"\$\{TASK_PROMPT\}"/g, '"$(cat {{PROMPT_FILE}})"')
        .replace(/'\$\{TASK_PROMPT\}'/g, "'$(cat {{PROMPT_FILE}})'");
      if (migrated !== row.command_template) {
        updateTpl.run(migrated, row.id);
      }
    }
    db.prepare("UPDATE settings SET value = '5' WHERE key = 'schema_version'").run();
  }

  if (version < 6) {
    // Step-checkpoint table for idempotent orchestrator operations.
    // Both new installs (via createTables) and existing databases go through
    // this path — CREATE TABLE IF NOT EXISTS makes it safe to run twice.
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_steps (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        attempt_number INTEGER NOT NULL,
        step_name TEXT NOT NULL,
        result_json TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, attempt_number, step_name)
      );

      CREATE INDEX IF NOT EXISTS idx_task_steps_task_attempt
        ON task_steps(task_id, attempt_number);
    `);
    db.prepare("UPDATE settings SET value = '6' WHERE key = 'schema_version'").run();
  }
}

function seedDefaultSettings(db: Database.Database): void {
  const defaults: Record<string, string> = {
    schema_version: '1',
    max_concurrency: '5',
    default_max_attempts: '3',
    agent_timeout_minutes: '30',
    default_model: 'sonnet',
    default_max_turns: '100',
    poll_interval_seconds: '60',
    merge_strategy: 'squash',
    model_pricing: JSON.stringify({
      'claude-sonnet-4': { input_per_mtok: 3, output_per_mtok: 15 },
      'claude-opus-4': { input_per_mtok: 5, output_per_mtok: 25 },
      'claude-haiku-4': { input_per_mtok: 1, output_per_mtok: 5 },
    }),
    workspace_retention_days: '7',
    disk_threshold_bytes: '53687091200',
    default_container_memory_mb: '4096',
    default_container_cpu_cores: '2',
  };

  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );

  const seedAll = db.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) {
      insert.run(key, value);
    }
  });

  seedAll();
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

// -- Tasks --

export function getTask(id: number): Task | undefined {
  return getDb()
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(id) as Task | undefined;
}

export function getTaskByIssue(issueId: number): Task | undefined {
  return getDb()
    .prepare('SELECT * FROM tasks WHERE issue_id = ?')
    .get(issueId) as Task | undefined;
}

export function getTasks(filter?: { status?: TaskStatus; repo_id?: number }): Task[] {
  let sql = 'SELECT * FROM tasks';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.repo_id) {
    conditions.push('repo_id = ?');
    params.push(filter.repo_id);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY queue_position ASC, id ASC';

  return getDb().prepare(sql).all(...params) as Task[];
}

export function getQueuedTasks(): Task[] {
  return getDb()
    .prepare(
      "SELECT * FROM tasks WHERE status = 'queued' ORDER BY queue_position ASC, id ASC"
    )
    .all() as Task[];
}

export function getActiveTaskCount(): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE status IN ('preparing', 'in-progress', 'in-review', 'changes-needed')"
    )
    .get() as { count: number };
  return row.count;
}

export function insertTask(task: {
  issue_id: number;
  issue_title?: string | null;
  repo_id: number;
  status: TaskStatus;
  queue_position?: number;
  max_attempts?: number;
  agent_tool?: string | null;
  model?: string | null;
}): Task {
  const queuePos =
    task.queue_position ??
    ((
      getDb()
        .prepare('SELECT MAX(queue_position) as max_pos FROM tasks')
        .get() as { max_pos: number | null }
    ).max_pos ?? 0) + 1;

  const result = getDb()
    .prepare(
      `INSERT INTO tasks (issue_id, issue_title, repo_id, status, queue_position, max_attempts, agent_tool, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.issue_id,
      task.issue_title ?? null,
      task.repo_id,
      task.status,
      queuePos,
      task.max_attempts ?? 3,
      task.agent_tool ?? null,
      task.model ?? null
    );

  return getTask(result.lastInsertRowid as number)!;
}

export function updateTask(
  id: number,
  updates: Partial<
    Pick<
      Task,
      | 'status'
      | 'branch_name'
      | 'pr_number'
      | 'queue_position'
      | 'attempt'
      | 'max_attempts'
      | 'prep_failure_count'
      | 'agent_tool'
      | 'model'
      | 'container_id'
      | 'started_at'
      | 'completed_at'
    >
  >
): void {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = ?`);
    params.push(value ?? null);
  }

  if (setClauses.length === 0) return;

  params.push(id);
  getDb()
    .prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...params);
}

// -- Attempts --

export function insertAttempt(attempt: {
  task_id: number;
  attempt_number: number;
  role: AttemptRole;
  status: AttemptStatus;
  started_at?: string;
  model?: string;
}): Attempt {
  const result = getDb()
    .prepare(
      `INSERT INTO attempts (task_id, attempt_number, role, status, started_at, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      attempt.task_id,
      attempt.attempt_number,
      attempt.role,
      attempt.status,
      attempt.started_at ?? new Date().toISOString(),
      attempt.model ?? null
    );

  return getDb()
    .prepare('SELECT * FROM attempts WHERE id = ?')
    .get(result.lastInsertRowid) as Attempt;
}

export function updateAttempt(
  id: number,
  updates: Partial<
    Pick<
      Attempt,
      | 'status'
      | 'verdict'
      | 'completed_at'
      | 'log_path'
      | 'feedback'
      | 'input_tokens'
      | 'output_tokens'
      | 'model'
      | 'cost_usd'
    >
  >
): void {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = ?`);
    params.push(value ?? null);
  }

  if (setClauses.length === 0) return;

  params.push(id);
  getDb()
    .prepare(`UPDATE attempts SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...params);
}

export function getAttempts(taskId: number): Attempt[] {
  return getDb()
    .prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY id ASC')
    .all(taskId) as Attempt[];
}

/**
 * Find a running attempt by composite key (for recovery).
 * On restart, activeState is lost — this looks up the attempt row directly.
 */
export function getRunningAttempt(
  taskId: number,
  attemptNumber: number,
  role: AttemptRole
): Attempt | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM attempts WHERE task_id = ? AND attempt_number = ? AND role = ? AND status = 'running' ORDER BY id DESC LIMIT 1"
    )
    .get(taskId, attemptNumber, role) as Attempt | undefined;
}

// -- Repos --

export function getRepo(id: number): Repo | undefined {
  return getDb()
    .prepare('SELECT * FROM repos WHERE id = ?')
    .get(id) as Repo | undefined;
}

export function getRepos(): Repo[] {
  return getDb()
    .prepare('SELECT * FROM repos ORDER BY owner, name')
    .all() as Repo[];
}

export function getRepoByOwnerName(owner: string, name: string): Repo | undefined {
  return getDb()
    .prepare('SELECT * FROM repos WHERE owner = ? AND name = ?')
    .get(owner, name) as Repo | undefined;
}

// -- Agent Tools --

export function getAgentTool(id: string): AgentTool | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_tools WHERE id = ?')
    .get(id) as AgentTool | undefined;
}

export function getAgentTools(): AgentTool[] {
  return getDb()
    .prepare('SELECT * FROM agent_tools ORDER BY id')
    .all() as AgentTool[];
}

// -- Providers --

export function getProvider(id: string): Provider | undefined {
  return getDb()
    .prepare('SELECT * FROM providers WHERE id = ?')
    .get(id) as Provider | undefined;
}

export function getProviders(): Provider[] {
  return getDb()
    .prepare('SELECT * FROM providers ORDER BY id')
    .all() as Provider[];
}

export function insertProvider(p: Provider): void {
  getDb()
    .prepare(
      'INSERT INTO providers (id, display_name, concurrency_limit, notes) VALUES (?, ?, ?, ?)'
    )
    .run(p.id, p.display_name, p.concurrency_limit, p.notes ?? null);
}

export function updateProvider(
  id: string,
  updates: Partial<Omit<Provider, 'id'>>
): void {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  getDb()
    .prepare(`UPDATE providers SET ${sets} WHERE id = ?`)
    .run(...values, id);
}

export function deleteProvider(id: string): void {
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
}

export function countToolsUsingProvider(providerId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM agent_tools WHERE provider_id = ?')
    .get(providerId) as { n: number };
  return row.n;
}

// -- Task Events --

export function insertTaskEvent(
  taskId: number,
  eventType: string,
  message: string
): TaskEvent {
  const result = getDb()
    .prepare(
      'INSERT INTO task_events (task_id, event_type, message) VALUES (?, ?, ?)'
    )
    .run(taskId, eventType, message);

  return getDb()
    .prepare('SELECT * FROM task_events WHERE id = ?')
    .get(result.lastInsertRowid) as TaskEvent;
}

export function getTaskEvents(taskId: number): TaskEvent[] {
  return getDb()
    .prepare(
      'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC'
    )
    .all(taskId) as TaskEvent[];
}

// -- Settings --

export function getSetting(key: SettingsKey): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function getSettingInt(key: SettingsKey): number {
  const value = getSetting(key);
  return value ? parseInt(value, 10) : 0;
}

export function updateSetting(key: SettingsKey, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT key, value FROM settings')
    .all() as { key: string; value: string }[];

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
