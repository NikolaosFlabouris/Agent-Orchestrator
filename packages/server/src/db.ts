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

    -- agent_tools is the legacy table replaced by providers + models +
    -- agent_profiles in schema v21. Kept in createTables so the v3/v4/v9
    -- migration ALTERs run cleanly on fresh installs (the migration chain
    -- runs even for first-run); v21 then drops it.
    CREATE TABLE IF NOT EXISTS agent_tools (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      type TEXT NOT NULL,
      command_template TEXT,
      env_vars TEXT NOT NULL DEFAULT '{}',
      config_file_path TEXT,
      config_file_content TEXT,
      timeout_minutes INTEGER NOT NULL DEFAULT 2880,
      provider_id TEXT
    );

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

function runMigrations(db: Database.Database): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const version = row ? parseInt(row.value, 10) : 0;
  _isFirstRun = version === 0;

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
    // Tools with NULL provider_id are not subject to provider-pool gating —
    // only the host resource pool gates them (preserves pre-v4 semantics for
    // existing installs — no tools are auto-assigned; the user opts in by
    // creating providers in the UI).
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
    // Reserved — used by an earlier version of the orchestrator to rewrite
    // legacy `${TASK_PROMPT}` agent_tools.command_template entries to the
    // current `$(cat {{PROMPT_FILE}})` placeholder form. Removed once all
    // active installs were several versions past it; resurrecting an
    // install older than v5 would launch agents with empty prompts and
    // need a manual re-seed of agent_tools. Bumping schema_version keeps
    // the version sequence intact.
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

  if (version < 7) {
    // Drop repos.model and repos.max_turns. These were per-repo overrides of
    // settings.default_model / settings.default_max_turns, but they only ever
    // took effect for SDK tools — CLI tools hardcode model/max-turns inside
    // their command_template. The repo-level layer was a silent footgun on
    // CLI tools (the override appeared to do nothing) and unused enough on
    // SDK tools that the per-task override + global default cover the real
    // workflow. Dropping leaves resolution as: task.model > default_model,
    // and max_turns > default_max_turns (no repo layer).
    const cols = db
      .prepare("PRAGMA table_info(repos)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'model')) {
      db.exec('ALTER TABLE repos DROP COLUMN model');
    }
    if (cols.some((c) => c.name === 'max_turns')) {
      db.exec('ALTER TABLE repos DROP COLUMN max_turns');
    }
    db.prepare("UPDATE settings SET value = '7' WHERE key = 'schema_version'").run();
  }

  if (version < 8) {
    // Drop repos.image_type. The previous orchestrator-agent-{node,python,go}
    // hierarchy is collapsed into a single orchestrator-agent:latest image
    // that ships all three toolchains, so picking a language image per-repo
    // is no longer meaningful. Cache buckets for all three languages are
    // always mounted (see docker.ts); empty buckets cost ~0 bytes.
    const cols = db
      .prepare("PRAGMA table_info(repos)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'image_type')) {
      db.exec('ALTER TABLE repos DROP COLUMN image_type');
    }
    db.prepare("UPDATE settings SET value = '8' WHERE key = 'schema_version'").run();
  }

  if (version < 9) {
    // Drop agent_tools.auth_type and agent_tools.auth_config. The orchestrator
    // now forwards a fixed set of well-known LLM provider keys to every agent
    // container at launch (see credentials.ts). Tools no longer declare their
    // own credentials — the underlying CLI/SDK picks up whichever forwarded
    // key it needs, and unused keys sit harmlessly. This removes a
    // per-tool/per-credential plumbing layer that didn't earn its complexity.
    const cols = db
      .prepare("PRAGMA table_info(agent_tools)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'auth_type')) {
      db.exec('ALTER TABLE agent_tools DROP COLUMN auth_type');
    }
    if (cols.some((c) => c.name === 'auth_config')) {
      db.exec('ALTER TABLE agent_tools DROP COLUMN auth_config');
    }
    db.prepare("UPDATE settings SET value = '9' WHERE key = 'schema_version'").run();
  }

  if (version < 10) {
    // Split agent_tools.env_vars dual-purpose JSON. Until v10, env_vars
    // either held a flat key/value map (forwarded as container env vars) OR
    // a config-shaped object (top-level provider/permission/agent key) that
    // the orchestrator silently rerouted into /repo/opencode.json. This
    // migration adds dedicated config_file_path and config_file_content
    // columns and moves any config-shaped env_vars into them, leaving
    // env_vars as flat-only (key/value overrides for FORWARDED_KEYS plus
    // arbitrary extras). Existing OpenCode-style data lands at
    // path='opencode.json' to preserve runtime behaviour.
    const cols = db
      .prepare("PRAGMA table_info(agent_tools)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'config_file_path')) {
      db.exec('ALTER TABLE agent_tools ADD COLUMN config_file_path TEXT');
    }
    if (!cols.some((c) => c.name === 'config_file_content')) {
      db.exec('ALTER TABLE agent_tools ADD COLUMN config_file_content TEXT');
    }

    const tools = db
      .prepare('SELECT id, env_vars FROM agent_tools')
      .all() as Array<{ id: string; env_vars: string }>;
    const updateStmt = db.prepare(
      'UPDATE agent_tools SET config_file_path = ?, config_file_content = ?, env_vars = ? WHERE id = ?'
    );
    for (const tool of tools) {
      try {
        const parsed = JSON.parse(tool.env_vars || '{}');
        if (
          parsed &&
          typeof parsed === 'object' &&
          ('provider' in parsed ||
            'permission' in parsed ||
            'agent' in parsed)
        ) {
          updateStmt.run(
            'opencode.json',
            JSON.stringify(parsed, null, 2),
            '{}',
            tool.id
          );
        }
      } catch {
        // Invalid JSON in env_vars — leave as-is.
      }
    }

    db.prepare("UPDATE settings SET value = '10' WHERE key = 'schema_version'").run();
  }

  if (version < 11) {
    // Drop poll_interval_seconds and default_max_attempts from settings.
    // Both moved to compile-time constants in constants.ts:
    //  - POLL_INTERVAL_SECONDS: a fallback poller cadence has no real per-
    //    install tuning case (60s is the right tradeoff between recovery
    //    latency and Forgejo API load).
    //  - DEFAULT_MAX_ATTEMPTS: the per-task override (settable at create
    //    time and editable on the Task Detail page) covers the legitimate
    //    customisation case; a global default of 7 is hardcoded.
    db.prepare(
      "DELETE FROM settings WHERE key IN ('poll_interval_seconds', 'default_max_attempts')"
    ).run();
    db.prepare("UPDATE settings SET value = '11' WHERE key = 'schema_version'").run();
  }

  if (version < 12) {
    // Drop workspace_retention_days from settings — moved to the
    // WORKSPACE_RETENTION_DAYS constant. The cleanup pass also dropped its
    // "merged workspaces live forever" carve-out and gained an orphan-
    // detection sweep (workspaces with no task row); both apply uniformly
    // at the constant's retention. No real per-install tuning case for the
    // retention window.
    db.prepare(
      "DELETE FROM settings WHERE key = 'workspace_retention_days'"
    ).run();
    db.prepare("UPDATE settings SET value = '12' WHERE key = 'schema_version'").run();
  }

  if (version < 13) {
    // Drop disk_threshold_bytes from settings. The "disk usage exceeds
    // threshold" alert it drove was at the wrong abstraction layer (fixed
    // bytes against a specific subdir, not actual filesystem free space)
    // and largely redundant with OS-level disk monitoring. The dashboard
    // still shows /workspaces and /caches sizes for at-a-glance visibility;
    // the warning alert and its threshold are gone.
    db.prepare(
      "DELETE FROM settings WHERE key = 'disk_threshold_bytes'"
    ).run();
    db.prepare("UPDATE settings SET value = '13' WHERE key = 'schema_version'").run();
  }

  if (version < 14) {
    // Drop all cost-tracking. The pricing-driven cost calculation was based
    // on `attempts.input_tokens / output_tokens` and the `model_pricing`
    // setting, but the harness layer has always recorded `meta.json.model`
    // (the user's intended alias, e.g. 'sonnet') rather than the actual
    // model id reported by the agent's stream — so the pricing lookup
    // missed every time and `cost_usd` was always 0 on default installs.
    // Rather than fix the bug + maintain a pricing table that needs hand-
    // updating whenever Anthropic publishes new prices, we drop the whole
    // feature: dashboard daily cost, per-attempt cost, the pricing setting
    // itself, and the underlying token columns.
    const cols = db
      .prepare("PRAGMA table_info(attempts)")
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'cost_usd')) {
      db.exec('ALTER TABLE attempts DROP COLUMN cost_usd');
    }
    if (cols.some((c) => c.name === 'input_tokens')) {
      db.exec('ALTER TABLE attempts DROP COLUMN input_tokens');
    }
    if (cols.some((c) => c.name === 'output_tokens')) {
      db.exec('ALTER TABLE attempts DROP COLUMN output_tokens');
    }
    db.prepare("DELETE FROM settings WHERE key = 'model_pricing'").run();
    db.prepare("UPDATE settings SET value = '14' WHERE key = 'schema_version'").run();
  }

  if (version < 15) {
    // Move merge_strategy from a global setting to a per-repo column. Backfill
    // existing repos with the prior global value (or 'squash' if unset). At
    // merge time, the orchestrator queries the repo's Forgejo-side allowed
    // strategies and resolves an effective value (see merge-strategy.ts) —
    // so the per-repo preference is honoured only when the repo allows it.
    const cols = db
      .prepare("PRAGMA table_info(repos)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'merge_strategy')) {
      // DEFAULT 'squash' matches the app-level preference. Existing installs
      // that explicitly set the prior global value get backfilled below —
      // only repos with no inherited preference take the new default.
      db.exec(
        "ALTER TABLE repos ADD COLUMN merge_strategy TEXT NOT NULL DEFAULT 'squash'"
      );
    }
    const globalRow = db
      .prepare("SELECT value FROM settings WHERE key = 'merge_strategy'")
      .get() as { value: string } | undefined;
    if (globalRow && ['squash', 'merge', 'rebase'].includes(globalRow.value)) {
      db.prepare('UPDATE repos SET merge_strategy = ?').run(globalRow.value);
    }
    db.prepare("DELETE FROM settings WHERE key = 'merge_strategy'").run();
    db.prepare("UPDATE settings SET value = '15' WHERE key = 'schema_version'").run();
  }

  if (version < 16) {
    // Drop default_max_turns. CLI tools that want a per-turn cap encode it
    // in their command_template (e.g. claude-code's `--max-turns 100`); the
    // SDK harness no longer reads a turn cap from meta.json. The lifetime
    // safety net is `agent_timeout_minutes` (per-tool override available),
    // which kills the container at the wall-clock deadline regardless of
    // turn count. Removing this collapses one knob with no real per-install
    // tuning case.
    db.prepare("DELETE FROM settings WHERE key = 'default_max_turns'").run();
    db.prepare("UPDATE settings SET value = '16' WHERE key = 'schema_version'").run();
  }

  if (version < 17) {
    // Collapse the timeout-resolution chain. Until v17:
    //   tool.timeout_minutes ?? repo.timeout_minutes ?? settings.agent_timeout_minutes ?? 30
    // From v17: tool.timeout_minutes (NOT NULL).
    //
    // Drop:
    //   - settings.agent_timeout_minutes (global)
    //   - repos.timeout_minutes (per-repo override)
    // Backfill any null tool.timeout_minutes with 2880 (48h, the form
    // pre-fill default), then enforce NOT NULL via a recreate-table dance
    // since SQLite ALTER TABLE can't add NOT NULL to an existing column.
    db.prepare(
      "UPDATE agent_tools SET timeout_minutes = 2880 WHERE timeout_minutes IS NULL"
    ).run();

    // SQLite limitation: can't promote an existing nullable column to NOT
    // NULL. Recreate-table dance: new table with the constraint, copy data,
    // swap. The other columns must match the v16 shape exactly.
    db.exec(`
      CREATE TABLE agent_tools_v17 (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        type TEXT NOT NULL,
        command_template TEXT,
        env_vars TEXT NOT NULL DEFAULT '{}',
        config_file_path TEXT,
        config_file_content TEXT,
        timeout_minutes INTEGER NOT NULL DEFAULT 2880,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL
      );
      INSERT INTO agent_tools_v17
        SELECT id, display_name, type, command_template, env_vars,
               config_file_path, config_file_content,
               timeout_minutes, provider_id
        FROM agent_tools;
      DROP TABLE agent_tools;
      ALTER TABLE agent_tools_v17 RENAME TO agent_tools;
    `);

    // Drop per-repo timeout override.
    const repoCols = db
      .prepare("PRAGMA table_info(repos)")
      .all() as Array<{ name: string }>;
    if (repoCols.some((c) => c.name === 'timeout_minutes')) {
      db.exec('ALTER TABLE repos DROP COLUMN timeout_minutes');
    }

    // Drop global agent_timeout_minutes.
    db.prepare(
      "DELETE FROM settings WHERE key = 'agent_timeout_minutes'"
    ).run();

    db.prepare("UPDATE settings SET value = '17' WHERE key = 'schema_version'").run();
  }

  if (version < 18) {
    // Drop default_container_memory_mb and default_container_cpu_cores from
    // settings. The per-repo override (repos.container_memory_mb /
    // repos.container_cpu_cores) is the load-bearing knob — operators
    // tune resource limits per repo when a heavy workload OOMs, not
    // globally. The defaults move to constants.ts; existing per-repo
    // overrides are unaffected.
    db.prepare(
      "DELETE FROM settings WHERE key IN ('default_container_memory_mb', 'default_container_cpu_cores')"
    ).run();
    db.prepare("UPDATE settings SET value = '18' WHERE key = 'schema_version'").run();
  }

  if (version < 19) {
    // Replace the count-based `max_concurrency` global cap with a
    // resource-pool model: `max_agent_memory_mb` and `max_agent_cpu_cores`.
    // The count-based model was a leaky proxy for host capacity — it
    // assumed every container was DEFAULT_CONTAINER_*-sized, which broke
    // when per-repo overrides changed container size. The resource pool
    // tracks actual MB/cores claimed by active containers and refuses
    // launch if a candidate would exceed either dimension. Per-provider
    // limits (providers.concurrency_limit) remain unchanged — they
    // address upstream LLM-provider constraints, not local hardware.
    //
    // Backfill: if the operator had a non-default `max_concurrency`,
    // multiply by the default container size to derive a sensible
    // starting pool. Otherwise use the seeded defaults (20480 MB / 10).
    const oldRow = db
      .prepare("SELECT value FROM settings WHERE key = 'max_concurrency'")
      .get() as { value: string } | undefined;
    const oldMax = oldRow ? parseInt(oldRow.value, 10) : NaN;
    const memMb = Number.isFinite(oldMax) && oldMax > 0
      ? oldMax * 4096 // DEFAULT_CONTAINER_MEMORY_MB
      : 20480;
    const cpu = Number.isFinite(oldMax) && oldMax > 0
      ? oldMax * 2 // DEFAULT_CONTAINER_CPU_CORES
      : 10;

    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('max_agent_memory_mb', ?)"
    ).run(String(memMb));
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('max_agent_cpu_cores', ?)"
    ).run(String(cpu));
    db.prepare("DELETE FROM settings WHERE key = 'max_concurrency'").run();
    db.prepare("UPDATE settings SET value = '19' WHERE key = 'schema_version'").run();
  }

  if (version < 20) {
    // Replace `repos.pre_agent_script` (free-text shell command) with two
    // structured columns: a JSON array of typed install steps, and an
    // explicit per-repo opt-in for the `script` escape hatch. The free-text
    // form had an open shell-injection surface (interpolated unquoted into
    // execSync / bash) and inherited every FORWARDED_KEY at runtime, so
    // even though the trust model is "operator-only", we tighten it.
    //
    // Backfill: try to recognise the existing string as one of the safe
    // patterns the UI used to validate against (npm ci/install, yarn
    // install, pnpm install, pip install -r). Match → translate to a
    // typed step at root cwd. No match → leave as [] and log a one-time
    // warning so the operator notices and reconfigures via the UI.
    const cols = db
      .prepare('PRAGMA table_info(repos)')
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'install_steps')) {
      db.prepare("UPDATE settings SET value = '20' WHERE key = 'schema_version'").run();
      return;
    }

    db.exec("ALTER TABLE repos ADD COLUMN install_steps TEXT NOT NULL DEFAULT '[]'");
    db.exec('ALTER TABLE repos ADD COLUMN allow_script_steps INTEGER NOT NULL DEFAULT 0');

    if (cols.some((c) => c.name === 'pre_agent_script')) {
      const existing = db
        .prepare(
          "SELECT id, owner, name, pre_agent_script FROM repos WHERE pre_agent_script IS NOT NULL AND pre_agent_script != ''"
        )
        .all() as Array<{
          id: number;
          owner: string;
          name: string;
          pre_agent_script: string;
        }>;
      const update = db.prepare('UPDATE repos SET install_steps = ? WHERE id = ?');
      for (const repo of existing) {
        const step = translatePreAgentScript(repo.pre_agent_script);
        if (step) {
          update.run(JSON.stringify([step]), repo.id);
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `[migration v20] repo ${repo.owner}/${repo.name} (id=${repo.id}) had a non-standard pre_agent_script (${JSON.stringify(repo.pre_agent_script)}); install_steps left empty. Reconfigure under Settings → Repositories.`
          );
        }
      }
      db.exec('ALTER TABLE repos DROP COLUMN pre_agent_script');
    }

    db.prepare("UPDATE settings SET value = '20' WHERE key = 'schema_version'").run();
  }

  if (version < 21) {
    // Replace the monolithic `agent_tools` row with a three-layer
    // composition: providers (concrete connection identity), models
    // (provider-scoped model_ids), and agent_profiles (the operator-
    // composed pairing). Hard cut — no data preservation.
    //
    // Wrapped in a transaction so a process crash mid-migration leaves
    // schema_version=20 and the next boot retries cleanly. Without this,
    // a partial v21 (e.g. wiped providers but no bootstrap seed) could
    // leave the install unbootable.
    //
    // Operations:
    //   1. Fail in-flight tasks (no clean re-resolution path post-cut).
    //   2. Drop legacy `agent_tools`.
    //   3. Wipe legacy `providers` rows (we re-seed under the new schema).
    //   4. Extend `providers` with: kind, base_url, auth_token,
    //      api_key_env_var.
    //   5. Create `models` and `agent_profiles` (createTables also runs at
    //      boot, so for fresh installs these already exist via IF NOT
    //      EXISTS — the CREATE here is for upgrade-in-place).
    //   6. Repos: drop `agent_tool`, add `agent_profile_id`.
    //   7. Tasks: drop `agent_tool` and `model`, add `agent_profile_id`.
    //   8. Attempts: rename `model` → `model_id`, add `harness_id`.
    //   9. Drop `default_model` setting; (re-)seed bootstrap provider +
    //      model + profile + `default_agent_profile_id` setting.
    //
    // Each step is PRAGMA-guarded so the migration is idempotent: on a
    // fresh install where createTables already produced the new shape,
    // every step finds a no-op condition.
    const runV21 = db.transaction(() => {
      // 1. Fail in-flight tasks. Statuses considered active for this
      //    purpose: queued (waiting), preparing, in-progress, in-review,
      //    changes-needed. Terminal statuses (merged, failed, cancelled,
      //    awaiting-human-*, needs-human-review, reset) are left alone.
      db.prepare(
        `UPDATE tasks
         SET status = 'failed', completed_at = COALESCE(completed_at, datetime('now'))
         WHERE status IN ('queued','preparing','in-progress','in-review','changes-needed')`
      ).run();

      // 2. Drop legacy agent_tools.
      db.exec('DROP TABLE IF EXISTS agent_tools');

      // 3. Wipe legacy providers (we re-seed under the new schema below).
      db.exec('DELETE FROM providers');

      // 4. Extend providers.
      const providerCols = db
        .prepare('PRAGMA table_info(providers)')
        .all() as Array<{ name: string }>;
      if (!providerCols.some((c) => c.name === 'kind')) {
        // Rows were just wiped, so NOT NULL DEFAULT is safe in one shot.
        db.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'anthropic'");
      }
      if (!providerCols.some((c) => c.name === 'base_url')) {
        db.exec('ALTER TABLE providers ADD COLUMN base_url TEXT');
      }
      if (!providerCols.some((c) => c.name === 'auth_token')) {
        db.exec('ALTER TABLE providers ADD COLUMN auth_token TEXT');
      }
      if (!providerCols.some((c) => c.name === 'api_key_env_var')) {
        db.exec('ALTER TABLE providers ADD COLUMN api_key_env_var TEXT');
      }

      // 5. Ensure models + agent_profiles exist (createTables handles fresh
      //    installs but be defensive for upgrade-in-place).
      db.exec(`
        CREATE TABLE IF NOT EXISTS models (
          id INTEGER PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
          model_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          UNIQUE(provider_id, model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);

        CREATE TABLE IF NOT EXISTS agent_profiles (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          harness_id TEXT NOT NULL,
          model_pk INTEGER NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
          config_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config_json)),
          timeout_minutes INTEGER NOT NULL DEFAULT 2880
        );
        CREATE INDEX IF NOT EXISTS idx_agent_profiles_model_pk ON agent_profiles(model_pk);
      `);

      // 6. Repos: agent_tool → agent_profile_id.
      const repoCols = db
        .prepare('PRAGMA table_info(repos)')
        .all() as Array<{ name: string }>;
      if (!repoCols.some((c) => c.name === 'agent_profile_id')) {
        db.exec(
          'ALTER TABLE repos ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT'
        );
      }
      if (repoCols.some((c) => c.name === 'agent_tool')) {
        db.exec('ALTER TABLE repos DROP COLUMN agent_tool');
      }

      // 7. Tasks: drop agent_tool + model, add agent_profile_id.
      const taskCols = db
        .prepare('PRAGMA table_info(tasks)')
        .all() as Array<{ name: string }>;
      if (!taskCols.some((c) => c.name === 'agent_profile_id')) {
        db.exec(
          'ALTER TABLE tasks ADD COLUMN agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT'
        );
      }
      if (taskCols.some((c) => c.name === 'agent_tool')) {
        db.exec('ALTER TABLE tasks DROP COLUMN agent_tool');
      }
      if (taskCols.some((c) => c.name === 'model')) {
        db.exec('ALTER TABLE tasks DROP COLUMN model');
      }

      // 8. Attempts: rename model → model_id, add harness_id.
      const attemptCols = db
        .prepare('PRAGMA table_info(attempts)')
        .all() as Array<{ name: string }>;
      if (
        attemptCols.some((c) => c.name === 'model') &&
        !attemptCols.some((c) => c.name === 'model_id')
      ) {
        db.exec('ALTER TABLE attempts RENAME COLUMN model TO model_id');
      }
      if (!attemptCols.some((c) => c.name === 'harness_id')) {
        db.exec('ALTER TABLE attempts ADD COLUMN harness_id TEXT');
      }

      // 9. Drop default_model + bootstrap seed.
      db.prepare("DELETE FROM settings WHERE key = 'default_model'").run();
      seedBootstrapProfile(db);

      db.prepare("UPDATE settings SET value = '21' WHERE key = 'schema_version'").run();
    });
    runV21();
  }
}

