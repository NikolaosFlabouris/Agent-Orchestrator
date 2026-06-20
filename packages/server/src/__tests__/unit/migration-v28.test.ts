import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v28 adds the Reports aggregation indexes:
 *    attempts(model_id), attempts(role), tasks(completed_at),
 *    task_events(event_type, created_at).
 *  They are declared in createTables (fresh installs) and re-created via the
 *  v28 forward-migration block (existing installs). */

const REPORT_INDEXES = [
  'idx_attempts_model_id',
  'idx_attempts_role',
  'idx_tasks_completed_at',
  'idx_task_events_type_created',
];

function indexNames(db: Database.Database): Set<string> {
  return new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  );
}

function schemaVersion(db: Database.Database): string {
  return (
    db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string }
  ).value;
}

describe('v28 reports indexes migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has all four report indexes and schema_version 28', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v28-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v28-fresh.db'));

    const names = indexNames(db);
    for (const idx of REPORT_INDEXES) expect(names.has(idx)).toBe(true);
    expect(schemaVersion(db)).toBe('29');

    db.close();
  });

  it('upgrades a v27 install: indexes (re)created, version bumped', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v28-up-'));
    const dbFile = path.join(tmpDir, 'v28-up.db');

    // Fresh install is already at the current shape; drop the report indexes
    // and pin the version back to 27 so the next boot must restore them.
    let db = initDatabase(dbFile);
    for (const idx of REPORT_INDEXES) db.exec(`DROP INDEX IF EXISTS ${idx}`);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '27')"
    ).run();
    const before = indexNames(db);
    for (const idx of REPORT_INDEXES) expect(before.has(idx)).toBe(false);
    db.close();

    // Reboot → migration restores them and bumps the version.
    db = initDatabase(dbFile);
    const after = indexNames(db);
    for (const idx of REPORT_INDEXES) expect(after.has(idx)).toBe(true);
    expect(schemaVersion(db)).toBe('29');

    db.close();
  });
});
