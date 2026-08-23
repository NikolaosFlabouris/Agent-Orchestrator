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
  TaskDependency,
  DependencyState,
  SettingsKey,
  ReportFilter,
  DurationStats,
  ReportsOverview,
  ReportsTimeseries,
  ReportsTimeseriesBucket,
  ReportsLeaderboard,
  LeaderboardGroupBy,
  LeaderboardRow,
  ProfileGauge,
  DurationGroupBy,
  DurationMetric,
  DurationDistribution,
  ReportsDurations,
  ReportsFunnel,
  FunnelStage,
  ReliabilityCounts,
  ReliabilityRepoRow,
  ReliabilityTimeseriesBucket,
  ReportsReliability,
  HeatmapMetric,
  HeatmapCell,
  ReportsHeatmap,
  ReportTasksSort,
  ExportAttemptsFilter,
  ExportAttemptRow,
} from '@orchestrator/shared';
import { TASK_STATUSES } from '@orchestrator/shared';
import { DEFAULT_MAX_ATTEMPTS, GAUGE_MIN_SAMPLE } from './constants.js';

const CURRENT_SCHEMA_VERSION = 34;
/** Oldest schema_version this binary can forward-migrate from. Anything
 *  older predates the migration code that's still in the tree; the
 *  operator must reset the DB. v21 was the post-collapse baseline (see
 *  commit 7e5fe33); migrations from there forward are kept inline as
 *  `version < N` blocks in runMigrations. */
