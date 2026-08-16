import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v31 adds the git-outage resilience state to the tasks table:
 *    prep_backoff_level, prep_next_attempt_at,
 *    salvage_backoff_level, salvage_next_attempt_at
 *  The two levels are NOT NULL DEFAULT 0 (existing rows backfill to "no
 *  outage in progress"); the two timestamps are nullable, where NULL means
 *  "runnable now" / "nothing deferred". */

const OUTAGE_COLUMNS = [
  'prep_backoff_level',
  'prep_next_attempt_at',
  'salvage_backoff_level',
  'salvage_next_attempt_at',
];

function taskColumns(db: Database.Database): Set<string> {
  return new Set(
    (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((c) => c.name)
  );
}

function schemaVersion(db: Database.Database): string {
  return (
    db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string }
  ).value;
}

describe('v31 git-outage state migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has all four columns and the current schema_version', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v31-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v31-fresh.db'));

    const cols = taskColumns(db);
    for (const c of OUTAGE_COLUMNS) expect(cols.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('34');

    db.close();
  });

  it('a newly inserted task defaults to "no outage in progress"', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v31-default-'));
    const db = initDatabase(path.join(tmpDir, 'v31-default.db'));

    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 100, 1, 'queued')`
    ).run();

    const row = db
      .prepare(
        `SELECT prep_backoff_level, prep_next_attempt_at,
                salvage_backoff_level, salvage_next_attempt_at
           FROM tasks WHERE id = 1`
      )
      .get() as Record<string, number | string | null>;

    expect(row.prep_backoff_level).toBe(0);
    expect(row.salvage_backoff_level).toBe(0);
    expect(row.prep_next_attempt_at).toBeNull();
    expect(row.salvage_next_attempt_at).toBeNull();

    db.close();
  });

  it('upgrades a v30 install: columns added, version bumped, existing rows backfilled', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v31-up-'));
    const dbFile = path.join(tmpDir, 'v31-up.db');

    // A fresh install is already at the current shape, so rebuild a
    // v30-shaped tasks table (no outage columns) and pin the version back to
    // 30 so the next boot must add them. A plain rebuild is used rather than
    // ALTER TABLE DROP COLUMN because the real table definition carries SQL
    // comments, which SQLite's DROP COLUMN rewrite chokes on. Foreign keys
    // are toggled off for the swap so the child rows aren't cascade-deleted
    // with the dropped table (mirrors the v27 rebuild).
    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE tasks_v30 (
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
      DROP TABLE tasks;
      ALTER TABLE tasks_v30 RENAME TO tasks;
    `);
    db.pragma('foreign_keys = ON');
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status, prep_failure_count)
       VALUES (1, 100, 1, 'queued', 2)`
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '30')"
    ).run();
    const before = taskColumns(db);
    for (const c of OUTAGE_COLUMNS) expect(before.has(c)).toBe(false);
    db.close();

    // Reboot → migration adds the columns and bumps the version.
    db = initDatabase(dbFile);
    const after = taskColumns(db);
    for (const c of OUTAGE_COLUMNS) expect(after.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('34');

    // The pre-existing task keeps its prep_failure_count and backfills to
    // "no outage in progress" — it must not look like it is mid-backoff.
    const row = db
      .prepare(
        `SELECT prep_failure_count, prep_backoff_level, prep_next_attempt_at,
                salvage_backoff_level, salvage_next_attempt_at
           FROM tasks WHERE id = 1`
      )
      .get() as Record<string, number | string | null>;
    expect(row.prep_failure_count).toBe(2);
    expect(row.prep_backoff_level).toBe(0);
    expect(row.salvage_backoff_level).toBe(0);
    expect(row.prep_next_attempt_at).toBeNull();
    expect(row.salvage_next_attempt_at).toBeNull();

    db.close();
  });

  it('is idempotent — a second boot after a partial migration is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v31-idem-'));
    const dbFile = path.join(tmpDir, 'v31-idem.db');

    // Pin the version back to 30 with the columns ALREADY present (the shape
    // a crash between the ALTERs and the version bump would leave behind).
    let db = initDatabase(dbFile);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '30')"
    ).run();
    db.close();

    db = initDatabase(dbFile);
    const cols = taskColumns(db);
    for (const c of OUTAGE_COLUMNS) expect(cols.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('34');
    db.close();
  });
});
