import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/**
 * Exercises the v23 → v24 forward-migration block, which adds the
 * three MCP OAuth tables (mcp_oauth_clients, mcp_oauth_codes,
 * mcp_oauth_refresh) backing the embedded Authorization Server for
 * /mcp.
 *
 * Fresh installs get the tables via createTables; the interesting
 * case is operators already running v23 against this branch. Simulate
 * that by rolling a fresh DB back to v23 (dropping the new tables +
 * pinning schema_version) and asserting they reappear after reboot.
 */

describe('v24 MCP OAuth table migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('creates mcp_oauth_clients / codes / refresh tables on a fresh install', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v24-fresh-'));
    const dbFile = path.join(tmpDir, 'v24-fresh.db');

    const db = initDatabase(dbFile);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mcp_oauth_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'mcp_oauth_clients',
      'mcp_oauth_codes',
      'mcp_oauth_refresh',
    ]);

    // schema_version is the current value.
    const v = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(v.value).toBe('29');

    db.close();
  });

  it('recreates the three tables on a v23 → v24 boot', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v24-up-'));
    const dbFile = path.join(tmpDir, 'v24-up.db');

    // Phase 1: fresh install at current schema (v24) — confirm the
    // tables are there.
    let db = initDatabase(dbFile);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = 'mcp_oauth_clients'"
        )
        .get()
    ).toBeDefined();

    // Phase 2: roll back to v23 — drop the new tables and pin
    // schema_version='23'. Drop refresh and codes before clients to
    // satisfy the FK.
    db.exec(`
      DROP TABLE IF EXISTS mcp_oauth_refresh;
      DROP TABLE IF EXISTS mcp_oauth_codes;
      DROP TABLE IF EXISTS mcp_oauth_clients;
    `);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '23')"
    ).run();
    db.close();

    // Phase 3: reboot. The v24 migration block should re-create all
    // three tables and bump the schema_version.
    db = initDatabase(dbFile);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mcp_oauth_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'mcp_oauth_clients',
      'mcp_oauth_codes',
      'mcp_oauth_refresh',
    ]);

    const versionRow = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(versionRow.value).toBe('29');

    db.close();
  });

  it('is idempotent — re-running on an already-migrated DB is a no-op', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v24-idem-'));
    const dbFile = path.join(tmpDir, 'v24-idem.db');

    let db = initDatabase(dbFile);
    // Pin to v23 again to force the migration to re-run, but DON'T
    // drop the tables — they're already there.
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '23')"
    ).run();
    db.close();

    // Should boot cleanly; CREATE TABLE IF NOT EXISTS makes the
    // re-application a no-op.
    db = initDatabase(dbFile);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mcp_oauth_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'mcp_oauth_clients',
      'mcp_oauth_codes',
      'mcp_oauth_refresh',
    ]);
    db.close();
  });

  it('FK + cascade on mcp_oauth_clients deletes child codes and refresh tokens', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v24-fk-'));
    const dbFile = path.join(tmpDir, 'v24-fk.db');

    const db = initDatabase(dbFile);

    db.prepare(
      `INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris)
       VALUES (?, ?, ?)`
    ).run('client-A', 'test client', '["http://127.0.0.1:8080/callback"]');
    db.prepare(
      `INSERT INTO mcp_oauth_codes
         (code, client_id, redirect_uri, code_challenge, resource, forgejo_user_login, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'code-1',
      'client-A',
      'http://127.0.0.1:8080/callback',
      'challenge',
      'http://localhost:8081/mcp',
      'alice',
      new Date(Date.now() + 60_000).toISOString()
    );
    db.prepare(
      `INSERT INTO mcp_oauth_refresh
         (token_id, client_id, family_id, forgejo_user_login, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'refresh-1',
      'client-A',
      'family-1',
      'alice',
      'http://localhost:8081/mcp',
      new Date(Date.now() + 86_400_000).toISOString()
    );

    // Sanity: rows present.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_codes').get() as {
        n: number;
      }).n
    ).toBe(1);
    expect(
      (db
        .prepare('SELECT COUNT(*) AS n FROM mcp_oauth_refresh')
        .get() as { n: number }).n
    ).toBe(1);

    db.prepare('DELETE FROM mcp_oauth_clients WHERE client_id = ?').run(
      'client-A'
    );

    // ON DELETE CASCADE: child rows are gone.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_codes').get() as {
        n: number;
      }).n
    ).toBe(0);
    expect(
      (db
        .prepare('SELECT COUNT(*) AS n FROM mcp_oauth_refresh')
        .get() as { n: number }).n
    ).toBe(0);

    db.close();
  });
});
