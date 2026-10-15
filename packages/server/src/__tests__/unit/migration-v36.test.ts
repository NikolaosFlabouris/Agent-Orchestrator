import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase, getTask, updateTaskRaw } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v36 adds the nullable `tasks.no_change_claim` column: a dev agent's
 *  validated no-change claim, persisted so the review step (agent or human)
 *  can read it after the output dir has been archived. NULL = no claim. */

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
        name: string;
      }>
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

/** Rebuild `tasks` without `no_change_claim` (see migration-v35.test.ts for
 *  why this is a CREATE-AS-SELECT rather than DROP COLUMN). */
function dropClaimColumn(db: Database.Database): void {
  const keep = [...columns(db, 'tasks')]
    .filter((c) => c !== 'no_change_claim')
    .join(', ');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE tasks_v35 AS SELECT ${keep} FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_v35 RENAME TO tasks;
  `);
  db.pragma('foreign_keys = ON');
}

describe('v36 tasks.no_change_claim migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has the column and schema_version 36', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v36-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v36-fresh.db'));
    expect(columns(db, 'tasks').has('no_change_claim')).toBe(true);
    expect(schemaVersion(db)).toBe('36');
    db.close();
  });

  it('upgrades a v35 install: column added, version bumped, existing rows NULL', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v36-up-'));
    const dbFile = path.join(tmpDir, 'v36-up.db');

    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 100, 1, 'failed')`
    ).run();
    dropClaimColumn(db);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '35')"
    ).run();
    expect(columns(db, 'tasks').has('no_change_claim')).toBe(false);
    db.close();

    db = initDatabase(dbFile);
    expect(columns(db, 'tasks').has('no_change_claim')).toBe(true);
    expect(schemaVersion(db)).toBe('36');
    expect(getTask(1)!.status).toBe('failed');
    expect(getTask(1)!.no_change_claim).toBeNull();

    // The column is writable through the normal task update path.
    updateTaskRaw(1, { no_change_claim: '{"category":"duplicate"}' });
    expect(getTask(1)!.no_change_claim).toBe('{"category":"duplicate"}');
    db.close();
  });

  it('is idempotent — a second boot after a partial migration is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v36-idem-'));
    const dbFile = path.join(tmpDir, 'v36-idem.db');
    let db = initDatabase(dbFile);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '35')"
    ).run();
    db.close();

    db = initDatabase(dbFile);
    expect(columns(db, 'tasks').has('no_change_claim')).toBe(true);
    expect(schemaVersion(db)).toBe('36');
    db.close();
  });
});
