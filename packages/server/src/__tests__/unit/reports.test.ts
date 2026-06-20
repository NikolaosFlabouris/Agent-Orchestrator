import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { initDatabase, getDb } from '../../db.js';
import { reportsRoutes } from '../../routes/reports.js';
import type {
  ReportsOverview,
  ReportsTimeseries,
  ReportsLeaderboard,
} from '@orchestrator/shared';

/** Reports API aggregation tests.
 *
 *  A small fixture seeds two repos with merged / failed / cancelled /
 *  multi-attempt-rework tasks plus develop+review attempts (model/harness
 *  snapshots, review verdicts), and some rows deliberately OUTSIDE the repo
 *  or date window. The assertions pin status counts, success rate,
 *  duration mean + p50/p90, rework average, throughput/backlog, timeseries
 *  bucketing, and leaderboard grouping by model / harness / repo.
 *
 *  The fixture mixes the two stored timestamp shapes (space-separated
 *  datetime('now') and ISO toISOString()) so the SQL normalization is
 *  exercised end-to-end.
 */

// Window under test: all of January 2025 (from inclusive, to exclusive).
const FROM = '2025-01-01T00:00:00.000Z';
const TO = '2025-02-01T00:00:00.000Z';

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r1')`).run();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'o', 'r2')`).run();

  const task = db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const attempt = db.prepare(
    `INSERT INTO attempts
       (task_id, attempt_number, role, status, verdict, started_at, completed_at, model_id, harness_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const event = db.prepare(
    `INSERT INTO task_events (task_id, event_type, message, created_at)
     VALUES (?, ?, ?, ?)`
  );

  // --- repo 1, in-window cohort ---
  // T1: merged, 1 develop pass + approved review. lead = 1 day.
  task.run(1, 1, 1, 'merged', '2025-01-05 00:00:00', '2025-01-06T00:00:00.000Z');
  attempt.run(1, 1, 'develop', 'completed', null, '2025-01-05T10:00:00.000Z', '2025-01-05T11:00:00.000Z', 'claude-sonnet-4-6', 'claude-sdk'); // 3600s
  attempt.run(1, 1, 'review', 'completed', 'approved', '2025-01-05 12:00:00', '2025-01-05T12:30:00.000Z', 'claude-sonnet-4-6', 'claude-sdk'); // 1800s (mixed fmt)

  // T2: merged, reworked once (2 develop) + changes_needed then approved. lead = 3 days.
  task.run(2, 2, 1, 'merged', '2025-01-10 00:00:00', '2025-01-13T00:00:00.000Z');
  attempt.run(2, 1, 'develop', 'completed', null, '2025-01-10T10:00:00.000Z', '2025-01-10T11:30:00.000Z', 'claude-opus-4-7', 'claude-code'); // 5400s
  attempt.run(2, 2, 'develop', 'completed', null, '2025-01-11T10:00:00.000Z', '2025-01-11T12:00:00.000Z', 'claude-opus-4-7', 'claude-code'); // 7200s
  attempt.run(2, 1, 'review', 'completed', 'changes_needed', '2025-01-12T10:00:00.000Z', '2025-01-12T10:30:00.000Z', 'claude-opus-4-7', 'claude-code'); // 1800s
  attempt.run(2, 2, 'review', 'completed', 'approved', '2025-01-12T14:00:00.000Z', '2025-01-12T14:15:00.000Z', 'claude-opus-4-7', 'claude-code'); // 900s

  // T3: failed, 1 develop + unclear review.
  task.run(3, 3, 1, 'failed', '2025-01-15 00:00:00', '2025-01-15T05:00:00.000Z');
  attempt.run(3, 1, 'develop', 'failed', null, '2025-01-15T01:00:00.000Z', '2025-01-15T02:00:00.000Z', 'claude-sonnet-4-6', 'claude-sdk'); // 3600s
  attempt.run(3, 1, 'review', 'completed', 'unclear', '2025-01-15T03:00:00.000Z', '2025-01-15T03:45:00.000Z', 'claude-sonnet-4-6', 'claude-sdk'); // 2700s

  // T4: cancelled, no attempts.
  task.run(4, 4, 1, 'cancelled', '2025-01-20 00:00:00', null);

  // T5: queued + blocked (unsatisfied dependency).
  task.run(5, 5, 1, 'queued', '2025-01-25 00:00:00', null);
  db.prepare(
    `INSERT INTO task_dependencies (task_id, dep_issue_number, state) VALUES (5, 99, 'open')`
  ).run();

  // T6: queued, no deps (not blocked).
  task.run(6, 6, 1, 'queued', '2025-01-26 00:00:00', null);

  // A few lifecycle events across the cohort. No report metric reads these
  // today (the v28 task_events index is forward-looking infra for later
  // reporting tasks), but the fixture seeds them so it represents the full
  // task/attempt/event surface.
  event.run(1, 'created', 'queued', '2025-01-05T00:00:00.000Z');
  event.run(1, 'review_verdict', 'Review verdict: approved', '2025-01-05T12:30:00.000Z');
  event.run(2, 'created', 'queued', '2025-01-10T00:00:00.000Z');
  event.run(3, 'status_change', 'failed', '2025-01-15T05:00:00.000Z');

  // --- out of window / other repo ---
  // T7: repo 1 but created AFTER the window — excluded from the cohort.
  task.run(7, 7, 1, 'merged', '2025-02-15 00:00:00', '2025-02-16T00:00:00.000Z');
  attempt.run(7, 1, 'develop', 'completed', null, '2025-02-15T10:00:00.000Z', '2025-02-15T12:00:00.000Z', 'claude-sonnet-4-6', 'claude-sdk');

  // T8: repo 2, in window — excluded by a repos=[1] filter, included otherwise.
  task.run(8, 8, 2, 'merged', '2025-01-08 00:00:00', '2025-01-09T00:00:00.000Z');
  attempt.run(8, 1, 'develop', 'completed', null, '2025-01-08T10:00:00.000Z', '2025-01-08T11:00:00.000Z', 'gpt-4o', 'opencode'); // 3600s
  attempt.run(8, 1, 'review', 'completed', 'approved', '2025-01-08T12:00:00.000Z', '2025-01-08T12:30:00.000Z', 'gpt-4o', 'opencode');
}

async function buildApp(): Promise<FastifyInstance> {
  initDatabase(':memory:');
  seed();
  const app = Fastify({ logger: false });
  await app.register(reportsRoutes);
  await app.ready();
  return app;
}

const Q = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

describe('GET /api/reports/overview', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('aggregates status counts, success rate, durations, rework (repo 1, Jan)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/overview?repos=1&${Q}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsOverview;

    // Cohort = T1..T6 (repo1, created in Jan). T7 (Feb) and T8 (repo2) excluded.
    expect(body.total_tasks).toBe(6);
    expect(body.status_counts.merged).toBe(2);
    expect(body.status_counts.failed).toBe(1);
    expect(body.status_counts.cancelled).toBe(1);
    expect(body.status_counts.queued).toBe(2);

    // success = merged / (merged+failed+cancelled) = 2 / 4.
    expect(body.success_rate).toBeCloseTo(0.5, 6);
    expect(body.terminal_counts).toEqual({ merged: 2, failed: 1, cancelled: 1 });

    // throughput.merged counts completed_at-in-window merged tasks (T1, T2).
    expect(body.throughput.tasks_created).toBe(6);
    expect(body.throughput.tasks_merged).toBe(2);

    // backlog: 2 queued, 1 of which is blocked (T5).
    expect(body.backlog).toEqual({ queued: 2, blocked: 1 });

    // Implementation durations: [3600, 3600, 5400, 7200].
    expect(body.implementation_duration.count).toBe(4);
    expect(body.implementation_duration.avg_seconds).toBeCloseTo(4950, 1);
    expect(body.implementation_duration.p50_seconds).toBeCloseTo(3600, 1);
    expect(body.implementation_duration.p90_seconds).toBeCloseTo(7200, 1);

    // Review durations: [900, 1800, 1800, 2700].
    expect(body.review_duration.count).toBe(4);
    expect(body.review_duration.avg_seconds).toBeCloseTo(1800, 1);
    expect(body.review_duration.p50_seconds).toBeCloseTo(1800, 1);
    expect(body.review_duration.p90_seconds).toBeCloseTo(2700, 1);

    // Lead time (merged): T1 = 86400, T2 = 259200.
    expect(body.lead_time.count).toBe(2);
    expect(body.lead_time.avg_seconds).toBeCloseTo(172800, 1);
    expect(body.lead_time.p50_seconds).toBeCloseTo(86400, 1);
    expect(body.lead_time.p90_seconds).toBeCloseTo(259200, 1);

    // Rework: develop counts T1=1, T2=2, T3=1 over 3 implemented tasks.
    expect(body.rework.task_count).toBe(3);
    expect(body.rework.avg).toBeCloseTo(4 / 3, 6);
  });

  it('narrows by repo filter (repo 2 only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/overview?repos=2&${Q}`,
    });
    const body = res.json() as ReportsOverview;
    // Only T8 is in repo 2 within the window.
    expect(body.total_tasks).toBe(1);
    expect(body.status_counts.merged).toBe(1);
    expect(body.implementation_duration.count).toBe(1);
  });

  it('includes all repos when repos is omitted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/overview?${Q}`,
    });
    const body = res.json() as ReportsOverview;
    // T1..T6 + T8 (T7 is out of window). 7 tasks.
    expect(body.total_tasks).toBe(7);
    expect(body.status_counts.merged).toBe(3);
  });

  it('excludes rows outside the date window', async () => {
    // A February-only window catches just T7.
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/overview?from=${encodeURIComponent('2025-02-01T00:00:00.000Z')}&to=${encodeURIComponent('2025-03-01T00:00:00.000Z')}`,
    });
    const body = res.json() as ReportsOverview;
    expect(body.total_tasks).toBe(1);
    expect(body.status_counts.merged).toBe(1);
  });
});

describe('GET /api/reports/timeseries', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('buckets created/merged per day across the range (zero-filled)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/timeseries?bucket=day&repos=1&${Q}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsTimeseries;
    expect(body.bucket).toBe('day');
    // Jan 1..31 inclusive (to is exclusive) → 31 zero-filled day buckets.
    expect(body.series).toHaveLength(31);

    const created = body.series.reduce((s, b) => s + b.tasks_created, 0);
    const merged = body.series.reduce((s, b) => s + b.tasks_merged, 0);
    expect(created).toBe(6);
    expect(merged).toBe(2);

    const jan5 = body.series.find((b) => b.bucket === '2025-01-05');
    expect(jan5?.tasks_created).toBe(1);
    const jan6 = body.series.find((b) => b.bucket === '2025-01-06');
    expect(jan6?.tasks_merged).toBe(1);
  });

  it('supports weekly bucketing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/timeseries?bucket=week&repos=1&${Q}`,
    });
    const body = res.json() as ReportsTimeseries;
    expect(body.bucket).toBe('week');
    // Buckets are Monday-anchored YYYY-MM-DD dates.
    for (const b of body.series) {
      expect(b.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const created = body.series.reduce((s, b) => s + b.tasks_created, 0);
    expect(created).toBe(6);
  });
});

