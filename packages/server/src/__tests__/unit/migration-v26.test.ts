import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** Exercises the v25 → v26 forward-migration block, which adds the
 *  task_dependencies table (synced projection of the issue body's
 *  "## Dependencies" checklist) and its reverse-lookup index.
 *
 *  Same strategy as the other migration suites: temp-file DB, roll the
 *  schema back by dropping what the migration adds, pin schema_version,
 *  reboot, assert the migration recreated it. */

describe('v26 task_dependencies migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('creates task_dependencies and its index on a fresh install', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v26-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v26-fresh.db'));

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = 'task_dependencies'"
        )
        .get()
    ).toBeDefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_task_deps_reverse'"
        )
        .get()
    ).toBeDefined();

    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('28');

    db.close();
  });

  it('recreates the table on a v25 → v26 boot', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v26-up-'));
    const dbFile = path.join(tmpDir, 'v26-up.db');

    // Phase 1: fresh install at current schema.
    let db = initDatabase(dbFile);

    // Phase 2: roll back to v25 — drop the table and pin the version.
    db.exec('DROP TABLE IF EXISTS task_dependencies');
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '25')"
    ).run();
    db.close();

    // Phase 3: reboot. The v26 block recreates table + index and bumps
    // the version.
    db = initDatabase(dbFile);

    const cols = db
      .prepare('PRAGMA table_info(task_dependencies)')
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'task_id',
      'dep_issue_number',
      'state',
      'detail',
      'checked',
      'first_seen_at',
      'last_evaluated_at',
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_task_deps_reverse'"
        )
        .get()
    ).toBeDefined();

    const versionRow = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(versionRow.value).toBe('28');

    db.close();
  });

  it('a v24 install rolls forward through BOTH v25 and v26 in one boot', () => {
    // The two migrations were developed in parallel (per-stage profiles
    // landed as v25; task_dependencies renumbered to v26 at merge). This
    // guards the combined path: a pre-split install must end up with the
    // review-profile columns AND the dependencies table.
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v26-combined-'));
    const dbFile = path.join(tmpDir, 'v26-combined.db');

    let db = initDatabase(dbFile);
    db.exec(`
      ALTER TABLE tasks DROP COLUMN review_agent_profile_id;
      ALTER TABLE repos DROP COLUMN review_agent_profile_id;
      DROP TABLE IF EXISTS task_dependencies;
    `);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '24')"
    ).run();
    db.close();

    db = initDatabase(dbFile);

    const taskCols = (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(taskCols).toContain('review_agent_profile_id');
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = 'task_dependencies'"
        )
        .get()
    ).toBeDefined();

    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('28');

    db.close();
  });

  it('enforces the (task_id, dep_issue_number) uniqueness and task FK cascade', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v26-fk-'));
    const db = initDatabase(path.join(tmpDir, 'v26-fk.db'));

    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 10, 1, 'queued')`
    ).run();
    db.prepare(
      `INSERT INTO task_dependencies (task_id, dep_issue_number, state, first_seen_at)
       VALUES (1, 5, 'open', datetime('now'))`
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO task_dependencies (task_id, dep_issue_number, state, first_seen_at)
           VALUES (1, 5, 'open', datetime('now'))`
        )
        .run()
    ).toThrow(/UNIQUE/);

    db.prepare('DELETE FROM tasks WHERE id = 1').run();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get()
    ).toEqual({ n: 0 });

    db.close();
  });
});
