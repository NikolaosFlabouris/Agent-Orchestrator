import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/**
 * Exercises the v24 → v25 forward-migration block, which adds the
 * nullable review-stage profile pointer (review_agent_profile_id) to
 * both tasks and repos.
 *
 * Fresh installs get the columns via createTables; the interesting
 * case is operators already running v24. Simulate that by rolling a
 * fresh DB back to v24 (dropping the new columns + pinning
 * schema_version) and asserting they reappear after reboot with
 * existing rows defaulting to NULL (review inherits the
 * implementation profile — pre-v25 behavior).
 */

function columnNames(
  db: ReturnType<typeof initDatabase>,
  table: string
): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe('v25 review_agent_profile_id migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('has the column on tasks and repos on a fresh install', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v25-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v25-fresh.db'));

    expect(columnNames(db, 'tasks')).toContain('review_agent_profile_id');
    expect(columnNames(db, 'repos')).toContain('review_agent_profile_id');

    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('29');

    db.close();
  });

  it('adds the columns on a v24 → v25 boot, with NULL on existing rows', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v25-up-'));
    const dbFile = path.join(tmpDir, 'v25-up.db');

    // Phase 1: fresh install at current schema, then roll the two
    // tables back to their v24 shape (no review_agent_profile_id) and
    // pin schema_version='24'. Seed one row in each table first so we
    // can assert the migrated column defaults to NULL on them.
    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 10, 1, 'queued')`
    ).run();
    db.exec(`
      ALTER TABLE tasks DROP COLUMN review_agent_profile_id;
      ALTER TABLE repos DROP COLUMN review_agent_profile_id;
    `);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '24')"
    ).run();
    db.close();

    // Phase 2: reboot. The v25 block should add both columns.
    db = initDatabase(dbFile);

    expect(columnNames(db, 'tasks')).toContain('review_agent_profile_id');
    expect(columnNames(db, 'repos')).toContain('review_agent_profile_id');

    // Pre-existing rows carry NULL — review inherits the
    // implementation profile, preserving pre-v25 behavior.
    const task = db
      .prepare('SELECT review_agent_profile_id FROM tasks WHERE id = 1')
      .get() as { review_agent_profile_id: string | null };
    expect(task.review_agent_profile_id).toBeNull();
    const repo = db
      .prepare('SELECT review_agent_profile_id FROM repos WHERE id = 1')
      .get() as { review_agent_profile_id: string | null };
    expect(repo.review_agent_profile_id).toBeNull();

    const versionRow = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(versionRow.value).toBe('29');

    db.close();
  });

  it('is idempotent — re-running on an already-migrated DB is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v25-idem-'));
    const dbFile = path.join(tmpDir, 'v25-idem.db');

    let db = initDatabase(dbFile);
    // Pin to v24 WITHOUT dropping the columns — the pragma_table_info
    // guard should skip the ALTERs instead of erroring on a duplicate
    // column.
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '24')"
    ).run();
    db.close();

    db = initDatabase(dbFile);
    expect(
      columnNames(db, 'tasks').filter((c) => c === 'review_agent_profile_id')
    ).toHaveLength(1);
    expect(
      columnNames(db, 'repos').filter((c) => c === 'review_agent_profile_id')
    ).toHaveLength(1);
    db.close();
  });
});
