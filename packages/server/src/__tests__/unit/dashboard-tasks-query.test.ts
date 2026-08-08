/**
 * `getDashboardTasks` — the SQL push-down behind the no-status form of
 * `GET /api/tasks` (issue #177). Live (active + queued) rows must come back
 * in full in queue order; completed rows are bounded by the limit and
 * ordered by RECENCY of completion — the in-route slice this replaces ran in
 * `queue_position` order, so "recent completions" used to mean "oldest queue
 * positions".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskStatus } from '@orchestrator/shared';
import {
  initDatabase,
  insertTask,
  updateTaskRaw,
  getDashboardTasks,
} from '../../db.js';

let db: ReturnType<typeof initDatabase>;

function seedRepo(id: number): void {
  db.prepare(
    `INSERT INTO repos (id, owner, name) VALUES (?, 'owner', ?)`
  ).run(id, `repo${id}`);
}

/** Insert a task and force it into `status` (+ optional completion time). */
function seedTask(
  issue_id: number,
  status: TaskStatus,
  completed_at?: string | null
): number {
  const task = insertTask({ issue_id, repo_id: 1, status: 'queued' });
  updateTaskRaw(task.id, { status, completed_at: completed_at ?? null });
  return task.id;
}

beforeEach(() => {
  db = initDatabase(':memory:');
  seedRepo(1);
});

describe('getDashboardTasks', () => {
  it('returns every live-status row regardless of the completed limit', () => {
    const live: TaskStatus[] = [
      'preparing',
      'in-progress',
      'in-review',
      'changes-needed',
      'queued',
    ];
    const ids = live.map((status, i) => seedTask(100 + i, status));
    // Plenty of completed history that must not displace live rows.
    for (let i = 0; i < 10; i++) {
      seedTask(200 + i, 'merged', `2026-01-0${(i % 9) + 1}T00:00:00.000Z`);
    }

    const tasks = getDashboardTasks(0);
    expect(tasks.map((t) => t.id)).toEqual(ids);
  });

  it('keeps live rows in queue order, ahead of completed rows', () => {
    const completedId = seedTask(300, 'merged', '2026-02-01T00:00:00.000Z');
    const q2 = insertTask({ issue_id: 2, repo_id: 1, status: 'queued' });
    const q1 = insertTask({ issue_id: 1, repo_id: 1, status: 'queued' });
    updateTaskRaw(q1.id, { queue_position: 1 });
    updateTaskRaw(q2.id, { queue_position: 2 });

    const tasks = getDashboardTasks(5);
    expect(tasks.map((t) => t.id)).toEqual([q1.id, q2.id, completedId]);
  });

  it('bounds completed rows to the limit, most recently completed first', () => {
    // Inserted in queue order 1..4 but completed out of that order — the
    // limit must keep the RECENT completions, not the low queue positions.
    const oldest = seedTask(1, 'merged', '2026-01-01T00:00:00.000Z');
    const newest = seedTask(2, 'failed', '2026-04-01T00:00:00.000Z');
    const middle = seedTask(3, 'cancelled', '2026-02-01T00:00:00.000Z');
    const recent = seedTask(4, 'merged', '2026-03-01T00:00:00.000Z');

    expect(getDashboardTasks(2).map((t) => t.id)).toEqual([newest, recent]);
    expect(getDashboardTasks(3).map((t) => t.id)).toEqual([
      newest,
      recent,
      middle,
    ]);
    expect(getDashboardTasks(10).map((t) => t.id)).toEqual([
      newest,
      recent,
      middle,
      oldest,
    ]);
  });

  it('orders correctly across the two stored timestamp formats', () => {
    // Legacy rows carry `datetime('now')`-style timestamps (space, no Z);
    // the julianday normalization must interleave them with ISO rows.
    const legacyNewer = seedTask(1, 'merged', '2026-03-01 12:00:00');
    const isoOlder = seedTask(2, 'merged', '2026-02-01T00:00:00.000Z');

    expect(getDashboardTasks(2).map((t) => t.id)).toEqual([
      legacyNewer,
      isoOlder,
    ]);
  });

  it('sorts completed rows without a completed_at last, newest id first', () => {
    const noDateA = seedTask(1, 'reset', null);
    const dated = seedTask(2, 'merged', '2026-01-01T00:00:00.000Z');
    const noDateB = seedTask(3, 'reset', null);

    expect(getDashboardTasks(5).map((t) => t.id)).toEqual([
      dated,
      noDateB,
      noDateA,
    ]);
  });

  it('treats a non-finite limit as zero completed rows', () => {
    seedTask(1, 'merged', '2026-01-01T00:00:00.000Z');
    const queued = insertTask({ issue_id: 2, repo_id: 1, status: 'queued' });

    // Matches the old `completed.slice(0, NaN)` behaviour for a bad ?limit=.
    expect(getDashboardTasks(NaN).map((t) => t.id)).toEqual([queued.id]);
    expect(getDashboardTasks(0).map((t) => t.id)).toEqual([queued.id]);
  });
});
