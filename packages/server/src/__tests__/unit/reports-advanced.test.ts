import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { initDatabase, getDb } from '../../db.js';
import { createReportsRoutes } from '../../routes/reports.js';
import type { ForgejoClient } from '../../forgejo.js';
import type {
  ReportsDurations,
  ReportsFunnel,
  ReportsReliability,
  ReportsHeatmap,
} from '@orchestrator/shared';

/** Advanced reports aggregation tests (durations distribution, lifecycle
 *  funnel, reliability/ops, activity heatmap).
 *
 *  The fixture seeds two repos with a handful of tasks whose lifecycle is
 *  expressed through `status_*` timeline events (the same events
 *  updateTaskWithSync writes on each transition), a spread of develop/review
 *  attempt durations for percentile math, reliability incidents
 *  (container_timeout_kill / orphan_* / review_deferred) and prep-failure
 *  counters, plus created/merged timestamps placed at known UTC weekday/hour
 *  slots for the heatmap. Some rows sit OUTSIDE the window or repo to prove
 *  the filters bite. Mixed timestamp shapes exercise SQL normalization.
 */

const FROM = '2025-01-01T00:00:00.000Z';
const TO = '2025-02-01T00:00:00.000Z';

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r1')`).run();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'o', 'r2')`).run();

  const task = db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, prep_failure_count, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
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

  // --- repo 1 cohort (created in Jan) ---
  // T1: full lifecycle to merged. Created Wed 2025-01-01 09:00 UTC.
  task.run(1, 1, 1, 'merged', 0, '2025-01-01T09:00:00.000Z', '2025-01-02T09:00:00.000Z');
  event.run(1, 'status_preparing', 'Preparing', '2025-01-01T09:01:00.000Z');
  event.run(1, 'status_in-progress', 'Impl started', '2025-01-01T09:05:00.000Z');
  event.run(1, 'status_in-review', 'Review started', '2025-01-01T10:00:00.000Z');
  event.run(1, 'status_merged', 'Merged', '2025-01-02T09:00:00.000Z');
  // develop durations for sonnet/claude-sdk: 100s, 200s, 300s, 400s spread.
  attempt.run(1, 1, 'develop', 'completed', null, '2025-01-01T09:05:00.000Z', '2025-01-01 09:06:40', 'sonnet', 'claude-sdk'); // 100s (mixed fmt)
  attempt.run(1, 2, 'develop', 'completed', null, '2025-01-01T09:10:00.000Z', '2025-01-01T09:13:20.000Z', 'sonnet', 'claude-sdk'); // 200s
  attempt.run(1, 3, 'develop', 'completed', null, '2025-01-01T09:20:00.000Z', '2025-01-01T09:25:00.000Z', 'sonnet', 'claude-sdk'); // 300s
  attempt.run(1, 4, 'develop', 'completed', null, '2025-01-01T09:30:00.000Z', '2025-01-01T09:36:40.000Z', 'sonnet', 'claude-sdk'); // 400s
  attempt.run(1, 1, 'review', 'completed', 'approved', '2025-01-01T10:00:00.000Z', '2025-01-01T10:10:00.000Z', 'sonnet', 'claude-sdk'); // 600s

  // T2: reached in-review but did not merge (failed there). Created Thu 2025-01-02 14:00 UTC.
  task.run(2, 2, 1, 'failed', 2, '2025-01-02T14:00:00.000Z', '2025-01-03T00:00:00.000Z');
  event.run(2, 'status_preparing', 'Preparing', '2025-01-02T14:01:00.000Z');
  event.run(2, 'status_in-progress', 'Impl started', '2025-01-02T14:05:00.000Z');
  event.run(2, 'status_in-review', 'Review started', '2025-01-02T15:00:00.000Z');
  // reliability incidents on T2.
  event.run(2, 'container_timeout_kill', 'killed', '2025-01-02T16:00:00.000Z');
  event.run(2, 'orphan_detected', 'orphan', '2025-01-02T16:30:00.000Z');
  event.run(2, 'orphan_recovery_triggered', 'recovering', '2025-01-02T16:31:00.000Z');
  event.run(2, 'review_deferred', 'deferred', '2025-01-02T17:00:00.000Z');

  // T3: only reached preparing, then dropped. Created Fri 2025-01-03 02:00 UTC.
  task.run(3, 3, 1, 'queued', 1, '2025-01-03T02:00:00.000Z', null);
  event.run(3, 'status_preparing', 'Preparing', '2025-01-03T02:01:00.000Z');
  event.run(3, 'orphan_recovery_exhausted', 'gave up', '2025-01-03T03:00:00.000Z');

  // --- repo 2 cohort ---
  // T4: merged, harness opencode. Created Wed 2025-01-01 09:30 UTC (same heatmap slot as T1).
  task.run(4, 4, 2, 'merged', 0, '2025-01-01T09:30:00.000Z', '2025-01-05T09:00:00.000Z');
  event.run(4, 'status_preparing', 'Preparing', '2025-01-01T09:31:00.000Z');
  event.run(4, 'status_in-progress', 'Impl started', '2025-01-01T09:35:00.000Z');
  event.run(4, 'status_in-review', 'Review started', '2025-01-01T11:00:00.000Z');
  event.run(4, 'status_merged', 'Merged', '2025-01-05T09:00:00.000Z');
  attempt.run(4, 1, 'develop', 'completed', null, '2025-01-01T09:35:00.000Z', '2025-01-01T09:43:20.000Z', 'gpt-4o', 'opencode'); // 500s
  event.run(4, 'container_timeout_kill', 'killed', '2025-01-01T12:00:00.000Z');

  // --- out of window ---
  // T5: repo 1 but created in Feb — excluded from the cohort + the heatmap.
  task.run(5, 5, 1, 'merged', 9, '2025-02-15T09:00:00.000Z', '2025-02-16T09:00:00.000Z');
  event.run(5, 'status_merged', 'Merged', '2025-02-16T09:00:00.000Z');
  event.run(5, 'container_timeout_kill', 'killed', '2025-02-15T10:00:00.000Z');
}

