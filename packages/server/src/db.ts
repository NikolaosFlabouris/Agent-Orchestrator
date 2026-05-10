import Database from 'better-sqlite3';
import type {
  Task,
  TaskStatus,
  Attempt,
  AttemptRole,
  AttemptStatus,
  Repo,
  Provider,
  Model,
  AgentProfile,
  HarnessId,
  TaskEvent,
  SettingsKey,
} from '@orchestrator/shared';
import { DEFAULT_MAX_ATTEMPTS } from './constants.js';

const CURRENT_SCHEMA_VERSION = 21;

let _db: Database.Database;

/** True when initDatabase() created the schema from scratch (the install
 *  had no schema_version row at boot). The server uses this to seed the
 *  resource pool from `docker info` on first run rather than the static
 *  fallback. Resets on each initDatabase() call so the test suite, which
 *  re-inits per case, sees the fresh-install signal each time. */
let _isFirstRun = false;
export function wasFirstRun(): boolean {
  return _isFirstRun;
}

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
      -- Per-repo default agent profile. NULL falls back to
      -- settings.default_agent_profile_id at task-launch time. RESTRICT on
      -- delete: operator must reassign or unset before deleting the profile.
      agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      -- Ordered JSON array of typed install steps the harness runs before
      -- the agent starts. Each entry is { kind, cwd? } for package-manager
      -- steps or { kind: 'script', path, cwd? } for the script escape hatch.
      -- See @orchestrator/shared InstallStep. Default '[]' = no install.
      install_steps TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(install_steps)),
      -- Per-repo opt-in for the script-kind install step. 0 = forbidden,
      -- 1 = allowed. Default 0; operator must consciously enable since
      -- script steps inherit the agent container env.
      allow_script_steps INTEGER NOT NULL DEFAULT 0,
      container_memory_mb INTEGER,
      container_cpu_cores INTEGER,
      -- Operator's preferred PR merge strategy (squash | merge | rebase).
      -- Default 'squash' matches the orchestrator's app-level preference.
      -- The runtime resolution honours the repo's Forgejo-side allowed
      -- styles: if multiple are allowed and this preference is in the set,
      -- it wins; otherwise the orchestrator falls back to the first
      -- allowed style in PRIORITY_ORDER (see merge-strategy.ts).
      merge_strategy TEXT NOT NULL DEFAULT 'squash',
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
      max_attempts INTEGER DEFAULT 7,
      prep_failure_count INTEGER DEFAULT 0,
      -- Per-task profile override. NULL inherits from
      -- repos.agent_profile_id, which inherits from settings.default_*.
      agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
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
      -- Snapshot of the model_id resolved at attempt-launch time. Stored
      -- on the attempt so audit/usage records survive subsequent edits to
      -- the agent profile or model row.
      model_id TEXT,
      -- Snapshot of the harness id resolved at attempt-launch time.
      harness_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_task_id ON attempts(task_id);

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      -- Provider kind (anthropic, openai, ollama, etc.). Determines
      -- credential shape, env-var name, default base_url, and which
      -- harnesses can target this provider. See PROVIDER_KINDS.
      kind TEXT NOT NULL,
      -- Per-provider concurrency cap (an upstream LLM constraint, e.g. an
      -- API rate-limit bucket or a single Ollama server). 0 means "paused"
      -- (no task assigned to this provider launches). NULL is not allowed.
      -- Independent from the host resource pool (settings.max_agent_memory_mb /
      -- max_agent_cpu_cores), which gates hardware capacity for every task.
      concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
      -- Connection URL. NULL for cloud kinds (uses kind's default). REQUIRED
      -- for self-hosted kinds (ollama).
      base_url TEXT,
      -- Inline secret (Ollama bearer/basic auth token, or a cloud API key
      -- when the operator is multi-instancing a kind without env-var
      -- indirection). NULL when api_key_env_var is used or no auth needed.
      auth_token TEXT,
      -- Name of the orchestrator-side env var holding this provider's API
      -- key. The orchestrator reads from its own env at launch and exports
      -- the value into the agent container under the kind's standard name.
      api_key_env_var TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
      -- Bare model identifier as the inference endpoint expects, without
      -- any provider prefix (e.g. 'claude-sonnet-4-6', 'qwen2.5-coder:14b').
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      UNIQUE(provider_id, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);

    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      -- Code-defined harness this profile uses. See HARNESS_IDS.
      harness_id TEXT NOT NULL,
      -- FK to the model surrogate PK. The provider is reachable via the
      -- model row.
      model_pk INTEGER NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
      -- Harness-specific config (typed knobs the harness understands).
      -- Stored as JSON; the harness module owns its schema.
      config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)),
      -- Wall-clock timeout (minutes) for an agent run using this profile.
      timeout_minutes INTEGER NOT NULL DEFAULT 2880
    );

    CREATE INDEX IF NOT EXISTS idx_agent_profiles_model_pk ON agent_profiles(model_pk);

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
//
// The schema is the cumulative result of an earlier 21-step migration chain
// that the orchestrator no longer carries. createTables produces the final
// shape directly; first-run seeding (settings + bootstrap providers/models/
// profile) runs once when the schema_version row is missing.
//
// If/when a future schema change is needed, add a `version < N` block here
// and bump CURRENT_SCHEMA_VERSION. The orchestrator refuses to boot against
// a DB whose schema_version is newer than CURRENT_SCHEMA_VERSION (caller
// downgraded) or older than the lowest supported version (no migration
// path).

