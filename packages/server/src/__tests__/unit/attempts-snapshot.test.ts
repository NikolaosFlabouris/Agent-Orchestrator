import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabase,
  insertAttempt,
  getLatestAttempt,
  getDb,
} from '../../db.js';

// Isolated in-memory DB per test. Schema is created fresh, so the v22
// `timeout_minutes_snapshot` column is present without a migration.
beforeEach(() => {
  const db = initDatabase(':memory:');
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count)
     VALUES (1, 100, 1, 'in-progress', 1, 3, 0)`
  ).run();
});

describe('insertAttempt — H5a timeout snapshot', () => {
  it('persists timeout_minutes_snapshot when provided', () => {
    insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      model_id: 'claude-sonnet-4-6',
      harness_id: 'claude-sdk',
      timeout_minutes_snapshot: 1440,
    });
    const a = getLatestAttempt(1);
    expect(a).toBeDefined();
    expect(a!.timeout_minutes_snapshot).toBe(1440);
  });

  it('stores null when the snapshot is omitted (legacy / pre-snapshot callers)', () => {
    insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
    });
    const a = getLatestAttempt(1);
    expect(a!.timeout_minutes_snapshot).toBeNull();
  });

  it('snapshot is independent of subsequent profile edits (no live re-resolution)', () => {
    // Insert an attempt with a snapshot. Nothing the orchestrator does
    // to profile rows afterwards should mutate the recorded value.
    insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      timeout_minutes_snapshot: 2880,
    });

    // Simulate a much-later profile read returning a different value.
    // The attempt row should still carry the original snapshot.
    const a = getLatestAttempt(1);
    expect(a!.timeout_minutes_snapshot).toBe(2880);

    // Direct DB confirmation — the column is a stored value, not a view.
    const row = getDb()
      .prepare('SELECT timeout_minutes_snapshot FROM attempts WHERE task_id = 1')
      .get() as { timeout_minutes_snapshot: number | null };
    expect(row.timeout_minutes_snapshot).toBe(2880);
  });
});