async function buildApp(): Promise<FastifyInstance> {
  initDatabase(':memory:');
  seed();
  const app = Fastify({ logger: false });
  await app.register(createReportsRoutes({} as unknown as ForgejoClient));
  await app.ready();
  return app;
}

const Q = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

describe('GET /api/reports/durations', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('rejects an unknown groupBy or metric', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/reports/durations?groupBy=repo&metric=implementation&${Q}`,
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/reports/durations?groupBy=model&metric=bogus&${Q}`,
        })
      ).statusCode
    ).toBe(400);
  });

  it('computes nearest-rank p50/p90/p99 + min/max/avg per model (repo 1 impl)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/durations?groupBy=model&metric=implementation&repos=1&${Q}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsDurations;
    expect(body.metric).toBe('implementation');

    const sonnet = body.groups.find((g) => g.key === 'sonnet')!;
    expect(sonnet).toBeDefined();
    // develop durations: [100, 200, 300, 400]. nearest-rank over n=4.
    expect(sonnet.count).toBe(4);
    expect(sonnet.min_seconds).toBeCloseTo(100, 1);
    expect(sonnet.max_seconds).toBeCloseTo(400, 1);
    expect(sonnet.avg_seconds).toBeCloseTo(250, 1);
    // p50 → ceil(0.5*4)=2 → 200; p90 → ceil(0.9*4)=4 → 400; p99 → 4 → 400.
    expect(sonnet.p50_seconds).toBeCloseTo(200, 1);
    expect(sonnet.p90_seconds).toBeCloseTo(400, 1);
    expect(sonnet.p99_seconds).toBeCloseTo(400, 1);
  });

  it('groups review durations by harness', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/durations?groupBy=harness&metric=review&repos=1&${Q}`,
    });
    const body = res.json() as ReportsDurations;
    const sdk = body.groups.find((g) => g.key === 'claude-sdk')!;
    expect(sdk.count).toBe(1); // single review attempt, 600s
    expect(sdk.p50_seconds).toBeCloseTo(600, 1);
  });
});

describe('GET /api/reports/funnel', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('counts created→preparing→in-progress→in-review→merged with conversions (repo 1)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/funnel?repos=1&${Q}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsFunnel;

    const byStage = Object.fromEntries(body.stages.map((s) => [s.stage, s]));
    // Cohort = T1, T2, T3 (repo 1, created in Jan).
    expect(byStage.created.count).toBe(3);
    expect(byStage.preparing.count).toBe(3); // T1, T2, T3
    expect(byStage['in-progress'].count).toBe(2); // T1, T2
    expect(byStage['in-review'].count).toBe(2); // T1, T2
    expect(byStage.merged.count).toBe(1); // T1

    // Conversions.
    expect(byStage.created.pct_of_created).toBeCloseTo(1, 6);
    expect(byStage.merged.pct_of_created).toBeCloseTo(1 / 3, 6);
    // step conversion in-review → merged = 1/2.
    expect(byStage.merged.pct_of_previous).toBeCloseTo(0.5, 6);
    expect(byStage.created.pct_of_previous).toBeNull();
  });

  it('respects the repo filter / counts all repos when omitted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/funnel?${Q}`,
    });
    const body = res.json() as ReportsFunnel;
    const byStage = Object.fromEntries(body.stages.map((s) => [s.stage, s]));
    // T1, T2, T3 (repo1) + T4 (repo2) created in Jan → 4 created, 2 merged.
    expect(byStage.created.count).toBe(4);
    expect(byStage.merged.count).toBe(2);
  });
});

