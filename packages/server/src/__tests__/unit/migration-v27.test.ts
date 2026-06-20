import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** Exercises the v26 → v27 forward-migration block, which rebuilds the
 *  `tasks` table to swap the global UNIQUE(issue_id) for the repo-scoped
 *  UNIQUE(repo_id, issue_id). Forgejo numbers issues per-repo, so the old
 *  global constraint made two repos' identically-numbered issues collide.
 *
 *  The rebuild is a full table swap (create-new / copy / drop / rename) run
 *  with foreign_keys OFF so it doesn't cascade-delete the child
 *  attempts/events/steps/dependencies. These tests pin a populated DB back
 *  to the v26 shape, reboot, and assert: every row + child survives, the
 *  constraint flipped, and two repos can now share an issue number. */

/** Recreate the pre-v27 `tasks` table (global UNIQUE(issue_id)) in place of
 *  the fresh repo-scoped one, so a fresh install can stand in for a v26 DB.
 *  The fresh table is empty at this point, so the FK-off drop loses nothing. */
function rollbackTasksToV26(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TABLE tasks;
    CREATE TABLE tasks (
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
      UNIQUE(issue_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_repo_id ON tasks(repo_id);
  `);
  db.pragma('foreign_keys = ON');
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '26')"
  ).run();
}

function tasksTableSql(db: Database.Database): string {
  return (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
      )
      .get() as { sql: string }
  ).sql;
}

describe('v27 repo-scoped tasks uniqueness migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install carries UNIQUE(repo_id, issue_id), not UNIQUE(issue_id)', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v27-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v27-fresh.db'));

    const sql = tasksTableSql(db);
    expect(sql).toMatch(/UNIQUE\s*\(\s*repo_id\s*,\s*issue_id\s*\)/i);
    expect(sql).not.toMatch(/UNIQUE\s*\(\s*issue_id\s*\)/i);

    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('30');

    db.close();
  });

  it('upgrades a populated v26 DB, preserving all rows, statuses, and child FKs', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v27-up-'));
    const dbFile = path.join(tmpDir, 'v27-up.db');

    // Phase 1: fresh install, then roll `tasks` back to the v26 shape and
    // populate it the way a real pre-v27 install would have — distinct
    // issue numbers (the old global constraint forbade overlap) across two
    // repos, plus child attempt/event rows that the rebuild must not drop.
    let db = initDatabase(dbFile);
    rollbackTasksToV26(db);

    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r1')`).run();
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'o', 'r2')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status, attempt, max_attempts, branch_name, created_at)
       VALUES (1, 10, 1, 'merged', 3, 5, 'agent/issue-10-x', '2025-01-01 00:00:00')`
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (2, 20, 2, 'queued')`
    ).run();
    db.prepare(
      `INSERT INTO attempts (id, task_id, role, status) VALUES (1, 1, 'implement', 'completed')`
    ).run();
    db.prepare(
      `INSERT INTO task_events (id, task_id, event_type, message) VALUES (1, 1, 'created', 'hi')`
    ).run();
    db.close();

    // Phase 2: reboot. The v27 block rebuilds `tasks` with the repo-scoped
    // constraint.
    db = initDatabase(dbFile);

    // Constraint flipped.
    expect(tasksTableSql(db)).toMatch(
      /UNIQUE\s*\(\s*repo_id\s*,\s*issue_id\s*\)/i
    );

    // Every task row survived verbatim, defaults/timestamps intact.
    const t1 = db.prepare('SELECT * FROM tasks WHERE id = 1').get() as {
      issue_id: number;
      repo_id: number;
      status: string;
      attempt: number;
      max_attempts: number;
      branch_name: string;
      created_at: string;
    };
    expect(t1).toMatchObject({
      issue_id: 10,
      repo_id: 1,
      status: 'merged',
      attempt: 3,
      max_attempts: 5,
      branch_name: 'agent/issue-10-x',
      created_at: '2025-01-01 00:00:00',
    });
    const t2 = db.prepare('SELECT * FROM tasks WHERE id = 2').get() as {
      issue_id: number;
      repo_id: number;
      status: string;
    };
    expect(t2).toMatchObject({ issue_id: 20, repo_id: 2, status: 'queued' });

    // Children still point at their tasks — the FK-off rebuild preserved them.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n
    ).toBe(1);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as {
          n: number;
        }
      ).n
    ).toBe(1);
    // FK enforcement is back on and the references are valid.
    expect(db.pragma('foreign_key_check')).toEqual([]);

    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('30');

    db.close();
  });

  it('lets two repos hold the same issue number after the upgrade (regression)', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v27-collision-'));
    const dbFile = path.join(tmpDir, 'v27-collision.db');

    let db = initDatabase(dbFile);
    rollbackTasksToV26(db);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r1')`).run();
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'o', 'r2')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 5, 1, 'queued')`
    ).run();
    db.close();

    db = initDatabase(dbFile);

    // The same issue number under a different repo no longer collides.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (issue_id, repo_id, status) VALUES (5, 2, 'queued')`
        )
        .run()
    ).not.toThrow();

    // But a true duplicate (repo_id, issue_id) is still rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (issue_id, repo_id, status) VALUES (5, 1, 'queued')`
        )
        .run()
    ).toThrow(/UNIQUE/);

    db.close();
  });

  it('rolls a pre-v25 install (missing review_agent_profile_id) all the way to v27', () => {
    // The v27 rebuild runs BEFORE the v25 column-add in the shared
    // migration. A pre-v25 source `tasks` table has no
    // review_agent_profile_id, so the rebuild must copy only the columns it
    // finds — never SELECT a not-yet-existing column.
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v27-pre25-'));
    const dbFile = path.join(tmpDir, 'v27-pre25.db');

    let db = initDatabase(dbFile);
    rollbackTasksToV26(db);
    // Drop the v25 column to simulate a v22-era tasks table, then pin to v22.
    db.pragma('foreign_keys = OFF');
    db.exec('ALTER TABLE tasks DROP COLUMN review_agent_profile_id');
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 8, 1, 'merged')`
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '22')"
    ).run();
    db.close();

    db = initDatabase(dbFile);

    // Rebuilt with the repo-scoped constraint AND the v25 column present.
    expect(tasksTableSql(db)).toMatch(
      /UNIQUE\s*\(\s*repo_id\s*,\s*issue_id\s*\)/i
    );
    const cols = (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('review_agent_profile_id');

    const t = db.prepare('SELECT * FROM tasks WHERE id = 1').get() as {
      issue_id: number;
      status: string;
      review_agent_profile_id: string | null;
    };
    expect(t).toMatchObject({
      issue_id: 8,
      status: 'merged',
      review_agent_profile_id: null,
    });

    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('30');

    db.close();
  });

  it('is idempotent — a DB already at the repo-scoped shape is left untouched', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v27-idem-'));
    const dbFile = path.join(tmpDir, 'v27-idem.db');

    // Fresh install is already repo-scoped. Pin the version back to 26
    // WITHOUT rolling the table shape back; the rebuild must detect the
    // constraint is already correct and skip the swap (preserving rows).
    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 9, 1, 'queued')`
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '26')"
    ).run();
    db.close();

    db = initDatabase(dbFile);

    expect(tasksTableSql(db)).toMatch(
      /UNIQUE\s*\(\s*repo_id\s*,\s*issue_id\s*\)/i
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n
    ).toBe(1);
    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('30');

    db.close();
  });
});