function runMigrations(db: Database.Database): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const version = row ? parseInt(row.value, 10) : 0;
  _isFirstRun = version === 0;

  if (_isFirstRun) {
    // Fresh install: createTables already produced the v21 shape. Seed
    // settings + bootstrap providers/models/profile. seedBootstrapProfile
    // throws if its own invariants don't hold, which leaves the DB in a
    // half-initialised state — the next boot retries cleanly because
    // schema_version still hasn't been recorded.
    seedDefaultSettings(db);
    seedBootstrapProfile(db);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)"
    ).run(String(CURRENT_SCHEMA_VERSION));
    return;
  }

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema_version ${version} is newer than this orchestrator ` +
      `supports (max ${CURRENT_SCHEMA_VERSION}). The orchestrator was downgraded? ` +
      `Restore from a backup taken with the matching binary.`
    );
  }

  if (version < CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema_version ${version} predates this orchestrator's baseline ` +
      `(${CURRENT_SCHEMA_VERSION}). Migration code for older versions has been ` +
      `removed; reset the database (delete /data/orchestrator.db) and let the ` +
      `next boot recreate the schema, or restore from a more recent backup.`
    );
  }
}


/** First-run bootstrap: seed the standard cloud providers, representative
 *  models per provider, and a default Claude SDK profile, then point
 *  `settings.default_agent_profile_id` at it. Called once from
 *  `runMigrations` when no `schema_version` row exists.
 *
 *  - Providers other than Anthropic are seeded as rows with no credentials
 *    so the operator can see them in the UI and fill in the connection
 *    detail when ready. Their concurrency_limit is set to a reasonable
 *    paid-API default (5).
 *  - Anthropic provider points at `ANTHROPIC_API_KEY`. If the env var is
 *    set, the bootstrap profile launches successfully out of the box; if
 *    not, the profile is visible but flagged "missing credential" by the
 *    Settings UI.
 *  - Local Ollama is NOT seeded — operators add their own with the URL of
 *    their server. */
