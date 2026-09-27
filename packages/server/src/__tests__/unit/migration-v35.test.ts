import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase, insertAttempt, getAgentProfile } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v35 adds the nullable `agent_profiles.effort_level` column (the
 *  orchestrator-managed reasoning effort a profile launches with) and its
 *  per-attempt launch snapshot `attempts.effort_level`. NULL means "unset"
 *  on both — every harness keeps emitting exactly the invocation it emitted
 *  before the columns existed. */

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

/** Rebuild `table` without `column`. A plain CREATE-AS-SELECT rebuild is
 *  used rather than ALTER TABLE DROP COLUMN because the real table
 *  definitions carry SQL comments, which SQLite's DROP COLUMN rewrite
 *  chokes on (same reason as migration-v34.test.ts). Constraints are lost,
 *  which is irrelevant to what the migration does. */
function dropColumn(db: Database.Database, table: string, column: string): void {
  const keep = [...columns(db, table)].filter((c) => c !== column).join(', ');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE ${table}_v34 AS SELECT ${keep} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}_v34 RENAME TO ${table};
  `);
  db.pragma('foreign_keys = ON');
}

describe('v35 effort_level migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has both columns and schema_version 35', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v35-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v35-fresh.db'));

    expect(columns(db, 'agent_profiles').has('effort_level')).toBe(true);
    expect(columns(db, 'attempts').has('effort_level')).toBe(true);
    expect(schemaVersion(db)).toBe('35');
    // Seeded profiles carry no opinion about effort.
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM agent_profiles WHERE effort_level IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 0 });
    expect(getAgentProfile('default-claude-sdk')!.effort_level).toBeNull();

    db.close();
  });

  it('upgrades a v34 install: columns added, version bumped, existing rows NULL', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v35-up-'));
    const dbFile = path.join(tmpDir, 'v35-up.db');

    let db = initDatabase(dbFile);
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 100, 1, 'in-progress')`
    ).run();
    db.prepare(
      `INSERT INTO attempts (task_id, attempt_number, role, status, model_id, harness_id)
       VALUES (1, 1, 'develop', 'success', 'claude-sonnet-4-6', 'claude-sdk')`
    ).run();
    dropColumn(db, 'agent_profiles', 'effort_level');
    dropColumn(db, 'attempts', 'effort_level');
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '34')"
    ).run();
    expect(columns(db, 'agent_profiles').has('effort_level')).toBe(false);
    expect(columns(db, 'attempts').has('effort_level')).toBe(false);
    const profileCount = (
      db.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get() as { n: number }
    ).n;
    expect(profileCount).toBeGreaterThan(0);
    db.close();

    // Reboot → migration adds both columns and bumps the version.
    db = initDatabase(dbFile);
    expect(columns(db, 'agent_profiles').has('effort_level')).toBe(true);
    expect(columns(db, 'attempts').has('effort_level')).toBe(true);
    expect(schemaVersion(db)).toBe('35');
    // Pre-existing rows survive and read as "unset".
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM agent_profiles').get()
    ).toEqual({ n: profileCount });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM agent_profiles WHERE effort_level IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT model_id, effort_level FROM attempts').all()
    ).toEqual([{ model_id: 'claude-sonnet-4-6', effort_level: null }]);

    db.close();
  });

  it('is idempotent — a second boot after a partial migration is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v35-idem-'));
    const dbFile = path.join(tmpDir, 'v35-idem.db');

    // Columns ALREADY present with the version pinned back to 34 — the
    // shape a crash between the ALTERs and the version bump leaves behind.
    let db = initDatabase(dbFile);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '34')"
    ).run();
    db.close();

    db = initDatabase(dbFile);
    expect(columns(db, 'agent_profiles').has('effort_level')).toBe(true);
    expect(columns(db, 'attempts').has('effort_level')).toBe(true);
    expect(schemaVersion(db)).toBe('35');
    db.close();
  });

  it('insertAttempt persists the effort_level snapshot, NULL when omitted', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v35-att-'));
    const db = initDatabase(path.join(tmpDir, 'v35-att.db'));
    db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
    db.prepare(
      `INSERT INTO tasks (id, issue_id, repo_id, status) VALUES (1, 100, 1, 'in-progress')`
    ).run();

    const set = insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      effort_level: 'xhigh',
    });
    expect(set.effort_level).toBe('xhigh');
    const unset = insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'review',
      status: 'running',
    });
    expect(unset.effort_level).toBeNull();

    db.close();
  });
});
