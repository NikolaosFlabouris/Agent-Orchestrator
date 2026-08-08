/**
 * Golden-equality guard for the batched TaskViewContext (issue #177).
 *
 * `task-view.ts` is the single serializer feeding BOTH `GET /api/tasks` and
 * every dashboard WebSocket payload, so the batched lookups (`runningAttempts`
 * / `repos` maps built once per list) must produce byte-identical views to
 * the per-task-query path for the same data. These tests build one fixture
 * set covering the status/attempt/profile/dependency combinations and assert
 * deep equality between the two paths for every task — plus that the WS
 * snapshot path really does stop issuing per-task attempt queries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';

// Spy on the per-task queries so the batched path's query discipline is
// observable, while keeping the real implementations.
vi.mock('../../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db.js')>();
  return {
    ...actual,
    getAttempts: vi.fn(actual.getAttempts),
    getActiveAttempt: vi.fn(actual.getActiveAttempt),
    getRepo: vi.fn(actual.getRepo),
  };
});

const {
  initDatabase,
  insertTask,
  updateTaskRaw,
  updateSetting,
  insertAttempt,
  updateAttempt,
  upsertTaskDependency,
  getTasks,
  getAttempts,
  getActiveAttempt,
  getRepo,
} = await import('../../db.js');
const { enrichTask, loadProfileDefaults, loadTaskViewBatches, buildTaskView } =
  await import('../../task-view.js');
const { buildSnapshot } = await import('../../ws/dashboard.js');
const { _clearSnapshotCache } = await import('../../forgejo-snapshot.js');

let db: ReturnType<typeof initDatabase>;

function seedRepo(
  id: number,
  profiles: { agent?: string | null; review?: string | null } = {}
): void {
  db.prepare(
    `INSERT INTO repos (id, owner, name, agent_profile_id, review_agent_profile_id)
     VALUES (?, 'owner', ?, ?, ?)`
  ).run(id, `repo${id}`, profiles.agent ?? null, profiles.review ?? null);
}

function seedProfile(id: string): string {
  db.prepare(
    `INSERT INTO agent_profiles (id, display_name, harness_id, model_pk, config_json, timeout_minutes)
     SELECT ?, ?, harness_id, model_pk, '{}', timeout_minutes
       FROM agent_profiles WHERE id = 'default-claude-sdk'`
  ).run(id, id);
  return id;
}

/** A fixture set exercising every branch the serializer takes: all live and
 *  terminal statuses, tasks with/without running attempts, completed attempt
 *  history with feedback blobs, per-tier profile resolution, dependencies,
 *  and orphan-shaped rows (running attempt + null container). */
function seedFixtures(): Task[] {
  seedProfile('repo-profile');
  seedProfile('repo-review-profile');
  seedProfile('task-profile');
  updateSetting('default_agent_profile_id', seedProfile('global-profile'));

  seedRepo(1, { agent: 'repo-profile', review: 'repo-review-profile' });
  seedRepo(2);

  // Queued and blocked on an open dependency.
  const blocked = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
  upsertTaskDependency({
    task_id: blocked.id,
    dep_issue_number: 5,
    state: 'open',
    detail: 'issue open',
    checked: false,
    last_evaluated_at: '2026-08-01T00:00:00.000Z',
  });

  // In-progress with a running develop attempt and a container.
  const running = insertTask({
    issue_id: 11,
    repo_id: 1,
    status: 'queued',
    agent_profile_id: 'task-profile',
  });
  updateTaskRaw(running.id, { status: 'in-progress', container_id: 'c-11' });
  insertAttempt({
    task_id: running.id,
    attempt_number: 1,
    role: 'develop',
    status: 'running',
    started_at: '2026-08-01T10:00:00.000Z',
  });

  // In-review: a completed develop attempt carrying a feedback blob, plus a
  // running review attempt — the shape whose full history the old
  // getAttempts call used to drag in.
  const reviewing = insertTask({ issue_id: 12, repo_id: 2, status: 'queued' });
  updateTaskRaw(reviewing.id, { status: 'in-review', container_id: 'c-12' });
  const dev = insertAttempt({
    task_id: reviewing.id,
    attempt_number: 1,
    role: 'develop',
    status: 'running',
    started_at: '2026-08-01T10:00:00.000Z',
  });
  updateAttempt(dev.id, {
    status: 'completed',
    completed_at: '2026-08-01T11:00:00.000Z',
    feedback: 'review feedback blob '.repeat(200),
  });
  insertAttempt({
    task_id: reviewing.id,
    attempt_number: 1,
    role: 'review',
    status: 'running',
    started_at: '2026-08-01T11:01:00.000Z',
  });

  // Orphan shape: active status + running attempt but no container.
  const orphaned = insertTask({ issue_id: 13, repo_id: 2, status: 'queued' });
  updateTaskRaw(orphaned.id, { status: 'in-progress', container_id: null });
  insertAttempt({
    task_id: orphaned.id,
    attempt_number: 1,
    role: 'develop',
    status: 'running',
    started_at: '2026-08-01T10:00:00.000Z',
  });

  // Active status with NO running attempt (between roles) — health must not
  // read orphaned.
  const betweenRoles = insertTask({
    issue_id: 14,
    repo_id: 1,
    status: 'queued',
  });
  updateTaskRaw(betweenRoles.id, { status: 'in-review', container_id: null });

  // Terminal rows with attempt history.
  const merged = insertTask({ issue_id: 15, repo_id: 1, status: 'queued' });
  updateTaskRaw(merged.id, {
    status: 'merged',
    completed_at: '2026-08-02T00:00:00.000Z',
  });
  const done = insertAttempt({
    task_id: merged.id,
    attempt_number: 1,
    role: 'develop',
    status: 'running',
    started_at: '2026-08-01T10:00:00.000Z',
  });
  updateAttempt(done.id, {
    status: 'completed',
    completed_at: '2026-08-01T12:00:00.000Z',
  });
  const failed = insertTask({ issue_id: 16, repo_id: 2, status: 'queued' });
  updateTaskRaw(failed.id, {
    status: 'failed',
    completed_at: '2026-08-03T00:00:00.000Z',
  });

  return getTasks();
}

