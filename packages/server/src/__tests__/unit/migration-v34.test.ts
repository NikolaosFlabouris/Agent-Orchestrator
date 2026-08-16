import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v34 adds the nullable `models.context_window` column: the token budget an
 *  operator wants a model driven with. Only the operator knows a self-hosted
 *  server's real --ctx-size, and pi sizes compaction off its own 128,000
 *  default otherwise. NULL means "unset" — every harness must keep emitting
 *  exactly the config it emitted before the column existed. */

function modelColumns(db: Database.Database): Set<string> {
  return new Set(
    (
      db.prepare(`SELECT name FROM pragma_table_info('models')`).all() as Array<{
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

describe('v34 models.context_window migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install has the column and schema_version 34', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v34-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v34-fresh.db'));

    expect(modelColumns(db).has('context_window')).toBe(true);
    expect(schemaVersion(db)).toBe('34');
    // Seeded models carry no opinion about the context window.
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM models WHERE context_window IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 0 });

    db.close();
  });

  it('upgrades a v33 install: column added, version bumped, existing rows NULL', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v34-up-'));
    const dbFile = path.join(tmpDir, 'v34-up.db');

    // Fresh install is already at the current shape; rebuild a v33-shaped
    // models table (no context_window) and pin the version back to 33 so the
    // next boot must add the column. A plain rebuild is used rather than
    // ALTER TABLE DROP COLUMN because the real table definition carries SQL
    // comments, which SQLite's DROP COLUMN rewrite chokes on.
    let db = initDatabase(dbFile);
    // agent_profiles.model_pk references models(id), so the swap needs FK
    // enforcement off — same dance the real v27 tasks rebuild does.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE models_v33 (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        UNIQUE(provider_id, model_id)
      );
      INSERT INTO models_v33 (id, provider_id, model_id, display_name)
        SELECT id, provider_id, model_id, display_name FROM models;
      DROP TABLE models;
      ALTER TABLE models_v33 RENAME TO models;
    `);
    db.pragma('foreign_keys = ON');
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '33')"
    ).run();
    expect(modelColumns(db).has('context_window')).toBe(false);
    const seededModels = (
      db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }
    ).n;
    expect(seededModels).toBeGreaterThan(0);
    db.close();

    // Reboot → migration adds the column and bumps the version.
    db = initDatabase(dbFile);
    expect(modelColumns(db).has('context_window')).toBe(true);
    expect(schemaVersion(db)).toBe('34');
    // Pre-existing rows survive and read as "unset", not 0.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM models').get()
    ).toEqual({ n: seededModels });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM models WHERE context_window IS NOT NULL'
        )
        .get()
    ).toEqual({ n: 0 });

    db.close();
  });

  it('is idempotent — a second boot after a partial migration is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v34-idem-'));
    const dbFile = path.join(tmpDir, 'v34-idem.db');

    // Pin the version back to 33 with the column ALREADY present (the shape a
    // crash between the ALTER and the version bump would leave behind).
    let db = initDatabase(dbFile);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '33')"
    ).run();
    db.close();

    db = initDatabase(dbFile);
    expect(modelColumns(db).has('context_window')).toBe(true);
    expect(schemaVersion(db)).toBe('34');
    db.close();
  });

  it('round-trips a set value and a clear back to NULL', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v34-rt-'));
    const db = initDatabase(path.join(tmpDir, 'v34-rt.db'));

    const pk = (
      db
        .prepare('SELECT id FROM models ORDER BY id LIMIT 1')
        .get() as { id: number }
    ).id;
    db.prepare('UPDATE models SET context_window = 32768 WHERE id = ?').run(pk);
    expect(
      db.prepare('SELECT context_window FROM models WHERE id = ?').get(pk)
    ).toEqual({ context_window: 32768 });

    db.prepare('UPDATE models SET context_window = NULL WHERE id = ?').run(pk);
    expect(
      db.prepare('SELECT context_window FROM models WHERE id = ?').get(pk)
    ).toEqual({ context_window: null });

    db.close();
  });
});
