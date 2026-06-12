import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from '../../db.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

/** Exercises the v22 → v23 forward-migration block, which idempotently
 *  pre-seeds the Claude Subscription provider, its model rows, and a
 *  `default-claude-code-subscription` profile pairing the claude-code
 *  harness with Sonnet.
 *
 *  Why this test exists: the fresh-install path runs `seedBootstrap
 *  Profile` (which itself calls `seedClaudeSubscription`), so any
 *  fresh DB will have the rows regardless of whether the v23 block
 *  is correct. The interesting case is the existing-install path —
 *  operators already running v22 against this branch need the rows
 *  to appear on the next boot. Simulate that by rolling a fresh DB
 *  back to v22 (deleting the new rows + pinning schema_version) and
 *  asserting the rows reappear after reboot.
 */

describe('v23 seed migration', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('seeds claude-subscription provider + models + profile on v22 → v23 boot', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v23-'));
    const dbFile = path.join(tmpDir, 'v23-test.db');

    // Phase 1: fresh install at current schema. The bootstrap seed
    // already inserts the claude-subscription rows — confirm they're
    // there as a sanity check before we tear them out.
    let db = initDatabase(dbFile);
    expect(
      db
        .prepare("SELECT id FROM providers WHERE id = 'claude-subscription'")
        .get()
    ).toBeDefined();

    // Phase 2: roll back to v22 — delete the v23-seeded rows and pin
    // schema_version='22' so the next initDatabase sees `version < 23`.
    // Profile must go first to satisfy the model FK; models before the
    // provider for the same reason.
    db.prepare(
      "DELETE FROM agent_profiles WHERE id = 'default-claude-code-subscription'"
    ).run();
    db.prepare(
      "DELETE FROM models WHERE provider_id = 'claude-subscription'"
    ).run();
    db.prepare("DELETE FROM providers WHERE id = 'claude-subscription'").run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '22')"
    ).run();
    db.close();

    // Phase 3: reboot. The v23 migration block should re-seed all
    // three layers idempotently.
    db = initDatabase(dbFile);

    const provider = db
      .prepare("SELECT * FROM providers WHERE id = 'claude-subscription'")
      .get() as {
      id: string;
      kind: string;
      api_key_env_var: string;
    } | undefined;
    expect(provider).toBeDefined();
    expect(provider!.kind).toBe('claude-subscription');
    expect(provider!.api_key_env_var).toBe('CLAUDE_CODE_OAUTH_TOKEN');

    const modelRows = db
      .prepare(
        "SELECT model_id FROM models WHERE provider_id = 'claude-subscription' ORDER BY model_id"
      )
      .all() as Array<{ model_id: string }>;
    expect(modelRows.map((m) => m.model_id)).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);

    const profile = db
      .prepare(
        "SELECT * FROM agent_profiles WHERE id = 'default-claude-code-subscription'"
      )
      .get() as {
      harness_id: string;
      timeout_minutes: number;
    } | undefined;
    expect(profile).toBeDefined();
    expect(profile!.harness_id).toBe('claude-code');
    expect(profile!.timeout_minutes).toBe(2880);

    // Global default unchanged — the v23 seed doesn't repoint it.
    const defaultProfile = db
      .prepare(
        "SELECT value FROM settings WHERE key = 'default_agent_profile_id'"
      )
      .get() as { value: string };
    expect(defaultProfile.value).toBe('default-claude-sdk');

    // Schema version bumped to the current level — the migration
    // sweep runs every block from `version` up to CURRENT_SCHEMA_VERSION,
    // so a v22 install rolled forward through v23 lands on the current
    // version too.
    const versionRow = db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(versionRow.value).toBe('25');

    db.close();
  });

  it('is idempotent — re-running on an already-seeded DB inserts nothing new', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orch-mig-v23-idem-'));
    const dbFile = path.join(tmpDir, 'v23-idem.db');

    // Fresh install: seedBootstrapProfile already calls
    // seedClaudeSubscription, so the v23 rows exist at version=23.
    let db = initDatabase(dbFile);
    const beforeProviderCount = (
      db.prepare('SELECT COUNT(*) AS n FROM providers').get() as {
        n: number;
      }
    ).n;
    const beforeModelCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM models WHERE provider_id = 'claude-subscription'"
        )
        .get() as { n: number }
    ).n;
    expect(beforeModelCount).toBe(3);

    // Force the v23 migration to run again by pinning schema_version='22'.
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '22')"
    ).run();
    db.close();

    db = initDatabase(dbFile);

    // INSERT OR IGNORE: the existing rows stay, no new rows added.
    const afterProviderCount = (
      db.prepare('SELECT COUNT(*) AS n FROM providers').get() as {
        n: number;
      }
    ).n;
    const afterModelCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM models WHERE provider_id = 'claude-subscription'"
        )
        .get() as { n: number }
    ).n;
    expect(afterProviderCount).toBe(beforeProviderCount);
    expect(afterModelCount).toBe(beforeModelCount);

    db.close();
  });
});