describe('GET /api/reports/leaderboard', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('rejects an unknown groupBy', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/leaderboard?groupBy=bogus&${Q}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('groups by model with per-attempt snapshots (repo 1)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/leaderboard?groupBy=model&repos=1&${Q}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsLeaderboard;
    expect(body.group_by).toBe('model');

    const sonnet = body.rows.find((r) => r.key === 'claude-sonnet-4-6');
    const opus = body.rows.find((r) => r.key === 'claude-opus-4-7');
    expect(sonnet).toBeDefined();
    expect(opus).toBeDefined();

    // sonnet touched T1 (merged) + T3 (failed).
    expect(sonnet!.task_count).toBe(2);
    expect(sonnet!.success_rate).toBeCloseTo(0.5, 6);
    expect(sonnet!.avg_implementation_seconds).toBeCloseTo(3600, 1); // [3600,3600]
    expect(sonnet!.avg_review_seconds).toBeCloseTo(2250, 1); // [1800,2700]
    expect(sonnet!.avg_rework).toBeCloseTo(1, 6);
    expect(sonnet!.verdicts).toEqual({
      approved: 1,
      changes_needed: 0,
      unclear: 1,
    });

    // opus touched only T2 (merged), reworked once.
    expect(opus!.task_count).toBe(1);
    expect(opus!.success_rate).toBeCloseTo(1, 6);
    expect(opus!.avg_implementation_seconds).toBeCloseTo(6300, 1); // [5400,7200]
    expect(opus!.avg_review_seconds).toBeCloseTo(1350, 1); // [1800,900]
    expect(opus!.avg_rework).toBeCloseTo(2, 6);
    expect(opus!.verdicts).toEqual({
      approved: 1,
      changes_needed: 1,
      unclear: 0,
    });
  });

  it('groups by harness (repo 1)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/leaderboard?groupBy=harness&repos=1&${Q}`,
    });
    const body = res.json() as ReportsLeaderboard;
    const sdk = body.rows.find((r) => r.key === 'claude-sdk');
    const code = body.rows.find((r) => r.key === 'claude-code');
    expect(sdk!.task_count).toBe(2); // T1, T3
    expect(sdk!.avg_implementation_seconds).toBeCloseTo(3600, 1);
    expect(code!.task_count).toBe(1); // T2
    expect(code!.avg_rework).toBeCloseTo(2, 6);
  });

  it('aggregates avg turns / avg+total tokens, excluding NULL-usage attempts', async () => {
    // Attach per-run usage (#115) to only TWO of sonnet's four attempts in
    // repo 1 (T1 develop + T1 review); T3's attempts stay NULL. The averages
    // must divide by the two rows that reported usage, not by all four — a
    // NULL must not be read as a 0.
    const db = getDb();
    db.prepare(
      `UPDATE attempts SET num_turns = 10, input_tokens = 1000, output_tokens = 500
         WHERE task_id = 1 AND role = 'develop' AND attempt_number = 1`
    ).run();
    db.prepare(
      `UPDATE attempts SET num_turns = 2, input_tokens = 200, output_tokens = 100
         WHERE task_id = 1 AND role = 'review' AND attempt_number = 1`
    ).run();

    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/leaderboard?groupBy=model&repos=1&${Q}`,
    });
    const body = res.json() as ReportsLeaderboard;

    const sonnet = body.rows.find((r) => r.key === 'claude-sonnet-4-6')!;
    // avg over the two rows that reported usage: turns (10,2) → 6.
    expect(sonnet.avg_num_turns).toBeCloseTo(6, 6);
    // total tokens per row (1500, 300) → avg 900.
    expect(sonnet.avg_total_tokens).toBeCloseTo(900, 6);
    // sums are over all reported rows.
    expect(sonnet.total_input_tokens).toBe(1200);
    expect(sonnet.total_output_tokens).toBe(600);

    // opus reported no usage → averages NULL (unknown), totals 0 (not NULL).
    const opus = body.rows.find((r) => r.key === 'claude-opus-4-7')!;
    expect(opus.avg_num_turns).toBeNull();
    expect(opus.avg_total_tokens).toBeNull();
    expect(opus.total_input_tokens).toBe(0);
    expect(opus.total_output_tokens).toBe(0);
  });

  it('groups by repo across all repos, with owner/name labels', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/leaderboard?groupBy=repo&${Q}`,
    });
    const body = res.json() as ReportsLeaderboard;
    const r1 = body.rows.find((r) => r.key === '1');
    const r2 = body.rows.find((r) => r.key === '2');
    expect(r1?.label).toBe('o/r1');
    expect(r2?.label).toBe('o/r2');
    // repo 1 cohort = T1..T6 (6 tasks); repo 2 = T8 (1 task).
    expect(r1!.task_count).toBe(6);
    expect(r1!.success_rate).toBeCloseTo(0.5, 6);
    expect(r2!.task_count).toBe(1);
    expect(r2!.success_rate).toBeCloseTo(1, 6);
  });
});