const MIN_MIGRATABLE_VERSION = 21;

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
      -- Per-repo default agent profile for the implementation (develop)
      -- stage. NULL falls back to settings.default_agent_profile_id at
      -- task-launch time. RESTRICT on delete: operator must reassign or
      -- unset before deleting the profile.
      agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      -- Per-repo default agent profile for the review stage. NULL falls
      -- back to settings.default_review_agent_profile_id, then to the
      -- task's effective implementation profile.
      review_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
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
      -- Count of prep failures charged against this task's permanent-failure
      -- budget. Structural failures (bad branch, missing image, broken
      -- profile chain) increment it on every occurrence; an outage-shaped
      -- git failure increments it ONCE PER OUTAGE WINDOW (see the v31
      -- columns below), so a multi-day git-host outage costs a task one
      -- unit of budget instead of exhausting it in 300 ms. One shared budget
      -- of distinct prep INCIDENTS: the cap is enforced for both kinds, but
      -- only when a window opens, so a task backing off inside an ongoing
      -- outage keeps waiting however long the host stays down.
      prep_failure_count INTEGER DEFAULT 0,
      -- v31 (git-outage resilience). Consecutive outage-shaped prep
      -- failures for this task. Drives the exponential backoff delay and
      -- doubles as the outage-window marker: 0 means "no outage in
      -- progress", so the next infra failure opens a new window and charges
      -- prep_failure_count. Reset to 0 by a successful prepare and by every
      -- requeue/reset path.
      prep_backoff_level INTEGER NOT NULL DEFAULT 0,
      -- v31. ISO timestamp before which the scheduler must not attempt
      -- workspace prep for this task again. NULL = runnable now. A task
      -- waiting here stays queued externally and never blocks other
      -- runnable candidates.
      prep_next_attempt_at TEXT,
      -- v31. Same pair for deferred salvage pushes (preserving finished
      -- agent work when the git host is down at push time). The workspace
      -- is kept on disk, so the push is simply re-attempted later instead
      -- of emitting a terminal salvage_failed.
      salvage_backoff_level INTEGER NOT NULL DEFAULT 0,
      salvage_next_attempt_at TEXT,
      -- Per-task implementation-stage profile override. NULL inherits from
      -- repos.agent_profile_id, which inherits from settings.default_*.
      agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      -- Per-task review-stage profile override. NULL inherits from
      -- repos.review_agent_profile_id → settings.default_review_agent_
      -- profile_id → the task's effective implementation profile.
      review_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      container_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      -- Forgejo numbers issues per-repo (each repo starts at #1), so the
      -- same issue_id recurs across repos. Uniqueness is therefore scoped
      -- to (repo_id, issue_id), not issue_id alone — see the v27 migration.
      UNIQUE(repo_id, issue_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_repo_id ON tasks(repo_id);
    -- Reports aggregation (v28): throughput/lead-time roll-ups filter and
    -- bucket on completed_at.
    CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at);

    -- ON DELETE CASCADE: when a task is deleted, its attempts/events/
    -- steps go with it. Orphaned audit rows for a non-existent task
    -- aren't useful. The orchestrator has no deleteTask path today,
    -- but operators sometimes hand-delete bad rows; this guards that
    -- case from SQL errors. Existing pre-collapse installs may have
    -- NO ACTION here — that's accepted drift since deleteTask doesn't
    -- exist as a feature.
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_number INTEGER,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT,
      started_at TEXT,
      completed_at TEXT,
      log_path TEXT,
      feedback TEXT,
      -- Snapshot of the model_id resolved at attempt-launch time. Stored
      -- on the attempt so audit records survive subsequent edits to the
      -- agent profile or model row.
      model_id TEXT,
      -- Snapshot of the harness id resolved at attempt-launch time.
      harness_id TEXT,
      -- Snapshot of profile.timeout_minutes captured at attempt-launch
      -- time. Read by alerts.checkAlerts when computing the stuck-task
      -- threshold so a profile edit mid-flight doesn't retroactively
      -- shorten the threshold for already-running attempts (H5a). NULL
      -- on pre-v22 rows; consumers fall back to a live profile read
      -- when the snapshot is absent.
      timeout_minutes_snapshot INTEGER,
      -- Per-run effort metrics (v29), read from the harness's result.json
      -- usage block at completion. Immutable per-run facts (the run
      -- already happened — no snapshot-vs-live concern). All nullable:
      -- NULL means "unknown" (a harness that emits no usage, or a pre-v29
      -- row), and must never be conflated with a real 0. Raw token counts
      -- only — the orchestrator never derives a dollar cost.
      num_turns INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      tool_calls INTEGER,
      -- PR code-churn stats (v30), captured at review/merge time from the
      -- Forgejo PR object and persisted onto the review attempt (the run
      -- already happened — immutable per-run facts, no snapshot concern).
      -- All nullable: NULL means "unknown" (a develop attempt, a pre-v30
      -- row, or a review where the PR fetch failed) and must never be
      -- conflated with a real 0. Reported as-is — no churn is derived here.
      changed_files INTEGER,
      additions INTEGER,
      deletions INTEGER,
      -- Failure reason (v32), copied from the harness's result.json when a
      -- run ends non-successfully. Both nullable: NULL on successful
      -- attempts, on pre-v32 rows, and when the harness reported nothing.
      -- exit_code NULL means "unknown", never a real 0.
      error_message TEXT,
      exit_code INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_task_id ON attempts(task_id);
    -- Reports aggregation (v28): leaderboard grouping by per-attempt model
    -- snapshot, and duration roll-ups partitioned by role.
    CREATE INDEX IF NOT EXISTS idx_attempts_model_id ON attempts(model_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_role ON attempts(role);

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      -- Provider kind (anthropic, openai, openai-compatible, etc.).
      -- Determines credential shape, env-var name, default base_url, and
      -- which harnesses can target this provider. See PROVIDER_KINDS.
      kind TEXT NOT NULL,
      -- Per-provider concurrency cap (an upstream LLM constraint, e.g. an
      -- API rate-limit bucket or a single self-hosted GPU box). 0 means "paused"
      -- (no task assigned to this provider launches). NULL is not allowed.
      -- Independent from the host resource pool (settings.max_agent_memory_mb /
      -- max_agent_cpu_cores), which gates hardware capacity for every task.
      concurrency_limit INTEGER NOT NULL DEFAULT 1 CHECK (concurrency_limit >= 0),
      -- Connection URL. NULL for cloud kinds (uses kind's default). REQUIRED
      -- for self-hosted kinds (openai-compatible).
      base_url TEXT,
      -- Inline secret (bearer/basic auth token for a self-hosted
      -- endpoint, or a cloud API key
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
      -- Context window (tokens) to drive this model with. NULL = unset,
      -- i.e. the harness falls back to its own default (pi's is 128,000).
      -- Operator-supplied because only they know the self-hosted server's
      -- actual --ctx-size; harnesses that can express it write it into
      -- their generated config.
      context_window INTEGER,
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
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
    -- Reports aggregation (v28): event-type lookups bounded by time window.
    CREATE INDEX IF NOT EXISTS idx_task_events_type_created
      ON task_events(event_type, created_at);

    CREATE TABLE IF NOT EXISTS task_steps (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      result_json TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, attempt_number, step_name)
    );

    CREATE INDEX IF NOT EXISTS idx_task_steps_task_attempt
      ON task_steps(task_id, attempt_number);

    -- Synced projection of the checklist under the issue body's
    -- "## Dependencies" heading. The body is the source of truth; the
    -- evaluator in dependencies.ts is the only writer of these rows
    -- (re-derived on every evaluation pass). The scheduler gate and the
    -- UI read them. CASCADE: rows are history that lives and dies with
    -- the task row.
    CREATE TABLE IF NOT EXISTS task_dependencies (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      dep_issue_number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      detail TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_evaluated_at TEXT,
      UNIQUE(task_id, dep_issue_number)
    );

    -- Reverse lookup: "issue #N just closed — which tasks were waiting
    -- on it?" (joined against tasks to scope by repo and status).
    CREATE INDEX IF NOT EXISTS idx_task_deps_reverse
      ON task_dependencies(dep_issue_number);

    -- ---- MCP OAuth (Phase 3 Workstream C) -------------------------------
    --
    -- Three tables back the orchestrator's embedded OAuth 2.1 Authorization
    -- Server for the MCP endpoint (/mcp). The AS issues HS256 JWTs for
    -- access tokens (stateless, validated by signature + aud + exp) and
    -- opaque rotating refresh tokens (stateful, looked up here). DCR
    -- (RFC 7591) clients land in mcp_oauth_clients; one-time-use
    -- authorization codes live in mcp_oauth_codes; refresh tokens in
    -- mcp_oauth_refresh, indexed by family for chain-revocation on reuse.

    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      -- Random opaque id issued by /mcp/oauth/register. Presented by the
      -- client on every authorize + token request.
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      -- JSON array of redirect URIs registered at DCR time. Application
      -- layer enforces loopback-only (http://127.0.0.1:PORT/callback or
      -- http://localhost:PORT/callback) — see RFC 8252.
      redirect_uris TEXT NOT NULL CHECK(json_valid(redirect_uris)),
      -- "native" is the only value accepted today. Stored for forward
      -- compatibility with future client types (web, browser-based).
      application_type TEXT NOT NULL DEFAULT 'native',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      -- The authorization code itself (opaque random, ~32 bytes). PK
      -- so the token endpoint can look up + consume in one statement.
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
      -- Redirect URI used in the authorize request — RFC 6749 §4.1.3
      -- mandates exact match on token-exchange.
      redirect_uri TEXT NOT NULL,
      -- PKCE S256-encoded challenge. The token endpoint verifies
      -- BASE64URL(SHA256(code_verifier)) === code_challenge.
      code_challenge TEXT NOT NULL,
      -- Resource indicator (RFC 8707) the issued access token will be
      -- audience-bound to. The token endpoint requires the resource
      -- parameter to match this value.
      resource TEXT NOT NULL,
      -- Forgejo user login resolved from the orchestrator session
      -- cookie at authorize time. Propagates to the access JWT's sub
      -- claim — this is the identity the resulting token represents.
      forgejo_user_login TEXT NOT NULL,
      -- ISO timestamp; codes expire ~60s after issue.
      expires_at TEXT NOT NULL,
      -- One-time-use marker. NULL = consumable; set on successful
      -- redemption. A second presentation of a consumed code is an
      -- error (and a strong signal of theft).
      consumed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires ON mcp_oauth_codes(expires_at);

    CREATE TABLE IF NOT EXISTS mcp_oauth_refresh (
      -- Opaque refresh token value (~32 bytes random). PK.
      token_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
      -- Refresh-token family. All refresh tokens descending from the
      -- same authorization_code grant share a single family_id; each
      -- rotation propagates it. On reuse-detection (a previously-
      -- revoked or rotated-out token presented again), every row with
      -- this family_id is revoked — the entire client session is
      -- invalidated and the client must re-authorize.
      family_id TEXT NOT NULL,
      forgejo_user_login TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      -- ISO timestamp when this token was rotated out OR a reuse was
      -- detected on it. A revoked token cannot be exchanged.
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_family ON mcp_oauth_refresh(family_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_client ON mcp_oauth_refresh(client_id);
  `);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------
//
// The schema was originally the cumulative result of a 21-step migration
// chain that commit 7e5fe33 collapsed into the single createTables block.
// v21 is the baseline (`MIN_MIGRATABLE_VERSION`); forward migrations from
// there live as `version < N` blocks in this function.
//
// To add a new schema change:
//   1. Update createTables to include the new shape (so fresh installs get
//      it directly).
//   2. Bump CURRENT_SCHEMA_VERSION.
//   3. Add a `if (version < N) { db.exec("ALTER TABLE ..."); }` block
//      below so existing installs can forward-migrate.
//
// The orchestrator refuses to boot against a DB whose schema_version is
// newer than CURRENT_SCHEMA_VERSION (binary was downgraded) or older than
// MIN_MIGRATABLE_VERSION (no migration code present).

function runMigrations(db: Database.Database): void {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const version = row ? parseInt(row.value, 10) : 0;
  _isFirstRun = version === 0;

  if (_isFirstRun) {
    // Fresh install: createTables already produced the current shape.
    // Seed settings + bootstrap providers/models/profile + record
    // schema_version, all in a single transaction. If anything throws
    // inside the closure SQLite rolls back the whole bootstrap, leaving
    // the DB in a clean unconfigured state so the next boot retries
    // from scratch with no half-applied rows mixed into operator edits.
    db.transaction(() => {
      seedDefaultSettings(db);
      seedBootstrapProfile(db);
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)"
      ).run(String(CURRENT_SCHEMA_VERSION));
    })();
    return;
  }

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema_version ${version} is newer than this orchestrator ` +
      `supports (max ${CURRENT_SCHEMA_VERSION}). The orchestrator was downgraded? ` +
      `Restore from a backup taken with the matching binary.`
    );
  }

  if (version < MIN_MIGRATABLE_VERSION) {
    throw new Error(
      `Database schema_version ${version} predates the lowest forward-migratable ` +
      `version (${MIN_MIGRATABLE_VERSION}). Reset the database ` +
      `(delete /data/orchestrator.db) and let the next boot recreate the schema, ` +
      `or restore from a more recent backup.`
    );
  }

  // Forward migrations. Each block is a single ALTER (or batch) wrapped
  // in the surrounding transaction so a partial apply rolls back. The
  // schema_version write at the end is part of the same transaction;
  // if any ALTER throws the version stays at its previous value and
  // the next boot retries.
  if (version < CURRENT_SCHEMA_VERSION) {
    // v27 rebuilds the `tasks` table to swap UNIQUE(issue_id) for
    // UNIQUE(repo_id, issue_id). That requires DROP TABLE tasks, which —
    // with foreign_keys ON — would cascade-delete every attempt / event /
    // step / dependency row that references tasks(id). SQLite ignores
    // `PRAGMA foreign_keys` inside a transaction, so the rebuild must run
    // OUTSIDE the shared migration transaction with FK enforcement toggled
    // off. It is idempotent and does NOT bump schema_version itself: if it
    // succeeds but the transaction below fails, the version stays put and
    // the (no-op-on-already-migrated) rebuild simply re-runs next boot.
    if (version < 27) {
      rebuildTasksWithRepoScopedUnique(db);
    }
    db.transaction(() => {
      if (version < 22) {
        // H5a: snapshot profile.timeout_minutes onto the attempt row so
        // alerts.checkAlerts uses the threshold that was in effect at
        // attempt-launch, not the live profile value. Nullable on
        // existing rows; the alerts consumer falls back to a live read
        // when the snapshot is absent.
        db.exec(
          "ALTER TABLE attempts ADD COLUMN timeout_minutes_snapshot INTEGER"
        );
      }
      if (version < 23) {
        // v23: pre-seed the Claude Subscription provider (kind
        // `claude-subscription`), three Claude models under it, and a
        // ready-to-use `default-claude-code-subscription` profile that
        // pairs the claude-code harness with Sonnet. Operators with an
        // Anthropic Pro/Max subscription set CLAUDE_CODE_OAUTH_TOKEN
        // and switch the global default to this profile (or pick it
        // per-task / per-repo) — no manual provider authoring needed.
        // Idempotent: same INSERT OR IGNORE statements seedBootstrap
        // uses, so re-applying on a hand-edited DB is harmless.
        seedClaudeSubscription(db);
      }
      if (version < 24) {
        // v24: add the three MCP OAuth tables (mcp_oauth_clients /
        // mcp_oauth_codes / mcp_oauth_refresh) that back the embedded
        // Authorization Server at /mcp/oauth/*. createTables already
        // contains the canonical shape with IF NOT EXISTS; the
        // migration just re-runs the same DDL idempotently for
        // existing installs that didn't go through a fresh boot.
        db.exec(`
          CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
            client_id TEXT PRIMARY KEY,
            client_name TEXT,
            redirect_uris TEXT NOT NULL CHECK(json_valid(redirect_uris)),
            application_type TEXT NOT NULL DEFAULT 'native',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
            code TEXT PRIMARY KEY,
            client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
            redirect_uri TEXT NOT NULL,
            code_challenge TEXT NOT NULL,
            resource TEXT NOT NULL,
            forgejo_user_login TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires ON mcp_oauth_codes(expires_at);
          CREATE TABLE IF NOT EXISTS mcp_oauth_refresh (
            token_id TEXT PRIMARY KEY,
            client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
            family_id TEXT NOT NULL,
            forgejo_user_login TEXT NOT NULL,
            resource TEXT NOT NULL,
            scope TEXT,
            issued_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT NOT NULL,
            revoked_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_family ON mcp_oauth_refresh(family_id);
          CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_client ON mcp_oauth_refresh(client_id);
        `);
      }
      if (version < 25) {
        // v25: per-stage agent profiles. Adds a nullable review-stage
        // profile pointer alongside the existing (implementation-stage)
        // one on both tasks and repos. NULL everywhere = review inherits
        // the implementation profile, so existing rows keep today's
        // single-profile behavior bit-for-bit. The matching settings key
        // (default_review_agent_profile_id) needs no migration — the
        // settings table is key/value and the key simply starts absent.
        // SQLite allows ADD COLUMN with a REFERENCES clause when the
        // default is NULL; enforcement applies to new writes only.
        // SQLite has no ADD COLUMN IF NOT EXISTS, so guard via
        // pragma_table_info to keep the block idempotent (a table
        // created fresh by createTables already has the column).
        const hasColumn = (table: string, column: string): boolean =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`
              )
              .get(table, column) as { n: number }
          ).n > 0;
        if (!hasColumn('tasks', 'review_agent_profile_id')) {
          db.exec(
            'ALTER TABLE tasks ADD COLUMN review_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT'
          );
        }
        if (!hasColumn('repos', 'review_agent_profile_id')) {
          db.exec(
            'ALTER TABLE repos ADD COLUMN review_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT'
          );
        }
      }
      if (version < 26) {
        // v26: task_dependencies — synced projection of the issue body's
        // "## Dependencies" checklist, read by the scheduler's dependency
        // gate and the UI. createTables holds the canonical shape with
        // IF NOT EXISTS; re-run the same DDL idempotently for existing
        // installs. (Developed in parallel with v25 — renumbered at merge
        // so both upgrades apply in sequence.)
        db.exec(`
          CREATE TABLE IF NOT EXISTS task_dependencies (
            id INTEGER PRIMARY KEY,
            task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            dep_issue_number INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'open',
            detail TEXT,
            checked INTEGER NOT NULL DEFAULT 0,
            first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_evaluated_at TEXT,
            UNIQUE(task_id, dep_issue_number)
          );
          CREATE INDEX IF NOT EXISTS idx_task_deps_reverse
            ON task_dependencies(dep_issue_number);
        `);
      }
      // v27's data work (the tasks-table rebuild) runs above, outside this
      // transaction, because it must toggle PRAGMA foreign_keys. Nothing to
      // do here — the schema_version bump below records the upgrade.
      if (version < 28) {
        // v28: supporting indexes for the Reports aggregation endpoints.
        // createTables holds the canonical definitions with IF NOT EXISTS;
        // re-run the same DDL idempotently for existing installs. All four
        // are (re)created here — idx_tasks_completed_at in particular,
        // because the v27 tasks-table rebuild (which runs above when
        // upgrading from <27) only recreates the status/repo_id indexes, so
        // a 26→28 upgrade would otherwise lose it.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_attempts_model_id ON attempts(model_id);
          CREATE INDEX IF NOT EXISTS idx_attempts_role ON attempts(role);
          CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at);
          CREATE INDEX IF NOT EXISTS idx_task_events_type_created
            ON task_events(event_type, created_at);
        `);
      }
      if (version < 29) {
        // v29: per-attempt effort metrics (agent turns + token usage +
        // tool-call count), read from the harness's result.json `usage`
        // block at completion. All four are nullable — existing rows
        // simply get NULL (unknown), which the reports/UI distinguish
        // from a real 0. createTables holds the canonical shape; the
        // ALTERs below forward-migrate existing installs. SQLite has no
        // ADD COLUMN IF NOT EXISTS, so guard via pragma_table_info to stay
        // idempotent after a partially-applied migration.
        const hasColumn = (table: string, column: string): boolean =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`
              )
              .get(table, column) as { n: number }
          ).n > 0;
        for (const col of [
          'num_turns',
          'input_tokens',
          'output_tokens',
          'tool_calls',
        ]) {
          if (!hasColumn('attempts', col)) {
            db.exec(`ALTER TABLE attempts ADD COLUMN ${col} INTEGER`);
          }
        }
      }
      if (version < 30) {
        // v30: PR code-churn stats (changed_files / additions / deletions)
        // on the review attempt, captured from the already-fetched Forgejo
        // PR object at review/merge time. All nullable — existing rows get
        // NULL (unknown), which the reports/UI distinguish from a real 0.
        // createTables holds the canonical shape; the ALTERs below
        // forward-migrate existing installs. SQLite has no ADD COLUMN IF
        // NOT EXISTS, so guard via pragma_table_info to stay idempotent
        // after a partially-applied migration.
        const hasColumn = (table: string, column: string): boolean =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`
              )
              .get(table, column) as { n: number }
          ).n > 0;
        for (const col of ['changed_files', 'additions', 'deletions']) {
          if (!hasColumn('attempts', col)) {
            db.exec(`ALTER TABLE attempts ADD COLUMN ${col} INTEGER`);
          }
        }
      }
      if (version < 31) {
        // v31: git-outage resilience state on tasks. Two (level,
        // next_attempt_at) pairs — one for workspace prep, one for deferred
        // salvage pushes. The levels are NOT NULL DEFAULT 0 so existing rows
        // backfill to "no outage in progress"; the timestamps are nullable
        // (NULL = runnable now). createTables holds the canonical shape; the
        // ALTERs below forward-migrate existing installs. SQLite has no ADD
        // COLUMN IF NOT EXISTS, so guard via pragma_table_info to stay
        // idempotent after a partially-applied migration.
        const hasColumn = (table: string, column: string): boolean =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`
              )
              .get(table, column) as { n: number }
          ).n > 0;
        const newColumns: Array<[string, string]> = [
          ['prep_backoff_level', 'INTEGER NOT NULL DEFAULT 0'],
          ['prep_next_attempt_at', 'TEXT'],
          ['salvage_backoff_level', 'INTEGER NOT NULL DEFAULT 0'],
          ['salvage_next_attempt_at', 'TEXT'],
        ];
        for (const [col, decl] of newColumns) {
          if (!hasColumn('tasks', col)) {
            db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${decl}`);
          }
        }
      }
      if (version < 32) {
        // v32: why an attempt ended. The scheduler already reads
        // `error_message` / `exit_code` from the harness's result.json but
        // had nowhere to put them, so a failed attempt rendered as a bare
        // "failed" badge. Both nullable — existing rows (and every
        // successful attempt) stay NULL, which the UI reads as "no reason
        // recorded" rather than showing an empty line. exit_code NULL means
        // unknown, never a real 0. createTables holds the canonical shape;
        // the ALTERs below forward-migrate existing installs. SQLite has no
        // ADD COLUMN IF NOT EXISTS, so guard via pragma_table_info to stay
        // idempotent after a partially-applied migration.
        const hasColumn = (table: string, column: string): boolean =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`
              )
              .get(table, column) as { n: number }
          ).n > 0;
        const newColumns: Array<[string, string]> = [
          ['error_message', 'TEXT'],
          ['exit_code', 'INTEGER'],
        ];
        for (const [col, decl] of newColumns) {
          if (!hasColumn('attempts', col)) {
            db.exec(`ALTER TABLE attempts ADD COLUMN ${col} ${decl}`);
          }
        }
      }
      if (version < 33) {
        // v33: the local-inference provider kind was renamed
        // 'ollama' → 'openai-compatible'. Nothing about it was ever
        // Ollama-specific — both harnesses that support it drive a
        // generic OpenAI-completions endpoint at <base_url>/v1 — and in
        // practice it fronts llama-swap/llama.cpp/vLLM just as often.
        // Rewrite the kind on existing provider rows so they keep
        // resolving against SPECS (providers/kinds.ts) after the rename;
        // provider row ids are operator data and are left untouched.
        // Idempotent (the WHERE matches nothing on a second run) and
        // scoped to the one kind, so no other provider row is touched.
        db.prepare(
          "UPDATE providers SET kind = 'openai-compatible' WHERE kind = 'ollama'"
        ).run();
      }
      if (version < 34) {
        // v34: operator-configurable context window per model. Nullable —
        // existing rows get NULL, which every harness reads as "unset" and
        // keeps emitting the config it emitted before this column existed
        // (pi then falls back to its own 128,000 default). createTables
        // holds the canonical shape; the ALTER below forward-migrates
        // existing installs. SQLite has no ADD COLUMN IF NOT EXISTS, so
        // guard via pragma_table_info to stay idempotent after a
        // partially-applied migration.
        const hasColumn = (table: string, column: string): boolean =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`
              )
              .get(table, column) as { n: number }
          ).n > 0;
        if (!hasColumn('models', 'context_window')) {
          db.exec('ALTER TABLE models ADD COLUMN context_window INTEGER');
        }
      }
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)"
      ).run(String(CURRENT_SCHEMA_VERSION));
    })();
  }
}

/** v27: rebuild `tasks` so uniqueness is scoped to (repo_id, issue_id)
 *  instead of the global issue_id. Forgejo issue numbers are per-repo, so
 *  the old global UNIQUE(issue_id) made two repos' identically-numbered
 *  issues collide on insert (and orphaned the just-created Forgejo issue).
 *
 *  SQLite can't alter a constraint in place, so this follows the standard
 *  rebuild dance: create a correctly-shaped table, copy every row
 *  (preserving ids, defaults, and timestamps), drop the old table, rename
 *  the new one into place, and recreate the indexes.
 *
 *  Runs with foreign_keys OFF: `DROP TABLE tasks` under FK enforcement
 *  would cascade-delete the child attempts/events/steps/dependencies. The
 *  caller guarantees no transaction is open (PRAGMA foreign_keys is a
 *  no-op inside one). Idempotent — a no-op once the table already carries
 *  the repo-scoped constraint, so it's safe to re-run after a partial
 *  migration. */
