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
import { DEFAULT_MAX_ATTEMPTS } from './constants.js';

const CURRENT_SCHEMA_VERSION = 20;

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
      agent_tool TEXT NOT NULL,
      -- Ordered JSON array of typed install steps the harness runs before
      -- the agent starts. Each entry is { kind, cwd? } for package-manager
      -- steps or { kind: 'script', path, cwd? } for the script escape hatch.
      -- See @orchestrator/shared InstallStep. Default '[]' = no install.
      install_steps TEXT NOT NULL DEFAULT '[]',
      -- Per-repo opt-in for the script-kind install step. 0 = forbidden,
      -- 1 = allowed. Default 0; operator must consciously enable since
      -- script steps inherit the agent container env (FORWARDED_KEYS).
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
      model TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_task_id ON attempts(task_id);

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      -- Per-provider concurrency cap (an upstream LLM constraint, e.g. an
      -- API rate-limit bucket or a single Ollama server). 0 means "paused"
      -- (no task assigned to this provider launches). NULL is not allowed.
      -- Independent from the host resource pool (settings.max_agent_memory_mb /
      -- max_agent_cpu_cores), which gates hardware capacity for every task.
      concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_tools (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      type TEXT NOT NULL,
      command_template TEXT,
      -- Flat key/value JSON. Forwarded as container env vars at launch.
      -- Overrides FORWARDED_KEYS values when keys collide; arbitrary other
      -- keys are added to the container env.
      env_vars TEXT NOT NULL DEFAULT '{}',
      -- Optional config file dropped into the workspace before the agent
      -- runs. Path is relative to /repo (the workspace root inside the
      -- container). Used by tools like OpenCode that take config from a
      -- file rather than env vars or CLI flags. Both columns must be set,
      -- or both must be NULL.
      config_file_path TEXT,
      config_file_content TEXT,
      -- Per-tool wall-clock timeout (minutes). Schema v17 made this NOT NULL
      -- and removed the global / per-repo override layers — every tool
      -- carries its own value. Default 2880 (48 h) is the form pre-fill for
      -- new tools; operators are expected to type their actual budget over
      -- it (typically 120 min for paid APIs, 2880 min for free local
      -- servers). The seed values match: 120 paid, 2880 local.
      timeout_minutes INTEGER NOT NULL DEFAULT 2880,
      -- Optional provider this tool belongs to, for upstream concurrency
      -- pooling. Null = tool has no provider; the host resource pool still
      -- gates its launch.
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
    // Default resource pool: roughly the old (max_concurrency=5 ×
    // 4096 MB / 2 cores) effective ceiling — sized for a typical 24+ GB
    // / 8+ core dev host. Operators tune via Settings → Global Settings.
    max_agent_memory_mb: '20480',
    max_agent_cpu_cores: '10',
    default_model: 'sonnet',
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
      task.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
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
      | 'model'
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
