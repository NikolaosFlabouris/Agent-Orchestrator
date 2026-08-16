import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** v33 renames the local-inference provider kind 'ollama' →
 *  'openai-compatible'. Nothing about the kind was Ollama-specific (both
 *  harnesses that support it drive a generic OpenAI-completions endpoint at
 *  <base_url>/v1), so the id now names the standard instead of one
 *  implementation. Provider row ids are operator data and stay untouched —
 *  only the `kind` column is rewritten. */

function kindOf(db: Database.Database, id: string): string | undefined {
  return (
    db.prepare('SELECT kind FROM providers WHERE id = ?').get(id) as
      | { kind: string }
      | undefined
  )?.kind;
}

function schemaVersion(db: Database.Database): string {
  return (
    db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string }
  ).value;
}

/** Insert a pre-rename provider row and pin schema_version back to 32 so the
 *  next boot has to forward-migrate. */
function seedV32(dbFile: string, kind: string): void {
  const db = initDatabase(dbFile);
  db.prepare(
    `INSERT INTO providers (id, display_name, kind, concurrency_limit, base_url)
     VALUES ('ollama-local', 'Ollama (Local)', ?, 1, 'http://host.docker.internal:11434')`
  ).run(kind);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '32')"
  ).run();
  db.close();
}

describe('v33 provider-kind rename migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('a fresh install is already at schema_version 33', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v33-fresh-'));
    const db = initDatabase(path.join(tmpDir, 'v33-fresh.db'));
    expect(schemaVersion(db)).toBe('33');
    // The bootstrap seeds no self-hosted provider, so nothing carries the
    // old kind on a fresh DB either.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM providers WHERE kind = 'ollama'").get()
    ).toEqual({ n: 0 });
    db.close();
  });

  it("upgrades a v32 install: kind 'ollama' becomes 'openai-compatible'", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v33-up-'));
    const dbFile = path.join(tmpDir, 'v33-up.db');
    seedV32(dbFile, 'ollama');

    const db = initDatabase(dbFile);
    expect(kindOf(db, 'ollama-local')).toBe('openai-compatible');
    // The row id is operator data — the migration must not touch it.
    expect(
      db
        .prepare("SELECT display_name, base_url FROM providers WHERE id = 'ollama-local'")
        .get()
    ).toEqual({
      display_name: 'Ollama (Local)',
      base_url: 'http://host.docker.internal:11434',
    });
    expect(schemaVersion(db)).toBe('33');
    db.close();
  });

  it('leaves every other provider kind alone', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v33-other-'));
    const dbFile = path.join(tmpDir, 'v33-other.db');
    seedV32(dbFile, 'ollama');

    // The bootstrap seeds anthropic/openai/gemini/… rows; none of them may
    // be rewritten by the rename.
    const db = initDatabase(dbFile);
    expect(kindOf(db, 'anthropic')).toBe('anthropic');
    expect(kindOf(db, 'openai')).toBe('openai');
    expect(kindOf(db, 'openrouter')).toBe('openrouter');
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM providers WHERE kind = 'ollama'").get()
    ).toEqual({ n: 0 });
    db.close();
  });

  it('is idempotent — re-running against already-renamed rows is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v33-idem-'));
    const dbFile = path.join(tmpDir, 'v33-idem.db');
    // The shape a crash between the UPDATE and the version bump would leave
    // behind: already renamed, but still pinned at 32.
    seedV32(dbFile, 'openai-compatible');

    let db = initDatabase(dbFile);
    expect(kindOf(db, 'ollama-local')).toBe('openai-compatible');
    expect(schemaVersion(db)).toBe('33');
    db.close();

    // And a second boot at 33 changes nothing further.
    db = initDatabase(dbFile);
    expect(kindOf(db, 'ollama-local')).toBe('openai-compatible');
    expect(schemaVersion(db)).toBe('33');
    db.close();
  });
});
