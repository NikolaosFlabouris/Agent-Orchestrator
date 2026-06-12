import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** Exercises the v21 → v22 forward migration block in `runMigrations`.
 *  Every other suite uses `initDatabase(':memory:')`, which goes down
 *  the fresh-install path and never hits the ALTER. Without this test,
 *  the first failing v22 boot would be in production.
 *
 *  Strategy: open a temp-file DB (so we can close + reopen the
 *  connection; :memory: doesn't persist across close), simulate a v21
 *  install by dropping the column added in v22, pin
 *  `schema_version='21'`, then reopen via `initDatabase` and assert
 *  the migration ran. */

describe('v22 ALTER migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      // Clean up the temp dir + any SQLite WAL/SHM sidecars.
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('adds timeout_minutes_snapshot to a v21 attempts table on boot', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v22-'));
    const dbFile = path.join(tmpDir, 'v22-test.db');

    // Phase 1: fresh install. createTables produces the current shape,
    // bootstrap seed sets schema_version = CURRENT_SCHEMA_VERSION.
    let db = initDatabase(dbFile);
    const v22Cols = db
      .prepare('PRAGMA table_info(attempts)')
      .all() as Array<{ name: string }>;
    expect(v22Cols.some((c) => c.name === 'timeout_minutes_snapshot')).toBe(
      true
    );

    // Phase 2: pretend this DB was created against the v21 binary.
    // SQLite 3.35+ supports DROP COLUMN, which is what better-sqlite3
    // ships. Roll the schema back to the v21 shape and pin the
    // schema_version row so the migration block sees `version < 22`.
    db.exec('ALTER TABLE attempts DROP COLUMN timeout_minutes_snapshot');
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '21')"
    ).run();
    db.close();

    // Phase 3: reboot. runMigrations should detect version=21 and
    // execute every forward-migration block from v22 onward (v22 ALTER,
    // v23 seed, etc.), then bump schema_version to CURRENT_SCHEMA_VERSION.
    db = initDatabase(dbFile);

    const postMigrationCols = db
      .prepare('PRAGMA table_info(attempts)')
      .all() as Array<{ name: string; type: string }>;
    const snapshotCol = postMigrationCols.find(
      (c) => c.name === 'timeout_minutes_snapshot'
    );
    expect(snapshotCol).toBeDefined();
    // Matches the createTables shape: nullable INTEGER, no default.
    expect(snapshotCol!.type).toBe('INTEGER');

    // Schema version reflects the current binary's level — the
    // migration sweep runs every block from `version` to current.
    // Hardcoded here rather than imported because CURRENT_SCHEMA_VERSION
    // isn't exported; the literal moves in lockstep when we bump.
    const versionRow = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(versionRow.value).toBe('26');

    db.close();
  });
});
