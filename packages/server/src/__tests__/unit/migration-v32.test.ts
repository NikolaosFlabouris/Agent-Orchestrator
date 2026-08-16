import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v32 adds the attempt failure reason to the attempts table:
 *    error_message (TEXT), exit_code (INTEGER) — both nullable.
 *  The scheduler already read both off the harness's result.json but had
 *  nowhere to store them, so the UI could only say "failed". NULL means "no
 *  reason recorded" (a successful attempt, a pre-v32 row, or a harness that
 *  reported nothing); an exit_code of NULL is never a real 0. */

const FAILURE_COLUMNS = ['error_message', 'exit_code'];

function attemptColumns(db: Database.Database): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT name FROM pragma_table_info('attempts')`
        )
        .all() as Array<{ name: string }>
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

describe('v32 attempt failure-reason migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has both columns and schema_version 32', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v32-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v32-fresh.db'));

    const cols = attemptColumns(db);
    for (const c of FAILURE_COLUMNS) expect(cols.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('34');

    db.close();
  });

  it('upgrades a v31 install: columns added, version bumped, existing rows NULL', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v32-up-'));
    const dbFile = path.join(tmpDir, 'v32-up.db');

    // Fresh install is already at the current shape; rebuild a v31-shaped
    // attempts table (churn columns but no failure columns) and pin the
    // version back to 31 so the next boot must add them. A plain rebuild is
    // used rather than ALTER TABLE DROP COLUMN because the real table
    // definition carries SQL comments, which SQLite's DROP COLUMN rewrite
    // chokes on.
    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 100, 1, 'failed')`
    ).run();
    db.exec(`
      CREATE TABLE attempts_v31 (
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
        model_id TEXT,
        harness_id TEXT,
        timeout_minutes_snapshot INTEGER,
        num_turns INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        tool_calls INTEGER,
        changed_files INTEGER,
        additions INTEGER,
        deletions INTEGER
      );
      DROP TABLE attempts;
      ALTER TABLE attempts_v31 RENAME TO attempts;
    `);
    db.prepare(
      `INSERT INTO attempts (id, task_id, attempt_number, role, status)
       VALUES (1, 1, 1, 'develop', 'failed')`
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '31')"
    ).run();
    const before = attemptColumns(db);
    for (const c of FAILURE_COLUMNS) expect(before.has(c)).toBe(false);
    db.close();

    // Reboot → migration adds the columns and bumps the version.
    db = initDatabase(dbFile);
    const after = attemptColumns(db);
    for (const c of FAILURE_COLUMNS) expect(after.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('34');

    // A pre-existing failed attempt has no recorded reason — NULL, not ''
    // or 0, so the UI renders nothing rather than a blank red line.
    const row = db
      .prepare('SELECT error_message, exit_code FROM attempts WHERE id = 1')
      .get() as Record<string, string | number | null>;
    for (const c of FAILURE_COLUMNS) expect(row[c]).toBeNull();

    db.close();
  });

  it('is idempotent — a second boot after a partial migration is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v32-idem-'));
    const dbFile = path.join(tmpDir, 'v32-idem.db');

    // Pin the version back to 31 with the columns ALREADY present (the shape
    // a crash between the ALTERs and the version bump would leave behind).
    let db = initDatabase(dbFile);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '31')"
    ).run();
    db.close();

    db = initDatabase(dbFile);
    const cols = attemptColumns(db);
    for (const c of FAILURE_COLUMNS) expect(cols.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('34');
    db.close();
  });
});
