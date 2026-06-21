import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb, getReportTasks } from '../../db.js';
import type { ReportFilter } from '@orchestrator/shared';

/** Unit tests for `getReportTasks` — the SQL-backed All Tasks browser.
 *
 *  Covers repo/date/status/search filtering, sorting, offset/limit
 *  pagination, the total count (which must stay constant across pages),
 *  and the model/harness + develop-attempt derivation from the attempts
 *  table. No Forgejo derivation runs here — that is the route's job and is
 *  applied to the returned page only.
 */

// Window under test: all of January 2025 (from inclusive, to exclusive).
const FROM = '2025-01-01T00:00:00.000Z';
const TO = '2025-02-01T00:00:00.000Z';

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r1')`).run();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'o', 'r2')`).run();

  const task = db.prepare(
    `INSERT INTO tasks (id, issue_id, issue_title, repo_id, status, attempt, max_attempts, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const attempt = db.prepare(
    `INSERT INTO attempts
       (task_id, attempt_number, role, status, verdict, started_at, completed_at, model_id, harness_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // repo 1, in-window. Created across January; completed varies (some null).
  task.run(1, 101, 'Add login page', 1, 'merged', 1, 3, '2025-01-05 00:00:00', '2025-01-06T00:00:00.000Z');
  attempt.run(1, 1, 'develop', 'completed', null, '2025-01-05T10:00:00.000Z', '2025-01-05T11:00:00.000Z', 'claude-sonnet-4-6', 'claude-sdk');
  attempt.run(1, 1, 'review', 'completed', 'approved', '2025-01-05T12:00:00.000Z', '2025-01-05T12:30:00.000Z', 'claude-sonnet-4-6', 'claude-sdk');

  // Two develop attempts (rework) — attempts count should be 2, model/harness
  // from the LATEST develop attempt (claude-opus-4-7 / claude-code).
  task.run(2, 202, 'Fix flaky test', 1, 'failed', 2, 3, '2025-01-10 00:00:00', '2025-01-12T00:00:00.000Z');
  attempt.run(2, 1, 'develop', 'completed', null, '2025-01-10T10:00:00.000Z', '2025-01-10T11:30:00.000Z', 'claude-opus-4-7', 'claude-code');
  attempt.run(2, 2, 'develop', 'failed', null, '2025-01-11T10:00:00.000Z', '2025-01-11T12:00:00.000Z', 'claude-opus-4-7', 'claude-code');

  task.run(3, 303, 'Update README', 1, 'cancelled', 0, 3, '2025-01-20 00:00:00', null);
  task.run(4, 404, 'Add metrics', 1, 'queued', 0, 3, '2025-01-25 00:00:00', null);

  // repo 2, in-window — excluded by a repos=[1] filter.
  task.run(5, 505, 'Port to Vite', 2, 'merged', 1, 3, '2025-01-08 00:00:00', '2025-01-09T00:00:00.000Z');
  attempt.run(5, 1, 'develop', 'completed', null, '2025-01-08T10:00:00.000Z', '2025-01-08T11:00:00.000Z', 'gpt-4o', 'opencode');

  // repo 1 but created AFTER the window — excluded by the date filter.
  task.run(6, 606, 'Future work', 1, 'merged', 1, 3, '2025-02-15 00:00:00', '2025-02-16T00:00:00.000Z');
}

function filter(repos: number[] | null = null): ReportFilter {
  return { repos, from: FROM, to: TO };
}

describe('getReportTasks', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    seed();
  });

  it('returns the in-window cohort, most-recent first, with total count', () => {
    const { total, tasks } = getReportTasks(filter());
    // T1..T5 are in window (T6 is February). repos=null = all repos.
    expect(total).toBe(5);
    expect(tasks).toHaveLength(5);
    // created_desc default: T4 (Jan 25) … T5 (Jan 08).
    expect(tasks.map((t) => t.id)).toEqual([4, 3, 2, 5, 1]);
  });

  it('narrows by repo', () => {
    const { total, tasks } = getReportTasks(filter([1]));
    expect(total).toBe(4); // T1..T4 (repo 1, in window)
    expect(tasks.every((t) => t.repo_id === 1)).toBe(true);
    expect(tasks.map((t) => t.id)).toEqual([4, 3, 2, 1]);
  });

  it('narrows by status', () => {
    const { total, tasks } = getReportTasks(filter(), { status: 'merged' });
    expect(total).toBe(2); // T1 (repo1) + T5 (repo2)
    expect(tasks.map((t) => t.id).sort()).toEqual([1, 5]);
    expect(tasks.every((t) => t.status === 'merged')).toBe(true);
  });

  it('searches by issue number and by title (case-insensitive, # tolerant)', () => {
    const byNumber = getReportTasks(filter(), { search: '202' });
    expect(byNumber.total).toBe(1);
    expect(byNumber.tasks[0].id).toBe(2);

    const byHash = getReportTasks(filter(), { search: '#202' });
    expect(byHash.total).toBe(1);
    expect(byHash.tasks[0].id).toBe(2);

    const byTitle = getReportTasks(filter(), { search: 'readme' });
    expect(byTitle.total).toBe(1);
    expect(byTitle.tasks[0].id).toBe(3);

    const noMatch = getReportTasks(filter(), { search: 'nonexistent' });
    expect(noMatch.total).toBe(0);
    expect(noMatch.tasks).toHaveLength(0);
  });

  it('paginates with offset/limit while keeping a stable total', () => {
    const p1 = getReportTasks(filter(), { offset: 0, limit: 2 });
    expect(p1.total).toBe(5);
    expect(p1.limit).toBe(2);
    expect(p1.offset).toBe(0);
    expect(p1.tasks.map((t) => t.id)).toEqual([4, 3]);

    const p2 = getReportTasks(filter(), { offset: 2, limit: 2 });
    expect(p2.total).toBe(5); // total ignores pagination
    expect(p2.tasks.map((t) => t.id)).toEqual([2, 5]);

    const p3 = getReportTasks(filter(), { offset: 4, limit: 2 });
    expect(p3.total).toBe(5);
    expect(p3.tasks.map((t) => t.id)).toEqual([1]); // last partial page
  });

  it('clamps limit/offset to safe bounds', () => {
    const huge = getReportTasks(filter(), { limit: 100_000, offset: -5 });
    expect(huge.limit).toBe(200); // MAX_REPORT_TASKS_LIMIT
    expect(huge.offset).toBe(0);

    const zero = getReportTasks(filter(), { limit: 0 });
    expect(zero.limit).toBe(1); // floor of 1
  });

  it('sorts by created ascending and by completion', () => {
    const asc = getReportTasks(filter(), { sort: 'created_asc' });
    expect(asc.tasks.map((t) => t.id)).toEqual([1, 5, 2, 3, 4]);

    // completed_desc: completed tasks first (newest completion first), then
    // the null-completion tasks at the bottom.
    const comp = getReportTasks(filter(), { sort: 'completed_desc' });
    const ids = comp.tasks.map((t) => t.id);
    // T2 completed Jan 12, T5 Jan 09, T1 Jan 06 — then T3/T4 (null) last.
    expect(ids.slice(0, 3)).toEqual([2, 5, 1]);
    expect(ids.slice(3).sort()).toEqual([3, 4]);
  });

  it('derives attempts count and model/harness from the latest develop attempt', () => {
    const { tasks } = getReportTasks(filter([1]));
    const byId = new Map(tasks.map((t) => [t.id, t]));

    const t1 = byId.get(1)!;
    expect(t1.attempts).toBe(1);
    expect(t1.model_id).toBe('claude-sonnet-4-6');
    expect(t1.harness_id).toBe('claude-sdk');

    const t2 = byId.get(2)!;
    expect(t2.attempts).toBe(2); // two develop attempts
    expect(t2.model_id).toBe('claude-opus-4-7');
    expect(t2.harness_id).toBe('claude-code');

    // Task with no attempts → null model/harness, 0 attempts.
    const t3 = byId.get(3)!;
    expect(t3.attempts).toBe(0);
    expect(t3.model_id).toBeNull();
    expect(t3.harness_id).toBeNull();
  });
});