function rebuildTasksWithRepoScopedUnique(db: Database.Database): void {
  const existing = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
    )
    .get() as { sql: string } | undefined;
  if (!existing) return; // no tasks table yet — fresh createTables shape applies
  if (/UNIQUE\s*\(\s*repo_id\s*,\s*issue_id\s*\)/i.test(existing.sql)) {
    return; // already repo-scoped
  }

  // This block runs BEFORE the column-adding migrations (v22–v26) in the
  // shared transaction, so an old source table may be missing later columns
  // (e.g. review_agent_profile_id, added in v25). Copy only the columns the
  // source actually has — the rest take the new table's defaults (NULL), and
  // the v25 block's hasColumn guard then sees the column already present and
  // skips its ALTER. No tasks column was ever dropped in the migratable
  // range, so the source∩target intersection loses no data.
  const canonicalCols = [
    'id', 'issue_id', 'issue_title', 'repo_id', 'branch_name', 'pr_number',
    'status', 'queue_position', 'attempt', 'max_attempts', 'prep_failure_count',
    'agent_profile_id', 'review_agent_profile_id', 'container_id',
    'started_at', 'completed_at', 'created_at',
  ];
  const sourceCols = new Set(
    (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((c) => c.name)
  );
  const copyCols = canonicalCols.filter((c) => sourceCols.has(c)).join(', ');

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_v27 (
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
          agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
          review_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
          container_id TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(repo_id, issue_id)
        );
        INSERT INTO tasks_v27 (${copyCols})
          SELECT ${copyCols} FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_v27 RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_repo_id ON tasks(repo_id);
      `);
      // Guard against the rebuild having broken any child reference (it
      // shouldn't — ids are preserved verbatim — but cheap to verify while
      // FK enforcement is off and the swap is still inside the transaction).
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `v27 tasks rebuild left dangling foreign keys: ${JSON.stringify(violations)}`
        );
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
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
 *  - No self-hosted (openai-compatible) provider is seeded — operators add
 *    their own with the URL of their server. */
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

  // timeout_minutes matches the column default (2880 min = 2 days) and
  // the documented UI default. Operators with shorter-run preferences
  // tune this per-profile via the Settings UI.
  db.prepare(
    `INSERT OR IGNORE INTO agent_profiles
       (id, display_name, harness_id, model_pk, config_json, timeout_minutes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('default-claude-sdk', 'Claude SDK + Sonnet', 'claude-sdk', sonnetRow.id, '{}', 2880);

  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value)
     VALUES ('default_agent_profile_id', 'default-claude-sdk')`
  ).run();

  // Second turn-key profile: Claude Code CLI against the operator's
  // Anthropic Pro/Max subscription. Doesn't become the global default
  // (claude-sdk is still the most-tested path), but it's present in
  // the UI dropdown so operators who only have a Claude.ai
  // subscription — no API key — can switch to it without authoring
  // anything by hand.
  seedClaudeSubscription(db);
}

/** Idempotent seed for the Claude Subscription provider, its model
 *  rows, and a default `claude-code` profile pointing at Sonnet.
 *  Called from `seedBootstrapProfile` for fresh installs and from the
 *  v23 migration block for existing installs. All inserts use INSERT
 *  OR IGNORE so the helper can run safely against any combination of
 *  pre-existing operator rows. */
function seedClaudeSubscription(db: Database.Database): void {
  // Provider row. CLAUDE_CODE_OAUTH_TOKEN is the orchestrator
  // convention for surfacing the subscription token to the in-
  // container Claude Code CLI (see providers/kinds.ts —
  // `container_env_name: 'CLAUDE_CODE_OAUTH_TOKEN'`).
  db.prepare(
    `INSERT OR IGNORE INTO providers
       (id, display_name, kind, concurrency_limit, base_url, auth_token, api_key_env_var, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'claude-subscription',
    'Claude Subscription (Pro/Max)',
    'claude-subscription',
    5,
    null,
    null,
    'CLAUDE_CODE_OAUTH_TOKEN',
    null
  );

  // Models. Same canonical names as the Anthropic-API provider — the
  // Claude Code CLI accepts them under subscription auth too. They
  // live as separate model rows because the (provider_id, model_id)
  // pair is the unique key; subscription and API access are two
  // different routing destinations.
  const insertModel = db.prepare(
    `INSERT OR IGNORE INTO models (provider_id, model_id, display_name) VALUES (?, ?, ?)`
  );
  const models: Array<[string, string]> = [
    ['claude-opus-4-7', 'Claude Opus 4.7'],
    ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
    ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ];
  for (const [model_id, display_name] of models) {
    insertModel.run('claude-subscription', model_id, display_name);
  }

  // Profile. Best-effort — only insert when the seeded Sonnet model
  // row is present (it will be unless an operator hand-deleted it
  // between this helper's two halves; in that case the migration
  // still completes and the operator can author the profile manually).
  const subSonnet = db
    .prepare(
      "SELECT id FROM models WHERE provider_id = 'claude-subscription' AND model_id = 'claude-sonnet-4-6'"
    )
    .get() as { id: number } | undefined;
  if (subSonnet) {
    db.prepare(
      `INSERT OR IGNORE INTO agent_profiles
         (id, display_name, harness_id, model_pk, config_json, timeout_minutes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'default-claude-code-subscription',
      'Claude Code + Sonnet (subscription)',
      'claude-code',
      subSonnet.id,
      '{}',
      2880
    );
  }
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

/** Repo-scoped issue lookup. Forgejo issue numbers are per-repo, so a bare
 *  `issue_id` is ambiguous across repos — always pair it with `repo_id`.
 *  Alias of {@link getTaskByRepoIssue}, kept for call sites that read more
 *  naturally as "the task tracking this issue". */
export function getTaskByIssue(
  repoId: number,
  issueId: number
): Task | undefined {
  return getTaskByRepoIssue(repoId, issueId);
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

/** Stored statuses the dashboard list returns in full — the active bucket
 *  (`ACTIVE_STATUSES` in routes/tasks.ts) plus `queued`. Everything else is
 *  "completed" and bounded by recency. */
const DASHBOARD_LIVE_STATUSES = [
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
  'queued',
] as const;

/** The dashboard task list with the completed-history bound pushed into SQL,
 *  mirroring the paginate-first pattern of {@link getReportTasks}: live
 *  (active + queued) rows in full, in queue order, followed by the
 *  `completedLimit` most recently completed rows. Without the push-down the
 *  route loaded, snapshot-warmed and enriched the ENTIRE task history on
 *  every poll just to slice the completed bucket afterwards — and that slice
 *  ran in `queue_position` order, so "recent completions" silently meant
 *  "oldest queue positions", not recency.
 *
 *  Bucketing here is by the STORED status; the route re-buckets on the
 *  Forgejo-derived status after enrichment, which can only move a stored-live
 *  row into the completed bucket (deriveStatus never produces an
 *  active/queued status unless it was stored) — hence the caller fetches a
 *  small margin above its display limit and keeps the post-enrichment slice.
 *
 *  Completed recency orders by `completed_at` (julianday-normalized across
 *  the two stored timestamp formats), nulls last, ties broken by id — the
 *  same shape as getReportTasks' completed sort. */
export function getDashboardTasks(completedLimit: number): Task[] {
  const placeholders = DASHBOARD_LIVE_STATUSES.map(() => '?').join(',');

  const live = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE status IN (${placeholders})
        ORDER BY queue_position ASC, id ASC`
    )
    .all(...DASHBOARD_LIVE_STATUSES) as Task[];

  // A non-finite limit (unparseable ?limit=) yields zero completed rows,
  // matching the old behaviour of `completed.slice(0, NaN)`.
  const limit = Number.isFinite(completedLimit)
    ? Math.max(0, Math.trunc(completedLimit))
    : 0;
  const completed = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE status NOT IN (${placeholders})
        ORDER BY (completed_at IS NULL) ASC, ${juld('completed_at')} DESC, id DESC
        LIMIT ?`
    )
    .all(...DASHBOARD_LIVE_STATUSES, limit) as Task[];

  return [...live, ...completed];
}

/** Tasks whose deferred salvage push has come due (v31).
 *
 *  A salvage push that fails while the git host is down parks the task with
 *  `salvage_next_attempt_at` set instead of emitting a terminal
 *  `salvage_failed` — the agent's work is preserved on disk, so the push is
 *  simply re-attempted later. Scoped to `in-progress` because that's the
 *  status a task deferring salvage sits in; a task that has since been
 *  reset, cancelled, or failed by another path must not be resurrected by
 *  the retry sweep. `container_id IS NULL` is the second half of that
 *  guard: a task whose dev agent is running again (a stale timestamp that
 *  outlived a requeue) must never have its workspace committed and pushed
 *  out from under the live agent. */
export function getTasksWithSalvageDue(nowIso: string): Task[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
        WHERE status = 'in-progress'
          AND container_id IS NULL
          AND salvage_next_attempt_at IS NOT NULL
          AND salvage_next_attempt_at <= ?
        ORDER BY salvage_next_attempt_at ASC, id ASC`
    )
    .all(nowIso) as Task[];
}