beforeEach(() => {
  db = initDatabase(':memory:');
  _clearSnapshotCache();
  vi.clearAllMocks();
});

describe('batched-context golden equality', () => {
  it('enrichTask: batched context deep-equals the per-task-query path', () => {
    const tasks = seedFixtures();
    expect(tasks.length).toBeGreaterThanOrEqual(7);

    const defaults = loadProfileDefaults();
    const batches = loadTaskViewBatches();

    for (const task of tasks) {
      const perTask = enrichTask(task, { defaults });
      const batched = enrichTask(task, { defaults, ...batches });
      expect(batched).toEqual(perTask);
    }
  });

  it('holds with managedIds set (Docker-aware health derivation)', () => {
    const tasks = seedFixtures();
    // c-11 present, c-12 vanished — exercises healthy AND orphaned branches.
    const managedIds = new Set(['c-11']);

    const defaults = loadProfileDefaults();
    const batches = loadTaskViewBatches();

    for (const task of tasks) {
      const perTask = enrichTask(task, { defaults, managedIds });
      const batched = enrichTask(task, { defaults, managedIds, ...batches });
      expect(batched).toEqual(perTask);
    }
    // Sanity: the fixture really exercised both branches.
    const views = tasks.map((t) => enrichTask(t, { defaults, managedIds }));
    expect(views.map((v) => v.health)).toContain('healthy');
    expect(views.map((v) => v.health)).toContain('orphaned');
  });

  it('buildTaskView: batched context deep-equals the per-task path', () => {
    const tasks = seedFixtures();
    const defaults = loadProfileDefaults();
    const batches = loadTaskViewBatches();

    for (const task of tasks) {
      expect(buildTaskView(task, { defaults, ...batches })).toEqual(
        buildTaskView(task, { defaults })
      );
    }
  });

  it('a batched enrichTask issues no per-task attempt or repo queries', () => {
    const tasks = seedFixtures();
    const defaults = loadProfileDefaults();
    const batches = loadTaskViewBatches();
    vi.clearAllMocks();

    for (const task of tasks) enrichTask(task, { defaults, ...batches });

    expect(vi.mocked(getAttempts)).not.toHaveBeenCalled();
    expect(vi.mocked(getActiveAttempt)).not.toHaveBeenCalled();
    expect(vi.mocked(getRepo)).not.toHaveBeenCalled();
  });

  it('single-task enrichment takes the targeted getActiveAttempt path', () => {
    const tasks = seedFixtures();
    vi.clearAllMocks();

    enrichTask(tasks[0]);

    // One targeted running-attempt read; never the full history.
    expect(vi.mocked(getActiveAttempt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getAttempts)).not.toHaveBeenCalled();
  });
});

describe('buildSnapshot query discipline', () => {
  it('enriches every task without per-task attempt-history queries', () => {
    const tasks = seedFixtures();
    vi.clearAllMocks();

    const snapshot = buildSnapshot();

    expect(snapshot.tasks).toHaveLength(tasks.length);
    expect(vi.mocked(getAttempts)).not.toHaveBeenCalled();
    expect(vi.mocked(getActiveAttempt)).not.toHaveBeenCalled();
    // The views themselves match the per-task-query serialization.
    const defaults = loadProfileDefaults();
    for (const task of tasks) {
      const view = snapshot.tasks.find((t) => t.id === task.id);
      expect(view).toEqual(buildTaskView(task, { defaults }));
    }
  });
});
