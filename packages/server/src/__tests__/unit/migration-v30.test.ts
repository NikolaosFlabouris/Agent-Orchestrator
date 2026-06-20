import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v30 adds the PR code-churn stats to the attempts table:
 *    changed_files, additions, deletions (all nullable).
 *  They are declared in createTables (fresh installs) and added via the v30
 *  forward-migration block (existing installs). NULL means "unknown" (a
 *  develop attempt, a pre-v30 row, or a review where the PR fetch failed)
 *  and is never to be conflated with a real 0. */

const CHURN_COLUMNS = ['changed_files', 'additions', 'deletions'];

function attemptColumns(db: Database.Database): Set<string> {
  return new Set(
    (
      db.prepare('PRAGMA table_info(attempts)').all() as Array<{ name: string }>
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

describe('v30 PR churn stats migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has all three churn columns and schema_version 30', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v30-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v30-fresh.db'));

    const cols = attemptColumns(db);
    for (const c of CHURN_COLUMNS) expect(cols.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('30');

    db.close();
  });

  it('upgrades a v29 install: columns added, version bumped, existing rows NULL', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v30-up-'));
    const dbFile = path.join(tmpDir, 'v30-up.db');

    // Fresh install is already at the current shape; rebuild a v29-shaped
    // attempts table (usage columns but no churn columns) and pin the version
    // back to 29 so the next boot must add them. A plain rebuild is used
    // rather than ALTER TABLE DROP COLUMN because the real table definition
    // carries SQL comments, which SQLite's DROP COLUMN rewrite chokes on.
    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 100, 1, 'in-progress')`
    ).run();
    db.exec(`
      CREATE TABLE attempts_v29 (
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
        tool_calls INTEGER
      );
      DROP TABLE attempts;
      ALTER TABLE attempts_v29 RENAME TO attempts;
    `);
    db.prepare(
      `INSERT INTO attempts (id, task_id, attempt_number, role, status)
       VALUES (1, 1, 1, 'review', 'completed')`
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '29')"
    ).run();
    const before = attemptColumns(db);
    for (const c of CHURN_COLUMNS) expect(before.has(c)).toBe(false);
    db.close();

    // Reboot → migration adds the columns and bumps the version.
    db = initDatabase(dbFile);
    const after = attemptColumns(db);
    for (const c of CHURN_COLUMNS) expect(after.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('30');

    // The pre-existing attempt row keeps NULL (unknown) for every stat.
    const row = db
      .prepare(
        'SELECT changed_files, additions, deletions FROM attempts WHERE id = 1'
      )
      .get() as Record<string, number | null>;
    for (const c of CHURN_COLUMNS) expect(row[c]).toBeNull();

    db.close();
  });
});