export function insertTask(task: {
  issue_id: number;
  issue_title?: string | null;
  repo_id: number;
  status: TaskStatus;
  queue_position?: number;
  max_attempts?: number;
  agent_profile_id?: string | null;
  review_agent_profile_id?: string | null;
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
      `INSERT INTO tasks (issue_id, issue_title, repo_id, status, queue_position, max_attempts, agent_profile_id, review_agent_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.issue_id,
      task.issue_title ?? null,
      task.repo_id,
      task.status,
      queuePos,
      task.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      task.agent_profile_id ?? null,
      task.review_agent_profile_id ?? null
    );

  return getTask(result.lastInsertRowid as number)!;
}

/**
 * Raw `UPDATE tasks` — writes the columns and nothing else.
 *
 * It does NOT broadcast a `task_updated` WebSocket event, does NOT record a
 * status timeline event, and does NOT sync the Forgejo `status/*` label.
 * Prefer `updateTaskWithSync` from `state-sync.ts` unless you have a specific
 * reason not to: a status change written through here is invisible to every
 * connected browser until the next manual reload. The legitimate exceptions
 * are internal bookkeeping writes that change no task STATUS — scheduling and
 * backoff fields, and the `container_id` clears whose visible consequence is
 * owned by a broadcasting write that follows. Each such call site carries a
 * comment saying which case it is.
 */
export function updateTaskRaw(
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
      | 'prep_backoff_level'
      | 'prep_next_attempt_at'
      | 'salvage_backoff_level'
      | 'salvage_next_attempt_at'
      | 'agent_profile_id'
      | 'review_agent_profile_id'
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
  /** Snapshot of profile.timeout_minutes at launch. Persisted so a
   *  later profile edit can't move the stuck-task threshold under an
   *  already-running attempt. */
  timeout_minutes_snapshot?: number | null;
}): Attempt {
  const result = getDb()
    .prepare(
      `INSERT INTO attempts
         (task_id, attempt_number, role, status, started_at,
          model_id, harness_id, timeout_minutes_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      attempt.task_id,
      attempt.attempt_number,
      attempt.role,
      attempt.status,
      attempt.started_at ?? new Date().toISOString(),
      attempt.model_id ?? null,
      attempt.harness_id ?? null,
      attempt.timeout_minutes_snapshot ?? null
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
      | 'num_turns'
      | 'input_tokens'
      | 'output_tokens'
      | 'tool_calls'
      | 'changed_files'
      | 'additions'
      | 'deletions'
      | 'error_message'
      | 'exit_code'
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

/**
 * Re-point every attempt of a task at one log location.
 *
 * Every attempt of a task already records the same `log_path` — the task's
 * `<workspace>/.output/progress.log` — so when that log is archived they all
 * move together; hence one statement rather than a per-attempt
 * `updateAttempt`. Called by `archiveTaskArtifacts` so `attempts.log_path`
 * keeps pointing at a file that still exists after the workspace is swept.
 */
export function updateAttemptsLogPath(taskId: number, logPath: string): void {
  getDb()
    .prepare('UPDATE attempts SET log_path = ? WHERE task_id = ?')
    .run(logPath, taskId);
}

export function getAttempts(taskId: number): Attempt[] {
  return getDb()
    .prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY id ASC')
    .all(taskId) as Attempt[];
}

/** Most recently inserted attempt for a task. Used by the
 *  container-exit handler to recover the run's role (develop vs
 *  review) from the authoritative DB row rather than the meta.json
 *  file dropped into the workspace, which can be missing or stale
 *  after orchestrator restarts.
 *
 *  NOTE: this returns the most recent attempt REGARDLESS of status. In
 *  the gap window between `completeAttempt` flipping dev → completed
 *  and `launchReviewContainer` inserting the review row, this returns
 *  the completed dev attempt. Callers that semantically want "the
 *  currently running attempt" should use `getActiveAttempt` instead
 *  (M3). */
export function getLatestAttempt(taskId: number): Attempt | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM attempts WHERE task_id = ? ORDER BY id DESC LIMIT 1'
    )
    .get(taskId) as Attempt | undefined;
}

/** Most recently inserted attempt for a task FILTERED to status='running'.
 *  Used by `alerts.checkAlerts` and `Scheduler.enforceTimeouts` — both
 *  ask "is this task's current attempt past its timeout?", which only
 *  makes sense for an attempt that's still running. Returns undefined
 *  in the gap window between completing the dev attempt and inserting
 *  the review attempt; callers skip the task in that case.
 *
 *  Returning at most one row by `id DESC LIMIT 1` matches the
 *  invariant that a task has at most one running attempt at a time
 *  (state-machine enforced by the scheduler — there is no path that
 *  inserts a new running row without first completing the previous
 *  one). The LIMIT 1 + ORDER BY is defence-in-depth for the case
 *  where a hypothetical bug inserted two; we'd get the most recent. */
export function getActiveAttempt(taskId: number): Attempt | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM attempts WHERE task_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1"
    )
    .get(taskId) as Attempt | undefined;
}

/** Every currently-running attempt, across all tasks — the batch counterpart
 *  of {@link getActiveAttempt} for list serializers. Bounded by scheduler
 *  concurrency (at most one running attempt per active task), so the result
 *  is tiny regardless of history size, and it skips the completed rows whose
 *  large `feedback` blobs made per-task `getAttempts` calls expensive.
 *  Ordered by id ASC so a task_id-keyed map built by overwrite keeps the
 *  highest id per task, matching getActiveAttempt's `id DESC LIMIT 1`
 *  defence-in-depth. */
export function getRunningAttempts(): Attempt[] {
  return getDb()
    .prepare("SELECT * FROM attempts WHERE status = 'running' ORDER BY id ASC")
    .all() as Attempt[];
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

/** Cumulative review-feedback history for a task: every COMPLETED review
 *  attempt that returned `changes_needed` with non-null feedback, oldest
 *  → newest by attempt_number. This is the authoritative source for the
 *  rework prompt's feedback section — an implementer fixing attempt N
 *  regresses earlier fixes when it can't see attempts 1..N-1. Reading
 *  the persisted attempts table (rather than in-memory state) keeps the
 *  full history available even after an orchestrator restart mid-rework.
 *  `verdict` is only ever written on review-role rows by completeAttempt,
 *  so the role filter is belt-and-braces against future schema changes.
 *  The `id` tiebreaker makes ordering deterministic if a retried review
 *  ever produced two completed rows for one attempt_number. */
export function getReviewFeedbackHistory(taskId: number): Attempt[] {
  return getDb()
    .prepare(
      `SELECT * FROM attempts
        WHERE task_id = ?
          AND role = 'review'
          AND status = 'completed'
          AND verdict = 'changes_needed'
          AND feedback IS NOT NULL
        ORDER BY attempt_number ASC, id ASC`
    )
    .all(taskId) as Attempt[];
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
  context_window?: number | null;
}): Model {
  const result = getDb()
    .prepare(
      'INSERT INTO models (provider_id, model_id, display_name, context_window) VALUES (?, ?, ?, ?)'
    )
    .run(m.provider_id, m.model_id, m.display_name, m.context_window ?? null);
  return getModel(result.lastInsertRowid as number)!;
}

/** Patch the editable fields of a model row. Only the keys present in
 *  `updates` are written, so clearing `context_window` needs an explicit
 *  `null` (an absent key leaves the stored value alone). */
export function updateModel(
  id: number,
  updates: Partial<Pick<Model, 'display_name' | 'context_window'>>
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (updates.display_name !== undefined) {
    sets.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.context_window !== undefined) {
    sets.push('context_window = ?');
    values.push(updates.context_window);
  }
  if (sets.length === 0) return;
  getDb()
    .prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id);
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

/** Walk the profile-id chain for a workflow stage, reporting which tier
 *  supplied the id (for error attribution). Chains:
 *    develop: task.agent_profile_id → repo.agent_profile_id
 *             → settings.default_agent_profile_id
 *    review:  task.review_agent_profile_id → repo.review_agent_profile_id
 *             → settings.default_review_agent_profile_id
 *             → <the develop chain>
 *  The review chain's terminal fallback to the develop chain preserves
 *  single-profile behavior for installs that never configure a review
 *  profile. Shared by the scheduler (launch + pool gating) and alerts
 *  (stuck-task threshold fallback). Returns null when every tier is
 *  unset. */
export function resolveStageProfileId(
  task: Task,
  repo: Repo | undefined,
  stage: AttemptRole
): { id: string; source: string } | null {
  if (stage === 'review') {
    if (task.review_agent_profile_id) {
      return {
        id: task.review_agent_profile_id,
        source: `task ${task.id} (review override)`,
      };
    }
    if (repo?.review_agent_profile_id) {
      return {
        id: repo.review_agent_profile_id,
        source: `repo ${repo.owner}/${repo.name} (review default)`,
      };
    }
    const reviewDefault = getSetting('default_review_agent_profile_id');
    if (reviewDefault) {
      return {
        id: reviewDefault,
        source: 'settings.default_review_agent_profile_id',
      };
    }
    // No review-specific profile at any tier — fall through to the
    // develop chain below.
  }
  if (task.agent_profile_id) {
    return { id: task.agent_profile_id, source: `task ${task.id}` };
  }
  if (repo?.agent_profile_id) {
    return {
      id: repo.agent_profile_id,
      source: `repo ${repo.owner}/${repo.name}`,
    };
  }
  const globalDefault = getSetting('default_agent_profile_id');
  if (globalDefault) {
    return { id: globalDefault, source: 'settings.default_agent_profile_id' };
  }
  return null;
}

export function getAgentProfiles(): AgentProfile[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_profiles ORDER BY id')
    .all() as Record<string, unknown>[];
  return rows.map((r) => hydrateAgentProfile(r)!);
}

/** Bulk variant: returns every profile pre-joined with its model row and
 *  with `repos_using` / `tasks_using` counts in a single SQL pass.
 *  Replaces the N+1 pattern of `getAgentProfiles().map(p =>
 *  countReposUsingProfile(p.id) + countTasksUsingProfile(p.id) +
 *  getModel(p.model_pk))` on the Settings list-load path. */
export interface AgentProfileWithJoinedStats extends AgentProfile {
  repos_using: number;
  tasks_using: number;
  provider_id: string | null;
  model_id: string | null;
}

/** Shared query body. Returning the same column set keeps the bulk and
 *  singleton paths in lock-step — adding a field to
 *  `AgentProfileWithJoinedStats` here updates both response shapes at
 *  once (consolidates the previous singleton-enrich-by-hand path that
 *  could drift if anyone added a field). */
const AGENT_PROFILE_WITH_STATS_SELECT = `
  SELECT
    ap.*,
    m.provider_id AS joined_provider_id,
    m.model_id    AS joined_model_id,
    (SELECT COUNT(*) FROM repos r
       WHERE r.agent_profile_id = ap.id
          OR r.review_agent_profile_id = ap.id) AS repos_using,
    (SELECT COUNT(*) FROM tasks t
       WHERE t.agent_profile_id = ap.id
          OR t.review_agent_profile_id = ap.id) AS tasks_using
  FROM agent_profiles ap
  LEFT JOIN models m ON m.id = ap.model_pk`;

function hydrateProfileWithStats(
  row: Record<string, unknown>
): AgentProfileWithJoinedStats {
  const base = hydrateAgentProfile(row)!;
  return {
    ...base,
    repos_using: Number(row.repos_using ?? 0),
    tasks_using: Number(row.tasks_using ?? 0),
    provider_id: (row.joined_provider_id as string | null) ?? null,
    model_id: (row.joined_model_id as string | null) ?? null,
  };
}

export function getAgentProfilesWithStats(): AgentProfileWithJoinedStats[] {
  const rows = getDb()
    .prepare(`${AGENT_PROFILE_WITH_STATS_SELECT} ORDER BY ap.id`)
    .all() as Record<string, unknown>[];
  return rows.map(hydrateProfileWithStats);
}

/** Singleton variant of `getAgentProfilesWithStats` used by POST/PATCH
 *  response paths. Same column set, same hydration function, so the
 *  list and singleton response shapes can never diverge. */
export function getAgentProfileWithStats(
  id: string
): AgentProfileWithJoinedStats | undefined {
  const row = getDb()
    .prepare(`${AGENT_PROFILE_WITH_STATS_SELECT} WHERE ap.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return hydrateProfileWithStats(row);
}

/** Single-pass per-provider active-slot tally for the dashboard.
 *
 *  Stage-aware: a task in `in-review` resolves through the review chain
 *  `task.review_agent_profile_id → repo.review_agent_profile_id →
 *  settings.default_review_agent_profile_id → <implementation chain>`;
 *  every other active status resolves through the implementation chain
 *  `task.agent_profile_id → repo.agent_profile_id →
 *  settings.default_agent_profile_id`. The resolved profile then jumps
 *  to its model's `provider_id`. Implemented as one SQL join rather
 *  than N tasks × helper-fn calls in JS.
 *
 *  The returned Map's key is the resolved provider id, or '' (empty
 *  string) for tasks where no profile could be resolved.
 *
 *  "Active" = status IN (preparing, in-progress, in-review) AND
 *  container_id IS NOT NULL — same filter the JS-side enrichers use. */
export function getActivePerProviderCounts(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT COALESCE(m.provider_id, '') AS provider_id, COUNT(*) AS n
       FROM tasks t
       LEFT JOIN repos r ON r.id = t.repo_id
       LEFT JOIN settings s ON s.key = 'default_agent_profile_id'
       LEFT JOIN settings sr ON sr.key = 'default_review_agent_profile_id'
       LEFT JOIN agent_profiles ap
         ON ap.id = CASE WHEN t.status = 'in-review'
           THEN COALESCE(
             t.review_agent_profile_id, r.review_agent_profile_id, sr.value,
             t.agent_profile_id, r.agent_profile_id, s.value)
           ELSE COALESCE(t.agent_profile_id, r.agent_profile_id, s.value)
         END
       LEFT JOIN models m ON m.id = ap.model_pk
       WHERE t.status IN ('preparing','in-progress','in-review')
         AND t.container_id IS NOT NULL
       GROUP BY COALESCE(m.provider_id, '')`
    )
    .all() as { provider_id: string; n: number }[];
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.provider_id, row.n);
  return out;
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
  // `settings.default_agent_profile_id` is a plain key/value row, not a
  // foreign key — SQLite cannot cascade-clear it on profile delete. We
  // do it in application code, transactionally, so the pointer never
  // dangles. Route-layer delete-safety checks should still refuse this
  // delete when the profile is in use (repos/tasks/the global default
  // pointing at it), but if the operator bypasses the route — direct
  // DB edit, future code path — we still maintain referential integrity
  // for the settings pointer instead of leaving it dangling.
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM settings
         WHERE key IN ('default_agent_profile_id', 'default_review_agent_profile_id')
           AND value = ?`
    ).run(id);
    db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
  })();
}

/** Atomically check delete-safety invariants AND delete the profile in a
 *  single transaction (M4). The route-layer check + delete was previously
 *  split across two non-transactional reads: a concurrent
 *  `PATCH /api/settings` setting the default to THIS profile between the
 *  check and the delete would slip past the route check, then the
 *  DB-layer transactional clear in `deleteAgentProfile` would silently
 *  wipe the freshly-set legitimate pointer.
 *
 *  Wrapping both reads (`getSetting`, `countReposUsingProfile`,
 *  `countTasksUsingProfile`) and the delete in one transaction
 *  serialises against any concurrent settings/repos/tasks writes via
 *  SQLite's WAL transaction semantics (per-connection serialisable),
 *  so the post-check state we delete against is the same state the
 *  caller saw.
 *
 *  Returns the reason the delete was refused, or null on success. */
export function deleteAgentProfileIfUnreferenced(id: string): string | null {
  const db = getDb();
  return db.transaction(() => {
    const defaultRow = db
      .prepare("SELECT value FROM settings WHERE key = 'default_agent_profile_id'")
      .get() as { value: string } | undefined;
    if (defaultRow?.value === id) {
      return (
        `'${id}' is the global default profile. ` +
        `Set a different default before deleting.`
      );
    }
    const reviewDefaultRow = db
      .prepare(
        "SELECT value FROM settings WHERE key = 'default_review_agent_profile_id'"
      )
      .get() as { value: string } | undefined;
    if (reviewDefaultRow?.value === id) {
      return (
        `'${id}' is the global default review profile. ` +
        `Set a different review default (or clear it) before deleting.`
      );
    }
    const reposUsing = (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM repos WHERE agent_profile_id = ? OR review_agent_profile_id = ?'
        )
        .get(id, id) as { n: number }
    ).n;
    const tasksUsing = (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM tasks WHERE agent_profile_id = ? OR review_agent_profile_id = ?'
        )
        .get(id, id) as { n: number }
    ).n;
    if (reposUsing > 0 || tasksUsing > 0) {
      return (
        `Profile is referenced by ${reposUsing} repo(s) and ${tasksUsing} ` +
        `task(s). Reassign those before deleting.`
      );
    }
    // Inline the delete here (rather than calling `deleteAgentProfile`
    // recursively) so the whole check+delete is one db.transaction frame.
    db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
    return null;
  })();
}

export function countReposUsingProfile(profileId: string): number {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS n FROM repos WHERE agent_profile_id = ? OR review_agent_profile_id = ?'
    )
    .get(profileId, profileId) as { n: number };
  return row.n;
}

export function countTasksUsingProfile(profileId: string): number {
  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS n FROM tasks WHERE agent_profile_id = ? OR review_agent_profile_id = ?'
    )
    .get(profileId, profileId) as { n: number };
  return row.n;
}

// -- Task Events --

export function insertTaskEvent(
  taskId: number,
  eventType: string,
  message: string
): TaskEvent {
  // We populate `created_at` explicitly with `new Date().toISOString()` to
  // match the rest of the codebase, which always emits ISO 8601 UTC with the
  // trailing `Z`. The column DEFAULT `(datetime('now'))` still exists in the
  // schema but is intentionally no longer the source of truth — it returns
  // `"YYYY-MM-DD HH:MM:SS"` with no `T`/`Z`, which the browser parses as
  // local time and breaks the timeline's "X ago" display (issue #72).
  const createdAt = new Date().toISOString();
  const result = getDb()
    .prepare(
      'INSERT INTO task_events (task_id, event_type, message, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(taskId, eventType, message, createdAt);

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

// -- Task dependencies --
//
// Rows are a synced projection of the issue body's "## Dependencies"
// checklist. dependencies.ts owns all writes (the evaluator re-derives
// rows from the body); everything else reads.

/** SQLite stores `checked` as 0/1 — convert to the TaskDependency shape. */
function rowToTaskDependency(row: Record<string, unknown>): TaskDependency {
  return { ...row, checked: Boolean(row.checked) } as TaskDependency;
}

export function getTaskDependencies(taskId: number): TaskDependency[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM task_dependencies WHERE task_id = ? ORDER BY id ASC'
      )
      .all(taskId) as Record<string, unknown>[]
  ).map(rowToTaskDependency);
}