/** v21 bootstrap: seed the standard cloud providers + a starter model on
 *  Anthropic + a default Claude SDK profile, then point
 *  `settings.default_agent_profile_id` at it.
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
      'v21 bootstrap: failed to find seeded Anthropic sonnet model. ' +
      'This indicates a partial migration state — the providers/models seed ' +
      'did not complete. Inspect the orchestrator DB and either restore ' +
      'from backup or manually seed an Anthropic provider + sonnet model + ' +
      'default agent profile, then bump schema_version to 21.'
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

/** v20 backfill helper: map a legacy `pre_agent_script` string to a typed
 *  install step where the command is one of the patterns the UI used to mark
 *  as safe. Returns null for anything else. Kept narrow on purpose — better
 *  to leave install_steps empty and let the operator see the warning than to
 *  guess at exotic commands and run something unexpected. */
function translatePreAgentScript(
  script: string
): { kind: string; cwd?: string } | null {
  const s = script.trim();
  if (/^npm\s+ci$/.test(s)) return { kind: 'npm-ci' };
  if (/^npm\s+install$/.test(s)) return { kind: 'npm-install' };
  if (/^yarn\s+install$/.test(s)) return { kind: 'yarn-install' };
  if (/^pnpm\s+install$/.test(s)) return { kind: 'pnpm-install' };
  if (/^pip\s+install\s+-r\s+\S+$/.test(s)) return { kind: 'pip-requirements' };
  return null;
}

function seedDefaultSettings(db: Database.Database): void {
  const defaults: Record<string, string> = {
    schema_version: '1',
    // Default resource pool: sized for a typical 24+ GB / 8+ core dev host.
    // Operators tune via Settings → Global Settings.
    max_agent_memory_mb: '20480',
    max_agent_cpu_cores: '10',
    // `default_agent_profile_id` is set by the v21 migration after the
    // bootstrap profile is created (it can't be seeded here because the
    // profile row doesn't exist yet at v1).
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
