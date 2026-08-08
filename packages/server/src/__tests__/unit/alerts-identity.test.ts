import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, insertAttempt, getDb } from '../../db.js';
import { checkAlerts } from '../../alerts.js';
import type { FastifyBaseLogger } from 'fastify';

// Alert identity (#173). `GET /api/status/alerts` recomputes the whole
// active set on every poll, so each alert needs an `id` that is stable for
// the CONDITION — otherwise the dashboard can't remember a dismissal past
// one tick — and a `task_id` so a task-specific alert can link to
// /tasks/:id. The `task_id` is the orchestrator task id, NOT the Forgejo
// `issue_id` the message quotes; every fixture below deliberately gives the
// two different values so a mix-up cannot pass.

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as FastifyBaseLogger;

beforeEach(() => {
  const db = initDatabase(':memory:');
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
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

function nMinutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

/** Find the single alert of a class, asserting there is exactly one. */
function only(alerts: Awaited<ReturnType<typeof checkAlerts>>, id: string) {
  const matching = alerts.filter((a) => a.id === id);
  expect(matching).toHaveLength(1);
  return matching[0];
}

describe('checkAlerts — alert identity', () => {
  it('keys a max-attempts failure on the task id', async () => {
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts,
            prep_failure_count, attempt, completed_at)
         VALUES (11, 501, 1, 'failed', 1, 3, 0, 3, ?)`
      )
      .run(nMinutesAgo(5));

    const alert = only(await checkAlerts(noopLog), 'failed-max:11');
    expect(alert.task_id).toBe(11);
    expect(alert.level).toBe('error');
    // The message speaks in issue numbers (what an operator recognises);
    // the link target is the task id. Both, and they differ.
    expect(alert.message).toContain('#501');
  });

  it('keys a stuck task on the task id', async () => {
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts,
            prep_failure_count, agent_profile_id, started_at)
         VALUES (12, 502, 1, 'in-progress', 1, 3, 0, 'p1', ?)`
      )
      .run(nMinutesAgo(90));
    insertAttempt({
      task_id: 12,
      attempt_number: 1,
      role: 'develop',
      status: 'running',
      started_at: nMinutesAgo(90),
      timeout_minutes_snapshot: 30,
    });

    const alert = only(await checkAlerts(noopLog), 'stuck:12');
    expect(alert.task_id).toBe(12);
    expect(alert.message).toContain('#502');
  });

  it('keys pool saturation as an aggregate with a null task_id', async () => {
    // Cap the pool at zero on both dimensions so any queued task saturates
    // it without needing a running container.
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('max_agent_memory_mb', '0')`
      )
      .run();
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('max_agent_cpu_cores', '0')`
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count)
         VALUES (13, 503, 1, 'queued', 1, 3, 0)`
      )
      .run();

    const alert = only(await checkAlerts(noopLog), 'pool-saturated');
    expect(alert.task_id).toBeNull();
  });

  it('keys an awaiting-human wait on the task id', async () => {
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts,
            prep_failure_count, completed_at)
         VALUES (14, 504, 1, 'awaiting-human-merge', 1, 3, 0, ?)`
      )
      .run(nMinutesAgo(60 * 30)); // 30h — past the 24h threshold

    const alert = only(await checkAlerts(noopLog), 'awaiting-human:14');
    expect(alert.task_id).toBe(14);
    expect(alert.message).toContain('#504');
  });

  it('collapses a prep-backoff outage into one aggregate alert', async () => {
    // Two tasks waiting out the same outage must produce ONE alert with a
    // fixed id, not one per task — there is a single thing to fix.
    for (const [id, issue] of [
      [15, 505],
      [16, 506],
    ]) {
      getDb()
        .prepare(
          `INSERT INTO tasks
             (id, issue_id, repo_id, status, queue_position, max_attempts,
              prep_failure_count, prep_backoff_level)
           VALUES (?, ?, 1, 'queued', ?, 3, 0, 2)`
        )
        .run(id, issue, id);
    }

    const alert = only(await checkAlerts(noopLog), 'git-prep-backoff');
    expect(alert.task_id).toBeNull();
    expect(alert.message).toContain('2 tasks');
  });

  it('collapses deferred salvage into one aggregate alert', async () => {
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts,
            prep_failure_count, salvage_backoff_level, salvage_next_attempt_at)
         VALUES (17, 507, 1, 'in-progress', 17, 3, 0, 2, '2126-01-01T00:00:00.000Z')`
      )
      .run();

    const alert = only(await checkAlerts(noopLog), 'salvage-deferred');
    expect(alert.task_id).toBeNull();
  });

  it('returns the same ids across consecutive polls of an unchanged condition', async () => {
    // The property dismissal depends on: nothing about the id may be
    // derived from the moment of computation.
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts,
            prep_failure_count, attempt, completed_at)
         VALUES (18, 508, 1, 'failed', 1, 3, 0, 3, ?)`
      )
      .run(nMinutesAgo(5));

    const first = (await checkAlerts(noopLog)).map((a) => a.id);
    const second = (await checkAlerts(noopLog)).map((a) => a.id);
    expect(second).toEqual(first);
    expect(first).toContain('failed-max:18');
  });

  it('gives every alert a non-empty id', async () => {
    // Guards the "someone added a seventh alert block and forgot the id"
    // regression — every class is live at once here.
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts,
            prep_failure_count, attempt, completed_at)
         VALUES (19, 509, 1, 'failed', 1, 3, 0, 3, ?)`
      )
      .run(nMinutesAgo(5));
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, issue_id, repo_id, status, queue_position, max_attempts,
            prep_failure_count, prep_backoff_level)
         VALUES (20, 510, 1, 'queued', 20, 3, 0, 1)`
      )
      .run();

    const alerts = await checkAlerts(noopLog);
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.id).toBeTruthy();
      expect(typeof alert.task_id === 'number' || alert.task_id === null).toBe(
        true
      );
    }
    // Ids are unique within one response — the client keys React rows and
    // the dismissed set on them.
    expect(new Set(alerts.map((a) => a.id)).size).toBe(alerts.length);
  });
});