/** Tasks in `repoId` with a dependency row on `depIssueNumber`. Used by the
 *  issue-closed webhook to re-evaluate just the affected dependents. */
export function getDependentTasks(
  repoId: number,
  depIssueNumber: number
): Task[] {
  return getDb()
    .prepare(
      `SELECT t.* FROM tasks t
       JOIN task_dependencies d ON d.task_id = t.id
       WHERE t.repo_id = ? AND d.dep_issue_number = ?
       ORDER BY t.queue_position ASC, t.id ASC`
    )
    .all(repoId, depIssueNumber) as Task[];
}

/** Repo-scoped issue lookup. Forgejo issue numbers are per-repo;
 *  dependency resolution must never match a same-numbered issue from
 *  another repo. */
export function getTaskByRepoIssue(
  repoId: number,
  issueNumber: number
): Task | undefined {
  return getDb()
    .prepare('SELECT * FROM tasks WHERE repo_id = ? AND issue_id = ?')
    .get(repoId, issueNumber) as Task | undefined;
}

export function upsertTaskDependency(dep: {
  task_id: number;
  dep_issue_number: number;
  state: DependencyState;
  detail: string | null;
  checked: boolean;
  last_evaluated_at: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO task_dependencies
         (task_id, dep_issue_number, state, detail, checked, first_seen_at, last_evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, dep_issue_number) DO UPDATE SET
         state = excluded.state,
         detail = excluded.detail,
         checked = excluded.checked,
         last_evaluated_at = excluded.last_evaluated_at`
    )
    .run(
      dep.task_id,
      dep.dep_issue_number,
      dep.state,
      dep.detail,
      dep.checked ? 1 : 0,
      new Date().toISOString(),
      dep.last_evaluated_at
    );
}

/** Delete rows for deps no longer present in the body. `keep` is the set of
 *  issue numbers the latest parse produced; an empty set clears all rows. */
export function deleteTaskDependenciesExcept(
  taskId: number,
  keep: ReadonlySet<number>
): number {
  if (keep.size === 0) {
    return getDb()
      .prepare('DELETE FROM task_dependencies WHERE task_id = ?')
      .run(taskId).changes;
  }
  const placeholders = [...keep].map(() => '?').join(', ');
  return getDb()
    .prepare(
      `DELETE FROM task_dependencies
       WHERE task_id = ? AND dep_issue_number NOT IN (${placeholders})`
    )
    .run(taskId, ...keep).changes;
}

// -- Settings --

export function getSetting(key: SettingsKey): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/** Read an integer setting. Returns 0 when the setting is missing, the
 *  empty string, or not parseable as an integer — callers that need to
 *  distinguish "unset" from "set to 0" should use `getSetting` directly
 *  and parse themselves. The current consumers (`max_agent_memory_mb`,
 *  `max_agent_cpu_cores`) treat 0 as "pool saturated / paused", which
 *  is a safe default for the missing case. */
export function getSettingInt(key: SettingsKey): number {
  const value = getSetting(key);
  if (value === undefined || value === '') return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Upsert (or delete) a settings row. `null` deletes the row so the
 *  next `getSetting` returns `undefined`, which callers reading the
 *  resolution chain (e.g. agent_profile_id) interpret as "no fallback
 *  configured". Used by Global Settings to support clearing
 *  `default_agent_profile_id`. */
export function updateSetting(key: SettingsKey, value: string | null): void {
  if (value === null) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
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

// ---------------------------------------------------------------------------
// Reports — read-only aggregation
// ---------------------------------------------------------------------------
//
// All aggregation happens in SQL (GROUP BY + aggregate/window functions);
// JS only stitches the small per-group result sets together. Endpoints are
// O(groups), never O(rows-shipped).
//
// Timestamp-format gotcha: two on-disk shapes coexist in this DB —
//   * `created_at` defaults to datetime('now')      → "YYYY-MM-DD HH:MM:SS"
//   * started_at/completed_at via toISOString()     → "YYYY-MM-DDThh:mm:ss.sssZ"
// Both are UTC. Before any julianday()/comparison we normalize via
// `normTsSql` (SQL) — and the pure-JS `normalizeTimestamp`/`durationSeconds`
// below mirror that contract for callers/tests outside SQL.

/** All TaskStatus values, used to zero-fill the overview status map so the
 *  UI always sees every bucket. Kept in sync with the TaskStatus union. */
const ALL_TASK_STATUSES: TaskStatus[] = TASK_STATUSES;

/** Normalize a stored timestamp to canonical ISO-8601 UTC ("…Z"),
 *  tolerating both the space-separated datetime('now') form and the
 *  toISOString() form. Naive (zone-less) inputs are treated as UTC — every
 *  timestamp this orchestrator writes is UTC. Mirrors `normTsSql`. */
export function normalizeTimestamp(ts: string): string {
  let s = ts.trim().replace(' ', 'T');
  // Append a UTC marker when the value carries no zone designator so
  // `new Date()` parses it as UTC rather than local time.
  if (!/[zZ]$/.test(s) && !/[+-]\d\d:?\d\d$/.test(s)) {
    s += 'Z';
  }
  return new Date(s).toISOString();
}

/** Seconds between two stored timestamps, each independently normalized.
 *  Correct across the mixed datetime('now') / toISOString() formats. */
export function durationSeconds(start: string, end: string): number {
  return (
    (Date.parse(normalizeTimestamp(end)) -
      Date.parse(normalizeTimestamp(start))) /
    1000
  );
}

/** SQL counterpart of {@link normalizeTimestamp}: rewrite a timestamp
 *  column so both stored forms become a single julianday()-parseable,
 *  lexically-comparable shape (space→'T', drop trailing 'Z'). */
function normTsSql(col: string): string {
  return `replace(replace(${col}, ' ', 'T'), 'Z', '')`;
}

/** `julianday()` of a normalized timestamp column. */
function juld(col: string): string {
  return `julianday(${normTsSql(col)})`;
}

interface RangeFragment {
  clause: string;
  params: unknown[];
}

/** A filter with repo scoping and optional date bounds. {@link ReportFilter}
 *  satisfies it (its bounds are always set); the attempts export passes null
 *  bounds to mean "all history". */
interface RangeFilter {
  repos: number[] | null;
  from: string | null;
  to: string | null;
}

/** WHERE fragment (alias `t`) selecting rows whose `col` falls in
 *  [from, to), optionally narrowed to `filter.repos`. A null bound is
 *  omitted (open-ended); with no bounds and no repos the fragment is the
 *  always-true `1=1` so it can be interpolated unconditionally. */
function rangeClause(col: string, filter: RangeFilter): RangeFragment {
  const n = `${juld(col)}`;
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.from !== null) {
    parts.push(`${n} >= julianday(?)`);
    params.push(filter.from);
  }
  if (filter.to !== null) {
    parts.push(`${n} < julianday(?)`);
    params.push(filter.to);
  }
  if (filter.repos && filter.repos.length > 0) {
    parts.push(`t.repo_id IN (${filter.repos.map(() => '?').join(',')})`);
    params.push(...filter.repos);
  }
  return { clause: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
}

/** Repo-only WHERE fragment (alias `t`) for point-in-time metrics that
 *  ignore the date window (e.g. current backlog). */
function repoClause(filter: RangeFilter): RangeFragment {
  if (filter.repos && filter.repos.length > 0) {
    return {
      clause: `t.repo_id IN (${filter.repos.map(() => '?').join(',')})`,
      params: [...filter.repos],
    };
  }
  return { clause: '1=1', params: [] };
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Nearest-rank percentile index expression over a window column `n`
 *  (= COUNT(*) OVER ()). rank = clamp(ceil(p·n), 1, n). `ceil` is built
 *  from CAST-truncate + a fractional-part bump so it works regardless of
 *  the bundled SQLite's ceil() availability. */
function nearestRank(p: number): string {
  const pn = `${p} * n`;
  return `MAX(1, MIN(n, CAST(${pn} AS INT) + (${pn} > CAST(${pn} AS INT))))`;
}

/** Run a duration roll-up (count, mean, p50, p90 in seconds) over a
 *  values subquery that yields a single column `d`. Percentiles are
 *  computed in SQL via window functions — no per-row JS reduction. */
function computeDurationStats(
  valuesSql: string,
  params: unknown[]
): DurationStats {
  const row = getDb()
    .prepare(
      `WITH vals AS (${valuesSql}),
       ordered AS (
         SELECT d, ROW_NUMBER() OVER (ORDER BY d) AS rn, COUNT(*) OVER () AS n
         FROM vals
       )
       SELECT
         (SELECT COUNT(*) FROM vals) AS count,
         (SELECT AVG(d) FROM vals) AS avg,
         (SELECT d FROM ordered WHERE rn = ${nearestRank(0.5)}) AS p50,
         (SELECT d FROM ordered WHERE rn = ${nearestRank(0.9)}) AS p90`
    )
    .get(...params) as {
    count: number;
    avg: number | null;
    p50: number | null;
    p90: number | null;
  };
  return {
    count: Number(row.count ?? 0),
    avg_seconds: numOrNull(row.avg),
    p50_seconds: numOrNull(row.p50),
    p90_seconds: numOrNull(row.p90),
  };
}

/** KPI roll-up for `GET /api/reports/overview`. */
export function getReportOverview(filter: ReportFilter): ReportsOverview {
  const db = getDb();
  const cohort = rangeClause('t.created_at', filter);

  // Status counts over the created-in-range cohort.
  const statusRows = db
    .prepare(
      `SELECT t.status AS status, COUNT(*) AS c
       FROM tasks t WHERE ${cohort.clause} GROUP BY t.status`
    )
    .all(...cohort.params) as { status: TaskStatus; c: number }[];
  const status_counts = Object.fromEntries(
    ALL_TASK_STATUSES.map((s) => [s, 0])
  ) as Record<TaskStatus, number>;
  for (const r of statusRows) status_counts[r.status] = Number(r.c);

  const total_tasks = ALL_TASK_STATUSES.reduce(
    (sum, s) => sum + status_counts[s],
    0
  );
  const terminal_counts = {
    merged: status_counts.merged,
    failed: status_counts.failed,
    cancelled: status_counts.cancelled,
  };
  const terminal =
    terminal_counts.merged + terminal_counts.failed + terminal_counts.cancelled;
  const success_rate = terminal > 0 ? terminal_counts.merged / terminal : null;

  // Throughput: tasks merged whose completed_at lands in the window.
  const mergedRange = rangeClause('t.completed_at', filter);
  const tasksMerged = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks t
         WHERE t.status = 'merged' AND t.completed_at IS NOT NULL
           AND ${mergedRange.clause}`
      )
      .get(...mergedRange.params) as { c: number }
  ).c;

  // Backlog: point-in-time, repo-scoped only.
  const repo = repoClause(filter);
  const backlogRow = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tasks t
            WHERE t.status = 'queued' AND ${repo.clause}) AS queued,
         (SELECT COUNT(*) FROM tasks t
            WHERE t.status = 'queued' AND ${repo.clause}
              AND EXISTS (
                SELECT 1 FROM task_dependencies d
                WHERE d.task_id = t.id
                  AND d.state NOT IN ('satisfied', 'manually-satisfied')
              )) AS blocked`
    )
    .get(...repo.params, ...repo.params) as {
    queued: number;
    blocked: number;
  };

  // Durations (seconds).
  const implementation_duration = computeDurationStats(
    `SELECT (${juld('a.completed_at')} - ${juld('a.started_at')}) * 86400.0 AS d
     FROM attempts a JOIN tasks t ON t.id = a.task_id
     WHERE a.role = 'develop'
       AND a.started_at IS NOT NULL AND a.completed_at IS NOT NULL
       AND ${cohort.clause}`,
    cohort.params
  );
  const review_duration = computeDurationStats(
    `SELECT (${juld('a.completed_at')} - ${juld('a.started_at')}) * 86400.0 AS d
     FROM attempts a JOIN tasks t ON t.id = a.task_id
     WHERE a.role = 'review'
       AND a.started_at IS NOT NULL AND a.completed_at IS NOT NULL
       AND ${cohort.clause}`,
    cohort.params
  );
  const lead_time = computeDurationStats(
    `SELECT (${juld('t.completed_at')} - ${juld('t.created_at')}) * 86400.0 AS d
     FROM tasks t
     WHERE t.status = 'merged' AND t.completed_at IS NOT NULL
       AND ${cohort.clause}`,
    cohort.params
  );

  // Rework: average develop-attempt count over cohort tasks that ran ≥1
  // develop attempt.
  const reworkRow = db
    .prepare(
      `SELECT AVG(cnt) AS avg, COUNT(*) AS task_count FROM (
         SELECT a.task_id, COUNT(*) AS cnt
         FROM attempts a JOIN tasks t ON t.id = a.task_id
         WHERE a.role = 'develop' AND ${cohort.clause}
         GROUP BY a.task_id
       )`
    )
    .get(...cohort.params) as { avg: number | null; task_count: number };

  return {
    range: { from: filter.from, to: filter.to },
    repos: filter.repos,
    status_counts,
    total_tasks,
    success_rate,
    terminal_counts,
    throughput: { tasks_created: total_tasks, tasks_merged: Number(tasksMerged) },
    backlog: {
      queued: Number(backlogRow.queued),
      blocked: Number(backlogRow.blocked),
    },
    implementation_duration,
    review_duration,
    lead_time,
    rework: {
      avg: numOrNull(reworkRow.avg),
      task_count: Number(reworkRow.task_count),
    },
  };
}

/** Per-bucket created/merged counts for `GET /api/reports/timeseries`.
 *  Buckets are zero-filled across the range so the chart has no gaps. */
export function getReportTimeseries(
  filter: ReportFilter,
  bucket: 'day' | 'week'
): ReportsTimeseries {
  const db = getDb();

  // Bucket key = the day, or the Monday of the ISO week. The week math
  // mirrors `weekStart` below: days-since-Monday = (dow + 6) % 7, where
  // dow is strftime('%w') (0=Sun … 6=Sat).
  const bucketExpr = (col: string): string => {
    const n = normTsSql(col);
    if (bucket === 'day') return `date(${n})`;
    return `date(${n}, '-' || ((CAST(strftime('%w', ${n}) AS INT) + 6) % 7) || ' days')`;
  };

  const createdRange = rangeClause('t.created_at', filter);
  const createdRows = db
    .prepare(
      `SELECT ${bucketExpr('t.created_at')} AS bucket, COUNT(*) AS c
       FROM tasks t WHERE ${createdRange.clause} GROUP BY bucket`
    )
    .all(...createdRange.params) as { bucket: string; c: number }[];

  const mergedRange = rangeClause('t.completed_at', filter);
  const mergedRows = db
    .prepare(
      `SELECT ${bucketExpr('t.completed_at')} AS bucket, COUNT(*) AS c
       FROM tasks t
       WHERE t.status = 'merged' AND t.completed_at IS NOT NULL
         AND ${mergedRange.clause}
       GROUP BY bucket`
    )
    .all(...mergedRange.params) as { bucket: string; c: number }[];

  const created = new Map(createdRows.map((r) => [r.bucket, Number(r.c)]));
  const merged = new Map(mergedRows.map((r) => [r.bucket, Number(r.c)]));

  const series: ReportsTimeseriesBucket[] = [];
  for (const b of enumerateBuckets(filter.from, filter.to, bucket)) {
    series.push({
      bucket: b,
      tasks_created: created.get(b) ?? 0,
      tasks_merged: merged.get(b) ?? 0,
    });
  }
  return { range: { from: filter.from, to: filter.to }, bucket, series };
}

/** YYYY-MM-DD of `d` in UTC. */
function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday (UTC) of the week containing `d`, as YYYY-MM-DD. Mirrors the SQL
 *  week-bucket expression in {@link getReportTimeseries}. */
function weekStart(d: Date): string {
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const daysSinceMon = (dow + 6) % 7;
  const m = new Date(d);
  m.setUTCDate(m.getUTCDate() - daysSinceMon);
  return ymdUtc(m);
}

/** Ordered, de-duplicated list of bucket keys covering [from, to). */
function enumerateBuckets(
  from: string,
  to: string,
  bucket: 'day' | 'week'
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const end = Date.parse(to);
  // Anchor on the UTC day so day/week keys line up with the SQL date()s.
  const cursor = new Date(`${normalizeTimestamp(from).slice(0, 10)}T00:00:00Z`);
  // Guard against pathological ranges (malformed bounds) producing a
  // runaway loop — cap at a generous bucket count.
  let guard = 0;
  while (cursor.getTime() < end && guard < 100000) {
    const key = bucket === 'day' ? ymdUtc(cursor) : weekStart(cursor);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard++;
  }
  return out;
}

/** Per-group leaderboard for `GET /api/reports/leaderboard`.
 *
 *  model/harness grouping keys off the per-attempt snapshots
 *  (attempts.model_id / .harness_id) so historical accuracy survives
 *  profile edits; a task touched by two models contributes to both. repo
 *  grouping keys off tasks.repo_id and counts every cohort task (even ones
 *  with no attempts yet). All three sub-queries are SQL aggregates; results
 *  are merged by key in JS (O(groups)). */
export function getReportLeaderboard(
  filter: ReportFilter,
  groupBy: LeaderboardGroupBy,
  profile?: { model: string; harness: string }
): ReportsLeaderboard {
  const db = getDb();
  const cohort = rangeClause('t.created_at', filter);

  const attemptGrouped = groupBy !== 'repo';

  // Optional (model, harness) narrowing used by the Create-Task profile gauge
  // (getReportProfileGauge). When set it constrains every attempt-derived
  // query to a single model+harness snapshot so the gauge reuses this exact
  // aggregation rather than duplicating the stats SQL. Only meaningful for the
  // attempt-grouped paths; the repo-grouped Query B/C branches ignore it (the
  // gauge always groups by model).
  const profileClause =
    profile && attemptGrouped ? ` AND a.model_id = ? AND a.harness_id = ?` : '';
  const profileParams: unknown[] =
    profile && attemptGrouped ? [profile.model, profile.harness] : [];
  const keyCol =
    groupBy === 'model'
      ? 'a.model_id'
      : groupBy === 'harness'
        ? 'a.harness_id'
        : 'CAST(t.repo_id AS TEXT)';
  const keyNotNull =
    groupBy === 'model'
      ? "a.model_id IS NOT NULL AND a.model_id != ''"
      : groupBy === 'harness'
        ? "a.harness_id IS NOT NULL AND a.harness_id != ''"
        : null;
  const andKey = keyNotNull ? ` AND ${keyNotNull}` : '';

  const dur = `(${juld('a.completed_at')} - ${juld('a.started_at')}) * 86400.0`;
  const durGuard =
    'a.started_at IS NOT NULL AND a.completed_at IS NOT NULL';

  // Query A — attempt-derived durations + effort metrics + review-verdict
  // distribution. AVG() skips NULL inputs in SQLite, so attempts that
  // reported no turns/tokens are excluded from the effort averages rather
  // than dragged toward 0. The token sums COALESCE per-row so a group with
  // no reported usage totals 0 (not NULL).
  const metricRows = db
    .prepare(
      `SELECT ${keyCol} AS key,
         AVG(CASE WHEN a.role = 'develop' AND ${durGuard} THEN ${dur} END) AS avg_impl,
         AVG(CASE WHEN a.role = 'review' AND ${durGuard} THEN ${dur} END) AS avg_review,
         AVG(a.num_turns) AS avg_turns,
         AVG(CASE
               WHEN a.input_tokens IS NOT NULL OR a.output_tokens IS NOT NULL
               THEN COALESCE(a.input_tokens, 0) + COALESCE(a.output_tokens, 0)
             END) AS avg_total_tokens,
         SUM(COALESCE(a.input_tokens, 0)) AS sum_input,
         SUM(COALESCE(a.output_tokens, 0)) AS sum_output,
         AVG(a.changed_files) AS avg_changed_files,
         AVG(a.additions) AS avg_additions,
         AVG(a.deletions) AS avg_deletions,
         AVG(CASE
               WHEN a.additions IS NOT NULL OR a.deletions IS NOT NULL
               THEN COALESCE(a.additions, 0) + COALESCE(a.deletions, 0)
             END) AS avg_total_churn,
         SUM(CASE WHEN a.role = 'review' AND a.verdict = 'approved' THEN 1 ELSE 0 END) AS v_approved,
         SUM(CASE WHEN a.role = 'review' AND a.verdict = 'changes_needed' THEN 1 ELSE 0 END) AS v_changes,
         SUM(CASE WHEN a.role = 'review' AND a.verdict = 'unclear' THEN 1 ELSE 0 END) AS v_unclear
       FROM attempts a JOIN tasks t ON t.id = a.task_id
       WHERE ${cohort.clause}${andKey}${profileClause}
       GROUP BY ${keyCol}`
    )
    .all(...cohort.params, ...profileParams) as Array<{
    key: string;
    avg_impl: number | null;
    avg_review: number | null;
    avg_turns: number | null;
    avg_total_tokens: number | null;
    sum_input: number;
    sum_output: number;
    avg_changed_files: number | null;
    avg_additions: number | null;
    avg_deletions: number | null;
    avg_total_churn: number | null;
    v_approved: number;
    v_changes: number;
    v_unclear: number;
  }>;

  // Query B — task counts + terminal breakdown per group.
  const taskRows = (
    attemptGrouped
      ? db
          .prepare(
            `SELECT key,
               COUNT(*) AS task_count,
               SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) AS merged,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
             FROM (
               SELECT DISTINCT ${keyCol} AS key, a.task_id, t.status
               FROM attempts a JOIN tasks t ON t.id = a.task_id
               WHERE ${cohort.clause}${andKey}${profileClause}
             )
             GROUP BY key`
          )
          .all(...cohort.params, ...profileParams)
      : db
          .prepare(
            `SELECT CAST(t.repo_id AS TEXT) AS key,
               COUNT(*) AS task_count,
               SUM(CASE WHEN t.status = 'merged' THEN 1 ELSE 0 END) AS merged,
               SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
             FROM tasks t
             WHERE ${cohort.clause}
             GROUP BY t.repo_id`
          )
          .all(...cohort.params)
  ) as Array<{
    key: string;
    task_count: number;
    merged: number;
    failed: number;
    cancelled: number;
  }>;

  // Query C — average develop-attempt count (rework) per group.
  const reworkRows = (
    attemptGrouped
      ? db
          .prepare(
            `SELECT key, AVG(cnt) AS avg_rework FROM (
               SELECT ${keyCol} AS key, a.task_id, COUNT(*) AS cnt
               FROM attempts a JOIN tasks t ON t.id = a.task_id
               WHERE a.role = 'develop' AND ${cohort.clause}${andKey}${profileClause}
               GROUP BY ${keyCol}, a.task_id
             ) GROUP BY key`
          )
          .all(...cohort.params, ...profileParams)
      : db
          .prepare(
            `SELECT key, AVG(cnt) AS avg_rework FROM (
               SELECT CAST(t.repo_id AS TEXT) AS key, a.task_id, COUNT(*) AS cnt
               FROM attempts a JOIN tasks t ON t.id = a.task_id
               WHERE a.role = 'develop' AND ${cohort.clause}
               GROUP BY t.repo_id, a.task_id
             ) GROUP BY key`
          )
          .all(...cohort.params)
  ) as Array<{ key: string; avg_rework: number | null }>;

  // Repo display labels.
  const repoLabels = new Map<string, string>();
  if (groupBy === 'repo') {
    for (const r of getRepos()) {
      repoLabels.set(String(r.id), `${r.owner}/${r.name}`);
    }
  }

  // Merge by key.
  const byKey = new Map<string, LeaderboardRow>();
  const ensure = (key: string): LeaderboardRow => {
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        label: groupBy === 'repo' ? repoLabels.get(key) ?? key : key,
        task_count: 0,
        success_rate: null,
        terminal_counts: { merged: 0, failed: 0, cancelled: 0 },
        avg_implementation_seconds: null,
        avg_review_seconds: null,
        avg_rework: null,
        avg_num_turns: null,
        avg_total_tokens: null,
        total_input_tokens: 0,
        total_output_tokens: 0,
        avg_changed_files: null,
        avg_additions: null,
        avg_deletions: null,
        avg_total_churn: null,
        verdicts: { approved: 0, changes_needed: 0, unclear: 0 },
      };
      byKey.set(key, row);
    }
    return row;
  };

  for (const m of metricRows) {
    const row = ensure(m.key);
    row.avg_implementation_seconds = numOrNull(m.avg_impl);
    row.avg_review_seconds = numOrNull(m.avg_review);
    row.avg_num_turns = numOrNull(m.avg_turns);
    row.avg_total_tokens = numOrNull(m.avg_total_tokens);
    row.total_input_tokens = Number(m.sum_input) || 0;
    row.total_output_tokens = Number(m.sum_output) || 0;
    row.avg_changed_files = numOrNull(m.avg_changed_files);
    row.avg_additions = numOrNull(m.avg_additions);
    row.avg_deletions = numOrNull(m.avg_deletions);
    row.avg_total_churn = numOrNull(m.avg_total_churn);
    row.verdicts = {
      approved: Number(m.v_approved),
      changes_needed: Number(m.v_changes),
      unclear: Number(m.v_unclear),
    };
  }
  for (const t of taskRows) {
    const row = ensure(t.key);
    row.task_count = Number(t.task_count);
    row.terminal_counts = {
      merged: Number(t.merged),
      failed: Number(t.failed),
      cancelled: Number(t.cancelled),
    };
    const terminal = row.terminal_counts.merged +
      row.terminal_counts.failed +
      row.terminal_counts.cancelled;
    row.success_rate = terminal > 0 ? row.terminal_counts.merged / terminal : null;
  }
  for (const r of reworkRows) {
    ensure(r.key).avg_rework = numOrNull(r.avg_rework);
  }

  const rows = [...byKey.values()].sort(
    (a, b) => b.task_count - a.task_count || a.key.localeCompare(b.key)
  );

  return { range: { from: filter.from, to: filter.to }, group_by: groupBy, rows };
}

/** Performance gauge for a single (repo, model, harness) combination, backing
 *  `GET /api/reports/profile-gauge`. Thin reuse of getReportLeaderboard: it
 *  groups by model with the (model, harness) narrowing applied, so the numbers
 *  are computed by the exact same SQL as the Reports leaderboard — no
 *  duplicated stats logic. `filter` should already be pinned to the single
 *  repo (filter.repos = [repoId]); the result reports `task_count` as the
 *  sample size and flags `insufficient_data` when it falls below
 *  GAUGE_MIN_SAMPLE so the UI never presents a misleading rate off a tiny or
 *  empty set. */
export function getReportProfileGauge(
  filter: ReportFilter,
  model: string,
  harness: string
): ProfileGauge {
  const board = getReportLeaderboard(filter, 'model', { model, harness });
  // With the harness constraint applied there is at most one model row.
  const row = board.rows.find((r) => r.key === model) ?? null;
  const repoId = filter.repos && filter.repos.length > 0 ? filter.repos[0] : 0;
  const taskCount = row?.task_count ?? 0;

  return {
    repo_id: repoId,
    model_id: model,
    harness_id: harness,
    range: { from: filter.from, to: filter.to },
    task_count: taskCount,
    insufficient_data: taskCount < GAUGE_MIN_SAMPLE,
    success_rate: row?.success_rate ?? null,
    terminal_counts: row?.terminal_counts ?? {
      merged: 0,
      failed: 0,
      cancelled: 0,
    },
    avg_rework: row?.avg_rework ?? null,
    avg_implementation_seconds: row?.avg_implementation_seconds ?? null,
    avg_num_turns: row?.avg_num_turns ?? null,
    avg_total_tokens: row?.avg_total_tokens ?? null,
  };
}

// ---------------------------------------------------------------------------
// Advanced reports: duration distribution / funnel / reliability / heatmap
// ---------------------------------------------------------------------------

/** Per-group duration distribution for `GET /api/reports/durations`.
 *
 *  Returns nearest-rank p50/p90/p99 plus min/max/avg/count over the
 *  implementation (develop-role) or review (review-role) attempt durations,
 *  grouped by the per-attempt model/harness snapshot. Like the leaderboard,
 *  grouping keys off attempts.* so historical accuracy survives profile
 *  edits, and an attempt with a NULL/empty snapshot is excluded. All
 *  aggregation runs in one SQL pass (window functions partitioned by key). */
export function getReportDurations(
  filter: ReportFilter,
  groupBy: DurationGroupBy,
  metric: DurationMetric
): ReportsDurations {
  const db = getDb();
  const cohort = rangeClause('t.created_at', filter);

  const keyCol = groupBy === 'model' ? 'a.model_id' : 'a.harness_id';
  const keyNotNull = `${keyCol} IS NOT NULL AND ${keyCol} != ''`;
  const role = metric === 'implementation' ? 'develop' : 'review';
  const dur = `(${juld('a.completed_at')} - ${juld('a.started_at')}) * 86400.0`;

  const rows = db
    .prepare(
      `WITH vals AS (
         SELECT ${keyCol} AS key, ${dur} AS d
         FROM attempts a JOIN tasks t ON t.id = a.task_id
         WHERE a.role = '${role}'
           AND a.started_at IS NOT NULL AND a.completed_at IS NOT NULL
           AND ${keyNotNull}
           AND ${cohort.clause}
       ),
       ordered AS (
         SELECT key, d,
           ROW_NUMBER() OVER (PARTITION BY key ORDER BY d) AS rn,
           COUNT(*) OVER (PARTITION BY key) AS n
         FROM vals
       )
       SELECT key,
         COUNT(*) AS count,
         MIN(d) AS min_d,
         MAX(d) AS max_d,
         AVG(d) AS avg_d,
         MAX(CASE WHEN rn = ${nearestRank(0.5)} THEN d END) AS p50,
         MAX(CASE WHEN rn = ${nearestRank(0.9)} THEN d END) AS p90,
         MAX(CASE WHEN rn = ${nearestRank(0.99)} THEN d END) AS p99
       FROM ordered
       GROUP BY key`
    )
    .all(...cohort.params) as Array<{
    key: string;
    count: number;
    min_d: number | null;
    max_d: number | null;
    avg_d: number | null;
    p50: number | null;
    p90: number | null;
    p99: number | null;
  }>;

  const groups: DurationDistribution[] = rows
    .map((r) => ({
      key: r.key,
      label: r.key,
      count: Number(r.count),
      min_seconds: numOrNull(r.min_d),
      p50_seconds: numOrNull(r.p50),
      p90_seconds: numOrNull(r.p90),
      p99_seconds: numOrNull(r.p99),
      max_seconds: numOrNull(r.max_d),
      avg_seconds: numOrNull(r.avg_d),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    range: { from: filter.from, to: filter.to },
    group_by: groupBy,
    metric,
    groups,
  };
}

/** Lifecycle funnel for `GET /api/reports/funnel`.
 *
 *  Stages: created → preparing → in-progress → in-review → merged. "Created"
 *  is the cohort of tasks created in [from, to) (optionally repo-narrowed);
 *  every later stage counts the DISTINCT cohort tasks that ever emitted the
 *  matching `status_*` timeline event (written by updateTaskWithSync on every
 *  status transition — see state-sync.ts). Counting "ever reached" makes the
 *  funnel a true high-water-mark of progression and drop-off, surviving
 *  rework loops (a task that bounced in-review→changes-needed→in-progress
 *  still counts at every stage it touched). */
export function getReportFunnel(filter: ReportFilter): ReportsFunnel {
  const db = getDb();
  const cohort = rangeClause('t.created_at', filter);

  const created = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM tasks t WHERE ${cohort.clause}`)
      .get(...cohort.params) as { c: number }
  ).c;

  // DISTINCT cohort tasks that emitted each status_* event. One grouped pass
  // over the events joined to the cohort.
  const eventRows = db
    .prepare(
      `SELECT e.event_type AS event_type, COUNT(DISTINCT e.task_id) AS c
       FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.event_type IN ('status_preparing', 'status_in-progress', 'status_in-review', 'status_merged')
         AND ${cohort.clause}
       GROUP BY e.event_type`
    )
    .all(...cohort.params) as Array<{ event_type: string; c: number }>;
  const byEvent = new Map(eventRows.map((r) => [r.event_type, Number(r.c)]));

  const stageDefs: Array<{ stage: string; label: string; count: number }> = [
    { stage: 'created', label: 'Created', count: Number(created) },
    { stage: 'preparing', label: 'Preparing', count: byEvent.get('status_preparing') ?? 0 },
    { stage: 'in-progress', label: 'In progress', count: byEvent.get('status_in-progress') ?? 0 },
    { stage: 'in-review', label: 'In review', count: byEvent.get('status_in-review') ?? 0 },
    { stage: 'merged', label: 'Merged', count: byEvent.get('status_merged') ?? 0 },
  ];

  const first = stageDefs[0].count;
  const stages: FunnelStage[] = stageDefs.map((s, i) => {
    const prev = i > 0 ? stageDefs[i - 1].count : null;
    return {
      stage: s.stage,
      label: s.label,
      count: s.count,
      pct_of_created: first > 0 ? s.count / first : null,
      pct_of_previous: prev != null ? (prev > 0 ? s.count / prev : null) : null,
    };
  });

  return { range: { from: filter.from, to: filter.to }, repos: filter.repos, stages };
}

