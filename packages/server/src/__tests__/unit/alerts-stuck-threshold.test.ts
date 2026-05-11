import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, insertAttempt, getDb } from '../../db.js';
import { checkAlerts } from '../../alerts.js';
import type { FastifyBaseLogger } from 'fastify';

// Minimum logger stub — checkAlerts only consults it for diagnostic
// info, not for control flow.
const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as FastifyBaseLogger;

// `p1` is the test-specific profile name we use throughout. It's set to
// timeout_minutes=60 so the alert tests have a clean "live" threshold
// to compare against snapshot-driven behavior. We piggyback on the
// bootstrap-seeded providers/models (initDatabase runs the bootstrap
// seed via runMigrations) rather than re-inserting our own, which would
// trip the UNIQUE constraint on providers.id.
beforeEach(() => {
  const db = initDatabase(':memory:');
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
  // The bootstrap seed already creates the 'anthropic' provider and a
  // sonnet model row. Look up that model's surrogate pk so the test
  // profile FKs cleanly.
  const sonnet = db
    .prepare(
      `SELECT id FROM models WHERE provider_id = 'anthropic' AND model_id = 'claude-sonnet-4-6'`
    )
    .get() as { id: number };
  db.prepare(
    `INSERT INTO agent_profiles (id, display_name, harness_id, model_pk, config_json, timeout_minutes)
     VALUES ('p1', 'P1', 'claude-sdk', ?, '{}', 60)`
  ).run(sonnet.id);
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('default_agent_profile_id', 'p1')`
  ).run();
});

function insertInProgressTask(opts: {
  taskId: number;
  startedMinutesAgo: number;
  agentProfileId?: string | null;
}): void {
  const startedAt = new Date(
    Date.now() - opts.startedMinutesAgo * 60_000
  ).toISOString();
  getDb()
    .prepare(
      `INSERT INTO tasks
         (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count,
          agent_profile_id, started_at)
       VALUES (?, ?, 1, 'in-progress', 1, 3, 0, ?, ?)`
    )
    .run(opts.taskId, 100 + opts.taskId, opts.agentProfileId ?? null, startedAt);
}

describe('checkAlerts — H5a stuck-task threshold sourcing', () => {
  it('uses attempts.timeout_minutes_snapshot when present, ignoring a shortened live profile', async () => {
    // Task ran past where the *live* profile timeout (60m × 2 = 120m
    // stuck threshold) would fire, but the *snapshotted* threshold
    // (1440m × 2 = 2880m) is much higher. The alert MUST be suppressed.
    insertInProgressTask({ taskId: 1, startedMinutesAgo: 200 });
    insertAttempt({
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      timeout_minutes_snapshot: 1440,
    });

    const alerts = await checkAlerts(noopLog);
    const stuck = alerts.filter((a) => a.message.includes('stuck'));
    expect(stuck).toHaveLength(0);
  });

  it('fires when elapsed exceeds the snapshot threshold × multiplier', async () => {
    // Snapshot = 30m, threshold = 60m, ran 90m → stuck.
    insertInProgressTask({ taskId: 2, startedMinutesAgo: 90 });
    insertAttempt({
      task_id: 2,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      timeout_minutes_snapshot: 30,
    });
    const alerts = await checkAlerts(noopLog);
    const stuck = alerts.filter((a) => a.message.includes('stuck'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0].message).toContain('from snapshot');
    expect(stuck[0].message).toContain('30m');
  });

  it('falls back to a live profile read when the snapshot is null', async () => {
    // No snapshot on the attempt. The fallback uses the resolved
    // profile (p1 → timeout 60m). Elapsed 150m exceeds 60×2=120m so
    // the alert fires; message labels the source as "live".
    insertInProgressTask({
      taskId: 3,
      startedMinutesAgo: 150,
      agentProfileId: 'p1',
    });
    insertAttempt({
      task_id: 3,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      // No timeout_minutes_snapshot → legacy/pre-v22 path.
    });
    const alerts = await checkAlerts(noopLog);
    const stuck = alerts.filter((a) => a.message.includes('stuck'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0].message).toContain('live');
    expect(stuck[0].message).toContain("profile 'p1'");
  });

  it('falls back to a live profile read when there is no attempt row at all', async () => {
    insertInProgressTask({
      taskId: 4,
      startedMinutesAgo: 150,
      agentProfileId: 'p1',
    });
    // Intentionally no insertAttempt — covers the pre-v22 path where
    // a task is running but the snapshot column / attempt row is
    // missing.
    const alerts = await checkAlerts(noopLog);
    const stuck = alerts.filter((a) => a.message.includes('stuck'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0].message).toContain('live');
  });

  it('skips the task when neither the snapshot nor a live profile resolves', async () => {
    // Task has no agent_profile_id override, no attempt row, and we
    // remove the global default so the fallback chain dead-ends.
    insertInProgressTask({ taskId: 5, startedMinutesAgo: 9999 });
    getDb()
      .prepare(`DELETE FROM settings WHERE key = 'default_agent_profile_id'`)
      .run();
    const alerts = await checkAlerts(noopLog);
    const stuck = alerts.filter((a) => a.message.includes('stuck'));
    expect(stuck).toHaveLength(0);
  });

  it('elapsed below threshold does not fire even with a generous snapshot', async () => {
    // Snapshot = 600m, threshold = 1200m, ran 5m → not stuck.
    insertInProgressTask({ taskId: 6, startedMinutesAgo: 5 });
    insertAttempt({
      task_id: 6,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      timeout_minutes_snapshot: 600,
    });
    const alerts = await checkAlerts(noopLog);
    const stuck = alerts.filter((a) => a.message.includes('stuck'));
    expect(stuck).toHaveLength(0);
  });
});