function seedBootstrapProfile(db: Database.Database): void {
  const insertProvider = db.prepare(
    `INSERT OR IGNORE INTO providers
       (id, display_name, kind, concurrency_limit, base_url, auth_token, api_key_env_var, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const cloudSeeds: Array<{
    id: string;
    display_name: string;
    kind: string;
    api_key_env_var: string;
  }> = [
    { id: 'anthropic',  display_name: 'Anthropic',           kind: 'anthropic',  api_key_env_var: 'ANTHROPIC_API_KEY' },
    { id: 'openai',     display_name: 'OpenAI',              kind: 'openai',     api_key_env_var: 'OPENAI_API_KEY' },
    { id: 'gemini',     display_name: 'Google Gemini',       kind: 'gemini',     api_key_env_var: 'GEMINI_API_KEY' },
    { id: 'mistral',    display_name: 'Mistral',             kind: 'mistral',    api_key_env_var: 'MISTRAL_API_KEY' },
    { id: 'deepseek',   display_name: 'DeepSeek',            kind: 'deepseek',   api_key_env_var: 'DEEPSEEK_API_KEY' },
    { id: 'openrouter', display_name: 'OpenRouter',          kind: 'openrouter', api_key_env_var: 'OPENROUTER_API_KEY' },
  ];
  for (const s of cloudSeeds) {
    insertProvider.run(s.id, s.display_name, s.kind, 5, null, null, s.api_key_env_var, null);
  }

  // Seed a representative model per cloud provider so operators see a
  // populated dropdown immediately. Operators can add/remove via UI.
  const insertModel = db.prepare(
    `INSERT OR IGNORE INTO models (provider_id, model_id, display_name) VALUES (?, ?, ?)`
  );
  const modelSeeds: Array<{ provider_id: string; model_id: string; display_name: string }> = [
    { provider_id: 'anthropic', model_id: 'claude-opus-4-7',     display_name: 'Claude Opus 4.7' },
    { provider_id: 'anthropic', model_id: 'claude-sonnet-4-6',   display_name: 'Claude Sonnet 4.6' },
    { provider_id: 'anthropic', model_id: 'claude-haiku-4-5',    display_name: 'Claude Haiku 4.5' },
    { provider_id: 'openai',    model_id: 'gpt-4o',              display_name: 'GPT-4o' },
    { provider_id: 'openai',    model_id: 'gpt-4o-mini',         display_name: 'GPT-4o mini' },
    { provider_id: 'openai',    model_id: 'o1',                  display_name: 'o1' },
    { provider_id: 'gemini',    model_id: 'gemini-2.5-pro',      display_name: 'Gemini 2.5 Pro' },
    { provider_id: 'gemini',    model_id: 'gemini-2.5-flash',    display_name: 'Gemini 2.5 Flash' },
    { provider_id: 'gemini',    model_id: 'gemma-3-27b',         display_name: 'Gemma 3 27B' },
    { provider_id: 'mistral',   model_id: 'mistral-large-latest',display_name: 'Mistral Large' },
    { provider_id: 'mistral',   model_id: 'codestral-latest',    display_name: 'Codestral' },
    { provider_id: 'deepseek',  model_id: 'deepseek-chat',       display_name: 'DeepSeek Chat' },
    { provider_id: 'deepseek',  model_id: 'deepseek-reasoner',   display_name: 'DeepSeek Reasoner' },
  ];
  for (const m of modelSeeds) {
    insertModel.run(m.provider_id, m.model_id, m.display_name);
  }

  // Bootstrap profile: Claude SDK + Sonnet. Claude SDK is the simplest
  // harness and Anthropic is the most-tested provider, so this is the
  // safest "works out of the box" combination if ANTHROPIC_API_KEY is set.
  // Throw if the seeded sonnet row can't be found — without it, no
  // default profile exists and the orchestrator would have no fallback
  // when a task and its repo both lack an agent_profile_id. Better to
  // fail boot loudly than silently produce an unusable system.
  const sonnetRow = db
    .prepare("SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'")
    .get() as { id: number } | undefined;
  if (!sonnetRow) {
    throw new Error(
      'First-run bootstrap: failed to find the seeded Anthropic sonnet model. ' +
      'This indicates a partial seed — providers + models did not all insert. ' +
      'Reset the database (delete /data/orchestrator.db) and let the next boot ' +
      'recreate the schema and re-seed.'
    );
  }

  db.prepare(
    `INSERT OR IGNORE INTO agent_profiles
       (id, display_name, harness_id, model_pk, config_json, timeout_minutes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('default-claude-sdk', 'Claude SDK + Sonnet', 'claude-sdk', sonnetRow.id, '{}', 120);

  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value)
     VALUES ('default_agent_profile_id', 'default-claude-sdk')`
  ).run();
}

function seedDefaultSettings(db: Database.Database): void {
  const defaults: Record<string, string> = {
    // Default resource pool: sized for a typical 24+ GB / 8+ core dev host.
    // Operators tune via Settings → Global Settings.
    max_agent_memory_mb: '20480',
    max_agent_cpu_cores: '10',
    // `default_agent_profile_id` is set by seedBootstrapProfile after the
    // profile row exists. `schema_version` is set by runMigrations after
    // both seeders complete.
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

export function insertTask(task: {
  issue_id: number;
  issue_title?: string | null;
  repo_id: number;
  status: TaskStatus;
  queue_position?: number;
  max_attempts?: number;
  agent_profile_id?: string | null;
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
      `INSERT INTO tasks (issue_id, issue_title, repo_id, status, queue_position, max_attempts, agent_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.issue_id,
      task.issue_title ?? null,
      task.repo_id,
      task.status,
      queuePos,
      task.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      task.agent_profile_id ?? null
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
      | 'agent_profile_id'
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
  model_id?: string | null;
  harness_id?: string | null;
}): Attempt {
  const result = getDb()
    .prepare(
      `INSERT INTO attempts (task_id, attempt_number, role, status, started_at, model_id, harness_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      attempt.task_id,
      attempt.attempt_number,
      attempt.role,
      attempt.status,
      attempt.started_at ?? new Date().toISOString(),
      attempt.model_id ?? null,
      attempt.harness_id ?? null
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
      | 'model_id'
      | 'harness_id'
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

/** SQLite stores `install_steps` as a JSON string and `allow_script_steps`
 *  as an integer 0/1. Hydrate into the typed Repo shape consumers expect.
 *  Malformed JSON is treated as `[]` — operator can re-save via the UI. */
function hydrateRepo(row: Record<string, unknown> | undefined): Repo | undefined {
  if (!row) return undefined;
  let steps: unknown = [];
  try {
    steps = JSON.parse((row.install_steps as string) ?? '[]');
  } catch {
    steps = [];
  }
  return {
    ...(row as unknown as Repo),
    install_steps: Array.isArray(steps) ? (steps as Repo['install_steps']) : [],
    allow_script_steps: Boolean(row.allow_script_steps),
  };
}

export function getRepo(id: number): Repo | undefined {
  const row = getDb()
    .prepare('SELECT * FROM repos WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return hydrateRepo(row);
}

export function getRepos(): Repo[] {
  const rows = getDb()
    .prepare('SELECT * FROM repos ORDER BY owner, name')
    .all() as Record<string, unknown>[];
  return rows.map((r) => hydrateRepo(r)!);
}

export function getRepoByOwnerName(owner: string, name: string): Repo | undefined {
  const row = getDb()
    .prepare('SELECT * FROM repos WHERE owner = ? AND name = ?')
    .get(owner, name) as Record<string, unknown> | undefined;
  return hydrateRepo(row);
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
      `INSERT INTO providers
         (id, display_name, kind, concurrency_limit, base_url, auth_token, api_key_env_var, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.id,
      p.display_name,
      p.kind,
      p.concurrency_limit,
      p.base_url ?? null,
      p.auth_token ?? null,
      p.api_key_env_var ?? null,
      p.notes ?? null
    );
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

/** Number of models pointing at this provider. Used to gate provider
 *  deletion: RESTRICT semantics in the FK plus the UI shows the count so
 *  operators know what to reassign. */
export function countModelsUsingProvider(providerId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM models WHERE provider_id = ?')
    .get(providerId) as { n: number };
  return row.n;
}

// -- Models --

export function getModel(id: number): Model | undefined {
  return getDb()
    .prepare('SELECT * FROM models WHERE id = ?')
    .get(id) as Model | undefined;
}

export function getModelByProviderAndId(
  providerId: string,
  modelId: string
): Model | undefined {
  return getDb()
    .prepare('SELECT * FROM models WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) as Model | undefined;
}

export function getModelsByProvider(providerId: string): Model[] {
  return getDb()
    .prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY model_id')
    .all(providerId) as Model[];
}

export function getAllModels(): Model[] {
  return getDb()
    .prepare('SELECT * FROM models ORDER BY provider_id, model_id')
    .all() as Model[];
}

export function insertModel(m: {
  provider_id: string;
  model_id: string;
  display_name: string;
}): Model {
  const result = getDb()
    .prepare(
      'INSERT INTO models (provider_id, model_id, display_name) VALUES (?, ?, ?)'
    )
    .run(m.provider_id, m.model_id, m.display_name);
  return getModel(result.lastInsertRowid as number)!;
}

export function updateModel(
  id: number,
  updates: Partial<Pick<Model, 'display_name'>>
): void {
  if (updates.display_name === undefined) return;
  getDb()
    .prepare('UPDATE models SET display_name = ? WHERE id = ?')
    .run(updates.display_name, id);
}

export function deleteModel(id: number): void {
  getDb().prepare('DELETE FROM models WHERE id = ?').run(id);
}

export function countProfilesUsingModel(modelPk: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM agent_profiles WHERE model_pk = ?')
    .get(modelPk) as { n: number };
  return row.n;
}

// -- Agent profiles --

/** SQLite stores `config_json` as a JSON string. Hydrate to the typed
 *  AgentProfile shape consumers expect. Malformed JSON → `{}`. */
function hydrateAgentProfile(
  row: Record<string, unknown> | undefined
): AgentProfile | undefined {
  if (!row) return undefined;
  let cfg: unknown = {};
  try {
    cfg = JSON.parse((row.config_json as string) ?? '{}');
  } catch {
    cfg = {};
  }
  return {
    id: row.id as string,
    display_name: row.display_name as string,
    harness_id: row.harness_id as HarnessId,
    model_pk: row.model_pk as number,
    config_json: (cfg && typeof cfg === 'object' ? cfg : {}) as Record<
      string,
      unknown
    >,
    timeout_minutes: row.timeout_minutes as number,
  };
}

export function getAgentProfile(id: string): AgentProfile | undefined {
  const row = getDb()
    .prepare('SELECT * FROM agent_profiles WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return hydrateAgentProfile(row);
}

export function getAgentProfiles(): AgentProfile[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_profiles ORDER BY id')
    .all() as Record<string, unknown>[];
  return rows.map((r) => hydrateAgentProfile(r)!);
}

export function insertAgentProfile(p: AgentProfile): void {
  getDb()
    .prepare(
      `INSERT INTO agent_profiles
         (id, display_name, harness_id, model_pk, config_json, timeout_minutes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.id,
      p.display_name,
      p.harness_id,
      p.model_pk,
      JSON.stringify(p.config_json ?? {}),
      p.timeout_minutes
    );
}

export function updateAgentProfile(
  id: string,
  updates: Partial<Omit<AgentProfile, 'id'>>
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.display_name !== undefined) {
    sets.push('display_name = ?');
    params.push(updates.display_name);
  }
  if (updates.harness_id !== undefined) {
    sets.push('harness_id = ?');
    params.push(updates.harness_id);
  }
  if (updates.model_pk !== undefined) {
    sets.push('model_pk = ?');
    params.push(updates.model_pk);
  }
  if (updates.config_json !== undefined) {
    sets.push('config_json = ?');
    params.push(JSON.stringify(updates.config_json ?? {}));
  }
  if (updates.timeout_minutes !== undefined) {
    sets.push('timeout_minutes = ?');
    params.push(updates.timeout_minutes);
  }
  if (sets.length === 0) return;
  params.push(id);
  getDb()
    .prepare(`UPDATE agent_profiles SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

export function deleteAgentProfile(id: string): void {
  getDb().prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
}

export function countReposUsingProfile(profileId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM repos WHERE agent_profile_id = ?')
    .get(profileId) as { n: number };
  return row.n;
}

export function countTasksUsingProfile(profileId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM tasks WHERE agent_profile_id = ?')
    .get(profileId) as { n: number };
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