/** The reliability event types surfaced by the ops panel, mapped to the
 *  response field they populate. */
const RELIABILITY_EVENTS: Array<{
  event_type: string;
  field: keyof Omit<ReliabilityCounts, 'prep_failures'>;
}> = [
  { event_type: 'container_timeout_kill', field: 'timeout_kills' },
  { event_type: 'orphan_detected', field: 'orphans_detected' },
  { event_type: 'orphan_recovery_triggered', field: 'orphans_recovered' },
  { event_type: 'orphan_recovery_exhausted', field: 'orphans_exhausted' },
  { event_type: 'review_deferred', field: 'review_deferrals' },
];

/** Operational-health roll-up for `GET /api/reports/reliability`.
 *
 *  The event-driven incidences (timeout-kills, orphan detect/recover/exhaust,
 *  review deferrals) are scoped by the EVENT's created_at falling in the
 *  range (the incident happened in-window) and the owning task's repo. Prep
 *  failures are a point-in-time per-task counter (tasks.prep_failure_count),
 *  so they're summed over the created-in-range cohort and reported in the
 *  totals + per-repo breakdown only — not the time-series.
 *
 *  Since v31 that counter charges an outage-shaped git failure once per
 *  outage WINDOW rather than once per retry, so this roll-up counts
 *  "distinct prep incidents" and no longer inflates by however many times
 *  the scheduler re-tried during a single git-host outage. Every individual
 *  attempt is still recorded as a `prep_failed` task_event if you need the
 *  raw retry history. */