describe('GET /api/reports/reliability', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('counts incidents, sums prep failures, and breaks down per repo (all repos)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/reliability?${Q}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsReliability;

    // In-window events: T2 (timeout, detected, recovered, deferred), T3
    // (exhausted), T4 (timeout). T5's timeout is in Feb → excluded.
    expect(body.counts.timeout_kills).toBe(2);
    expect(body.counts.orphans_detected).toBe(1);
    expect(body.counts.orphans_recovered).toBe(1);
    expect(body.counts.orphans_exhausted).toBe(1);
    expect(body.counts.review_deferrals).toBe(1);
    // Prep failures sum over cohort tasks (T2=2, T3=1, repo2 T4=0). T5 is
    // out of window so its 9 is excluded.
    expect(body.counts.prep_failures).toBe(3);

    // Per-repo: repo 1 carries most incidents.
    const r1 = body.by_repo.find((r) => r.key === '1')!;
    expect(r1.label).toBe('o/r1');
    expect(r1.timeout_kills).toBe(1);
    expect(r1.prep_failures).toBe(3);
    const r2 = body.by_repo.find((r) => r.key === '2')!;
    expect(r2.timeout_kills).toBe(1);
  });

  it('narrows incidents by repo filter and zero-fills the series', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/reliability?repos=2&bucket=day&${Q}`,
    });
    const body = res.json() as ReportsReliability;
    expect(body.counts.timeout_kills).toBe(1); // only T4's
    expect(body.counts.orphans_detected).toBe(0);
    // Series spans Jan 1..31 (zero-filled), with the one incident on Jan 1.
    expect(body.series).toHaveLength(31);
    const jan1 = body.series.find((b) => b.bucket === '2025-01-01')!;
    expect(jan1.timeout_kills).toBe(1);
    const seriesTotal = body.series.reduce((s, b) => s + b.timeout_kills, 0);
    expect(seriesTotal).toBe(1);
  });
});

describe('GET /api/reports/heatmap', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('buckets created activity by UTC dow × hour (all repos)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/heatmap?metric=created&${Q}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReportsHeatmap;
    expect(body.metric).toBe('created');

    // T1 (Wed 09:00) + T4 (Wed 09:30) share dow=3, hour=9 → count 2.
    // 2025-01-01 is a Wednesday → strftime('%w') = 3.
    const wed9 = body.cells.find((c) => c.dow === 3 && c.hour === 9)!;
    expect(wed9.count).toBe(2);
    expect(body.max).toBe(2);
    // T2 (Thu 14:00) → dow=4, hour=14, count 1.
    const thu14 = body.cells.find((c) => c.dow === 4 && c.hour === 14)!;
    expect(thu14.count).toBe(1);
    // T5 (Feb) excluded from the window → no Feb activity leaks in.
    const total = body.cells.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(4); // T1..T4 created in Jan
  });

  it('buckets merged activity (completed_at of merged tasks only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/heatmap?metric=merged&repos=1&${Q}`,
    });
    const body = res.json() as ReportsHeatmap;
    // Only T1 merged within repo 1 in window: completed Thu 2025-01-02 09:00.
    const total = body.cells.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(1);
    const thu9 = body.cells.find((c) => c.dow === 4 && c.hour === 9)!;
    expect(thu9.count).toBe(1);
  });
});
