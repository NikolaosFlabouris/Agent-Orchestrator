import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v29 adds the per-attempt effort metrics to the attempts table:
 *    num_turns, input_tokens, output_tokens, tool_calls (all nullable).
 *  They are declared in createTables (fresh installs) and added via the v29
 *  forward-migration block (existing installs). NULL means "unknown" and is
 *  never to be conflated with a real 0. */

const USAGE_COLUMNS = [
  'num_turns',
  'input_tokens',
  'output_tokens',
  'tool_calls',
];

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

describe('v29 per-attempt usage metrics migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has all four usage columns and schema_version 29', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v29-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v29-fresh.db'));

    const cols = attemptColumns(db);
    for (const c of USAGE_COLUMNS) expect(cols.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('31');

    db.close();
  });

  it('upgrades a v28 install: columns added, version bumped, existing rows NULL', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v29-up-'));
    const dbFile = path.join(tmpDir, 'v29-up.db');

    // Fresh install is already at the current shape; rebuild a v28-shaped
    // attempts table (no usage columns) and pin the version back to 28 so the
    // next boot must add them. A plain rebuild is used rather than ALTER TABLE
    // DROP COLUMN because the real table definition carries SQL comments,
    // which SQLite's DROP COLUMN rewrite chokes on.
    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 100, 1, 'in-progress')`
    ).run();
    db.exec(`
      CREATE TABLE attempts_v28 (
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
        timeout_minutes_snapshot INTEGER
      );
      DROP TABLE attempts;
      ALTER TABLE attempts_v28 RENAME TO attempts;
    `);
    db.prepare(
      `INSERT INTO attempts (id, task_id, attempt_number, role, status)
       VALUES (1, 1, 1, 'develop', 'completed')`
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '28')"
    ).run();
    const before = attemptColumns(db);
    for (const c of USAGE_COLUMNS) expect(before.has(c)).toBe(false);
    db.close();

    // Reboot → migration adds the columns and bumps the version.
    db = initDatabase(dbFile);
    const after = attemptColumns(db);
    for (const c of USAGE_COLUMNS) expect(after.has(c)).toBe(true);
    expect(schemaVersion(db)).toBe('31');

    // The pre-existing attempt row keeps NULL (unknown) for every metric.
    const row = db
      .prepare(
        'SELECT num_turns, input_tokens, output_tokens, tool_calls FROM attempts WHERE id = 1'
      )
      .get() as Record<string, number | null>;
    for (const c of USAGE_COLUMNS) expect(row[c]).toBeNull();

    db.close();
  });
});