export function getReportReliability(
  filter: ReportFilter,
  bucket: 'day' | 'week'
): ReportsReliability {
  const db = getDb();
  const eventRange = rangeClause('e.created_at', filter);

  const eventTypes = RELIABILITY_EVENTS.map((e) => e.event_type);
  const placeholders = eventTypes.map(() => '?').join(',');

  // -- Totals + per-repo, one grouped pass over the in-range events. --
  const rows = db
    .prepare(
      `SELECT e.event_type AS event_type, t.repo_id AS repo_id, COUNT(*) AS c
       FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.event_type IN (${placeholders})
         AND ${eventRange.clause}
       GROUP BY e.event_type, t.repo_id`
    )
    .all(...eventTypes, ...eventRange.params) as Array<{
    event_type: string;
    repo_id: number;
    c: number;
  }>;

  const fieldFor = new Map(
    RELIABILITY_EVENTS.map((e) => [e.event_type, e.field] as const)
  );

  const counts: ReliabilityCounts = {
    timeout_kills: 0,
    orphans_detected: 0,
    orphans_recovered: 0,
    orphans_exhausted: 0,
    review_deferrals: 0,
    prep_failures: 0,
  };
  const byRepo = new Map<number, ReliabilityRepoRow>();
  const ensureRepo = (id: number): ReliabilityRepoRow => {
    let row = byRepo.get(id);
    if (!row) {
      row = {
        key: String(id),
        label: String(id),
        timeout_kills: 0,
        orphans_detected: 0,
        orphans_recovered: 0,
        orphans_exhausted: 0,
        review_deferrals: 0,
        prep_failures: 0,
      };
      byRepo.set(id, row);
    }
    return row;
  };

  for (const r of rows) {
    const field = fieldFor.get(r.event_type);
    if (!field) continue;
    counts[field] += Number(r.c);
    ensureRepo(r.repo_id)[field] += Number(r.c);
  }

  // -- Prep failures: sum the per-task counter over the created-in-range
  //    cohort, both as a total and per repo. --
  const cohort = rangeClause('t.created_at', filter);
  const prepRows = db
    .prepare(
      `SELECT t.repo_id AS repo_id, SUM(t.prep_failure_count) AS c
       FROM tasks t
       WHERE t.prep_failure_count > 0 AND ${cohort.clause}
       GROUP BY t.repo_id`
    )
    .all(...cohort.params) as Array<{ repo_id: number; c: number }>;
  for (const r of prepRows) {
    const n = Number(r.c) || 0;
    counts.prep_failures += n;
    ensureRepo(r.repo_id).prep_failures += n;
  }

  // -- Time-series of the event incidences (prep failures omitted). --
  const bucketExpr = (col: string): string => {
    const n = normTsSql(col);
    if (bucket === 'day') return `date(${n})`;
    return `date(${n}, '-' || ((CAST(strftime('%w', ${n}) AS INT) + 6) % 7) || ' days')`;
  };
  const seriesRows = db
    .prepare(
      `SELECT ${bucketExpr('e.created_at')} AS bucket, e.event_type AS event_type, COUNT(*) AS c
       FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE e.event_type IN (${placeholders})
         AND ${eventRange.clause}
       GROUP BY bucket, e.event_type`
    )
    .all(...eventTypes, ...eventRange.params) as Array<{
    bucket: string;
    event_type: string;
    c: number;
  }>;

  const seriesByBucket = new Map<string, ReliabilityTimeseriesBucket>();
  for (const b of enumerateBuckets(filter.from, filter.to, bucket)) {
    seriesByBucket.set(b, {
      bucket: b,
      timeout_kills: 0,
      orphans_detected: 0,
      orphans_recovered: 0,
      orphans_exhausted: 0,
      review_deferrals: 0,
    });
  }
  for (const r of seriesRows) {
    const slot = seriesByBucket.get(r.bucket);
    const field = fieldFor.get(r.event_type);
    if (!slot || !field) continue;
    slot[field] += Number(r.c);
  }

  // Repo labels.
  for (const repo of getRepos()) {
    const row = byRepo.get(repo.id);
    if (row) row.label = `${repo.owner}/${repo.name}`;
  }

  const by_repo = [...byRepo.values()].sort((a, b) => {
    const ta =
      a.timeout_kills + a.orphans_detected + a.orphans_recovered +
      a.orphans_exhausted + a.review_deferrals + a.prep_failures;
    const tb =
      b.timeout_kills + b.orphans_detected + b.orphans_recovered +
      b.orphans_exhausted + b.review_deferrals + b.prep_failures;
    return tb - ta || a.key.localeCompare(b.key);
  });

  return {
    range: { from: filter.from, to: filter.to },
    repos: filter.repos,
    bucket,
    counts,
    series: [...seriesByBucket.values()],
    by_repo,
  };
}

/** Activity heatmap for `GET /api/reports/heatmap`. Buckets task launches
 *  (created_at) or merges (completed_at of merged tasks) by UTC hour-of-day
 *  × day-of-week. Returns only non-zero cells plus the max for the UI's
 *  colour scale; the client fills the rest of the 7×24 grid with zero. */
export function getReportHeatmap(
  filter: ReportFilter,
  metric: HeatmapMetric
): ReportsHeatmap {
  const db = getDb();

  let col: string;
  let extra = '';
  if (metric === 'merged') {
    col = 't.completed_at';
    extra = " AND t.status = 'merged' AND t.completed_at IS NOT NULL";
  } else {
    col = 't.created_at';
  }
  const range = rangeClause(col, filter);
  const n = normTsSql(col);

  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', ${n}) AS INT) AS dow,
              CAST(strftime('%H', ${n}) AS INT) AS hour,
              COUNT(*) AS c
       FROM tasks t
       WHERE ${range.clause}${extra}
       GROUP BY dow, hour`
    )
    .all(...range.params) as Array<{ dow: number; hour: number; c: number }>;

  let max = 0;
  const cells: HeatmapCell[] = rows.map((r) => {
    const count = Number(r.c);
    if (count > max) max = count;
    return { dow: Number(r.dow), hour: Number(r.hour), count };
  });

  return { range: { from: filter.from, to: filter.to }, metric, cells, max };
}

/** Pagination + filtering options for {@link getReportTasks}. */
export interface ReportTasksOptions {
  /** Narrow to a single stored task status. */
  status?: TaskStatus;
  /** Free-text match against the issue number or issue title. A leading
   *  '#' is stripped so "#42" and "42" behave the same. */
  search?: string;
  /** Sort order; defaults to most-recent-created first. */
  sort?: ReportTasksSort;
  /** Zero-based row offset (clamped to ≥ 0). */
  offset?: number;
  /** Page size (clamped to [1, MAX_REPORT_TASKS_LIMIT]). */
  limit?: number;
}

/** A task row plus the model/harness snapshot from its most recent attempt
 *  and its develop-attempt count. Returned by {@link getReportTasks}; the
 *  route overlays the Forgejo-derived status for the page. */
export interface ReportTaskDbRow extends Task {
  /** Develop-attempt count (implementation passes run). */
  attempts: number;
  /** model_id snapshot of the latest develop attempt (null = none ran). */
  model_id: string | null;
  /** harness_id snapshot of the latest develop attempt (null = none ran). */
  harness_id: string | null;
}

const MAX_REPORT_TASKS_LIMIT = 200;
const DEFAULT_REPORT_TASKS_LIMIT = 25;

/** Paginated task history for the Reports "All Tasks" browser.
 *
 *  Filtering, sorting, and pagination all run in SQL — the route never loads
 *  the whole history into memory. Returns the requested page plus the TOTAL
 *  count matching the filter (ignoring offset/limit) so the UI can render
 *  "showing X of N" and page. The model/harness columns come from the task's
 *  most recent attempt via correlated subqueries (no per-row round-trip), and
 *  develop attempts are counted in the same pass.
 *
 *  The cohort is tasks CREATED within [from, to) (optionally narrowed to
 *  `repos`), mirroring the other report endpoints. Forgejo-derived status is
 *  NOT resolved here — that is the route's job, and only for the page. */
export function getReportTasks(
  filter: ReportFilter,
  opts: ReportTasksOptions = {}
): { total: number; offset: number; limit: number; tasks: ReportTaskDbRow[] } {
  const db = getDb();

  const range = rangeClause('t.created_at', filter);
  const conditions = [range.clause];
  const params: unknown[] = [...range.params];

  if (opts.status) {
    conditions.push('t.status = ?');
    params.push(opts.status);
  }

  const search = opts.search?.trim().replace(/^#/, '') ?? '';
  if (search !== '') {
    conditions.push(
      `(CAST(t.issue_id AS TEXT) LIKE ? OR t.issue_title LIKE ?)`
    );
    const like = `%${search}%`;
    params.push(like, like);
  }

  const where = conditions.join(' AND ');

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM tasks t WHERE ${where}`)
      .get(...params) as { c: number }
  ).c;

  // Sort. created_at is always present; completed_at may be null, so push
  // null completions to the bottom regardless of direction. julianday()
  // normalization keeps the order correct across the two stored timestamp
  // formats.
  const created = juld('t.created_at');
  const completed = juld('t.completed_at');
  const completedNullsLast = '(t.completed_at IS NULL) ASC';
  let orderBy: string;
  switch (opts.sort) {
    case 'created_asc':
      orderBy = `${created} ASC, t.id ASC`;
      break;
    case 'completed_desc':
      orderBy = `${completedNullsLast}, ${completed} DESC, t.id DESC`;
      break;
    case 'completed_asc':
      orderBy = `${completedNullsLast}, ${completed} ASC, t.id ASC`;
      break;
    case 'created_desc':
    default:
      orderBy = `${created} DESC, t.id DESC`;
      break;
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? DEFAULT_REPORT_TASKS_LIMIT)),
    MAX_REPORT_TASKS_LIMIT
  );
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));

  // The model/harness subqueries prefer the latest DEVELOP attempt (the
  // implementation that ran), falling back to any attempt with a snapshot.
  const pickAttempt = (col: 'model_id' | 'harness_id'): string =>
    `(SELECT a.${col} FROM attempts a
        WHERE a.task_id = t.id AND a.${col} IS NOT NULL AND a.${col} != ''
        ORDER BY (a.role = 'develop') DESC, a.attempt_number DESC, a.id DESC
        LIMIT 1)`;

  const tasks = db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(*) FROM attempts a
            WHERE a.task_id = t.id AND a.role = 'develop') AS attempts,
         ${pickAttempt('model_id')} AS model_id,
         ${pickAttempt('harness_id')} AS harness_id
       FROM tasks t
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as ReportTaskDbRow[];

  return { total, offset, limit, tasks };
}

// ---------------------------------------------------------------------------
// Attempts export (raw, flat rows)
// ---------------------------------------------------------------------------
//
// The counterpart to the getReport* aggregations above: instead of rolling
// the history up, ship it. One denormalised row per attempt, joined to its
// task, repo and (where resolvable) model, for external analysis tooling —
// `GET /api/export/attempts` today, an MCP read tool later. Deliberately
// free of Fastify types so any caller can use it.
//
// Three properties this owes its consumers:
//   * NO DEFAULT WINDOW — null from/to means all history (unlike the report
//     endpoints, which fall back to DEFAULT_REPORT_WINDOW_DAYS).
//   * NULL STAYS NULL — an unknown token count is null, never 0 (see the
//     usage-column note on the attempts schema).
//   * NO DERIVED COST — raw token counts only, same as everywhere else.

/** Options for {@link getAttemptsExport} / {@link iterateAttemptsExport}. */
export interface AttemptsExportOptions {
  /** Include the review `feedback` blob. Off by default: it is a full
   *  review document per row and would dominate the payload. */
  includeFeedback?: boolean;
  /** Rows fetched per underlying query while streaming (test seam). */
  batchSize?: number;
}

/** Rows pulled per query while streaming. Bounds peak memory to this many
 *  rows regardless of history size, and — the reason it isn't a single
 *  `stmt.iterate()` — keeps the better-sqlite3 connection unlocked between
 *  batches. An open iterator marks the connection busy for its whole
 *  lifetime, so a slow HTTP consumer would make every concurrent WRITE
 *  (scheduler tick, webhook, event log) throw "database connection is
 *  busy". Batching yields flat memory without holding that lock. */
const EXPORT_BATCH_ROWS = 500;

/** Raw SELECT shape, before timestamp normalisation / duration derivation. */
type RawExportRow = Omit<
  ExportAttemptRow,
  'duration_seconds' | 'feedback'
> & { feedback?: string | null };

/** Build the single JOINed statement behind the export. Paged by keyset on
 *  `a.id` (`a.id > ?` + LIMIT, appended last), so the same prepared
 *  statement serves every batch. */
function buildAttemptsExportSql(
  filter: ExportAttemptsFilter,
  includeFeedback: boolean
): { sql: string; params: unknown[] } {
  // Time filter runs on the attempt's own start, falling back to the task's
  // creation for an attempt that never started — an attempt export should
  // window on when the attempt happened, not when its task was filed (which
  // is what the report cohorts use).
  const range = rangeClause('COALESCE(a.started_at, t.created_at)', filter);
  const conditions = [range.clause];
  const params: unknown[] = [...range.params];

  if (filter.model) {
    conditions.push('a.model_id = ?');
    params.push(filter.model);
  }
  if (filter.harness) {
    conditions.push('a.harness_id = ?');
    params.push(filter.harness);
  }
  if (filter.role) {
    conditions.push('a.role = ?');
    params.push(filter.role);
  }
  if (filter.status) {
    conditions.push('a.status = ?');
    params.push(filter.status);
  }

  // Model resolution. attempts.model_id is a launch-time SNAPSHOT of the
  // string handed to the harness, not an FK — some harnesses prefix it with
  // a provider ("openai/qwen…"), and the model row may since have been
  // renamed or deleted. So we resolve it best-effort and leave the columns
  // null when it doesn't match: first via an agent_profile with the same
  // harness (which disambiguates one model_id configured under several
  // providers), then via any model row with that id. ROW_NUMBER() keeps
  // both lookups single-valued, so neither join can multiply attempt rows.
  const sql = `
    WITH model_by_harness AS (
      SELECT m.model_id AS model_id, ap.harness_id AS harness_id,
             m.provider_id AS provider_id, m.display_name AS display_name,
             ROW_NUMBER() OVER (
               PARTITION BY m.model_id, ap.harness_id ORDER BY m.id
             ) AS rn
      FROM models m JOIN agent_profiles ap ON ap.model_pk = m.id
    ),
    model_any AS (
      SELECT model_id, provider_id, display_name,
             ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY id) AS rn
      FROM models
    )
    SELECT
      a.id AS attempt_id,
      a.task_id AS task_id,
      a.attempt_number AS attempt_number,
      a.role AS role,
      a.status AS status,
      a.started_at AS started_at,
      a.completed_at AS completed_at,
      a.model_id AS model_id,
      a.harness_id AS harness_id,
      a.timeout_minutes_snapshot AS timeout_minutes_snapshot,
      a.verdict AS verdict,
      a.num_turns AS num_turns,
      a.input_tokens AS input_tokens,
      a.output_tokens AS output_tokens,
      a.tool_calls AS tool_calls,
      a.changed_files AS changed_files,
      a.additions AS additions,
      a.deletions AS deletions,
      a.exit_code AS exit_code,
      a.error_message AS error_message,
      t.issue_id AS issue_id,
      t.issue_title AS issue_title,
      t.status AS task_status,
      t.attempt AS task_attempt,
      t.max_attempts AS max_attempts,
      t.pr_number AS pr_number,
      t.branch_name AS branch_name,
      t.created_at AS task_created_at,
      t.started_at AS task_started_at,
      t.completed_at AS task_completed_at,
      t.repo_id AS repo_id,
      r.owner AS repo_owner,
      r.name AS repo_name,
      COALESCE(mh.provider_id, ma.provider_id) AS provider_id,
      COALESCE(mh.display_name, ma.display_name) AS model_display_name${
        includeFeedback ? ',\n      a.feedback AS feedback' : ''
      }
    FROM attempts a
    JOIN tasks t ON t.id = a.task_id
    LEFT JOIN repos r ON r.id = t.repo_id
    LEFT JOIN model_by_harness mh
      ON mh.model_id = a.model_id AND mh.harness_id = a.harness_id AND mh.rn = 1
    LEFT JOIN model_any ma
      ON ma.model_id = a.model_id AND ma.rn = 1
    WHERE ${conditions.join(' AND ')}
      AND a.id > ?
    ORDER BY a.id ASC
    LIMIT ?`;

  return { sql, params };
}

/** Post-process one raw row: normalise the two on-disk timestamp shapes to
 *  canonical ISO-8601 UTC, derive the duration, and coerce numerics without
 *  ever turning a NULL into a 0. */
function mapExportRow(raw: RawExportRow, includeFeedback: boolean): ExportAttemptRow {
  const started_at = raw.started_at ? normalizeTimestamp(raw.started_at) : null;
  const completed_at = raw.completed_at
    ? normalizeTimestamp(raw.completed_at)
    : null;
  const row: ExportAttemptRow = {
    attempt_id: Number(raw.attempt_id),
    task_id: Number(raw.task_id),
    attempt_number: numOrNull(raw.attempt_number),
    role: raw.role,
    status: raw.status,
    started_at,
    completed_at,
    duration_seconds:
      raw.started_at && raw.completed_at
        ? durationSeconds(raw.started_at, raw.completed_at)
        : null,
    model_id: raw.model_id,
    harness_id: raw.harness_id,
    timeout_minutes_snapshot: numOrNull(raw.timeout_minutes_snapshot),
    verdict: raw.verdict,
    num_turns: numOrNull(raw.num_turns),
    input_tokens: numOrNull(raw.input_tokens),
    output_tokens: numOrNull(raw.output_tokens),
    tool_calls: numOrNull(raw.tool_calls),
    changed_files: numOrNull(raw.changed_files),
    additions: numOrNull(raw.additions),
    deletions: numOrNull(raw.deletions),
    exit_code: numOrNull(raw.exit_code),
    error_message: raw.error_message,
    issue_id: Number(raw.issue_id),
    issue_title: raw.issue_title,
    task_status: raw.task_status,
    task_attempt: numOrNull(raw.task_attempt),
    max_attempts: numOrNull(raw.max_attempts),
    pr_number: numOrNull(raw.pr_number),
    branch_name: raw.branch_name,
    task_created_at: raw.task_created_at
      ? normalizeTimestamp(raw.task_created_at)
      : null,
    task_started_at: raw.task_started_at
      ? normalizeTimestamp(raw.task_started_at)
      : null,
    task_completed_at: raw.task_completed_at
      ? normalizeTimestamp(raw.task_completed_at)
      : null,
    repo_id: Number(raw.repo_id),
    repo_owner: raw.repo_owner,
    repo_name: raw.repo_name,
    provider_id: raw.provider_id,
    model_display_name: raw.model_display_name,
  };
  // Absent, not null, when the caller didn't opt in — the field's presence
  // is itself part of the contract.
  if (includeFeedback) row.feedback = raw.feedback ?? null;
  return row;
}

/** Stream the filtered attempt history in `attempt_id` order, one row at a
 *  time, without materialising it. Pulls {@link EXPORT_BATCH_ROWS} rows per
 *  query, so peak memory is flat in history size.
 *
 *  Paging across separate queries means the result is not a point-in-time
 *  snapshot: an attempt inserted while a long export streams may land in a
 *  later batch. Attempt ids are append-only and monotonic, so that is the
 *  full extent of it — no row is ever duplicated or skipped. */
export function* iterateAttemptsExport(
  filter: ExportAttemptsFilter,
  opts: AttemptsExportOptions = {}
): Generator<ExportAttemptRow> {
  const includeFeedback = opts.includeFeedback === true;
  const { sql, params } = buildAttemptsExportSql(filter, includeFeedback);
  const stmt = getDb().prepare(sql);
  const batchSize = Math.max(1, Math.trunc(opts.batchSize ?? EXPORT_BATCH_ROWS));

  let afterId = 0;
  for (;;) {
    const rows = stmt.all(...params, afterId, batchSize) as RawExportRow[];
    for (const raw of rows) yield mapExportRow(raw, includeFeedback);
    if (rows.length < batchSize) return;
    afterId = Number(rows[rows.length - 1].attempt_id);
  }
}

/** Materialised form of {@link iterateAttemptsExport}, for callers that want
 *  the whole result set in hand (`format=json`, and the planned MCP tool). */
export function getAttemptsExport(
  filter: ExportAttemptsFilter,
  opts: AttemptsExportOptions = {}
): ExportAttemptRow[] {
  return Array.from(iterateAttemptsExport(filter, opts));
}
