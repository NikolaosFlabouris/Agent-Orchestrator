/**
 * The dashboard WebSocket payload must be the SAME enriched object
 * `GET /api/tasks` returns (issue #146). These tests pin the three
 * broadcast producers — the connect-time snapshot, `updateTaskWithSync`,
 * and the dependency evaluator — to that contract, plus the cache-only
 * snapshot read that lets the broadcast path derive a status without ever
 * touching Forgejo.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Repo, TaskUpdatedEvent, TaskView } from '@orchestrator/shared';
import {
  initDatabase,
  insertTask,
  updateTask,
  updateSetting,
  getSetting,
  getTask,
  getRepo,
  upsertTaskDependency,
} from '../../db.js';
import {
  _clearSnapshotCache,
  getSnapshot,
  peekSnapshot,
} from '../../forgejo-snapshot.js';
import type { ForgejoClient } from '../../forgejo.js';

// Spy on the settings reads so the loop-invariant hoist is observable:
// enriching N tasks must not issue 2N settings queries.
vi.mock('../../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db.js')>();
  return { ...actual, getSetting: vi.fn(actual.getSetting) };
});

// Keep the real module (buildSnapshot is under test) but capture what the
// broadcasters emit.
vi.mock('../../ws/dashboard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ws/dashboard.js')>();
  return { ...actual, broadcastDashboardEvent: vi.fn() };
});

const { buildSnapshot, broadcastDashboardEvent } = await import(
  '../../ws/dashboard.js'
);
const { updateTaskWithSync } = await import('../../state-sync.js');
const { evaluateTaskDependencies, _clearDependencyCache } = await import(
  '../../dependencies.js'
);

const broadcastMock = vi.mocked(broadcastDashboardEvent);

/** Every `task_updated` event the broadcaster received, in order. */
function taskUpdatedEvents(): TaskUpdatedEvent[] {
  return broadcastMock.mock.calls
    .map(([event]) => event)
    .filter((e): e is TaskUpdatedEvent => e.type === 'task_updated');
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as FastifyBaseLogger;

let db: ReturnType<typeof initDatabase>;

function seedRepo(id: number, overrides: Partial<Repo> = {}): Repo {
  db.prepare(
    `INSERT INTO repos (id, owner, name, agent_profile_id, review_agent_profile_id)
     VALUES (?, 'owner', ?, ?, ?)`
  ).run(
    id,
    overrides.name ?? `repo${id}`,
    overrides.agent_profile_id ?? null,
    overrides.review_agent_profile_id ?? null
  );
  return getRepo(id)!;
}

/** Add an agent profile row so repo/global profile pointers satisfy their
 *  foreign key. Reuses the bootstrap profile's model. */
function seedProfile(id: string): string {
  db.prepare(
    `INSERT INTO agent_profiles (id, display_name, harness_id, model_pk, config_json, timeout_minutes)
     SELECT ?, ?, harness_id, model_pk, '{}', timeout_minutes
       FROM agent_profiles WHERE id = 'default-claude-sdk'`
  ).run(id, id);
  return id;
}

/** Forgejo double that counts every call it receives. */
function countingForgejo(snapshot: {
  issueState?: 'open' | 'closed';
  labels?: string[];
  pr?: { number: number; state: string; merged: boolean };
}) {
  const getIssue = vi.fn(async () => ({
    number: 1,
    state: snapshot.issueState ?? 'open',
    labels: (snapshot.labels ?? []).map((name) => ({ name })),
  }));
  const getPullRequest = vi.fn(async () => ({
    number: snapshot.pr?.number ?? 1,
    state: snapshot.pr?.state ?? 'open',
    merged: snapshot.pr?.merged ?? false,
    mergeable: true,
  }));
  const client = { getIssue, getPullRequest } as unknown as ForgejoClient;
  return {
    client,
    calls: () => getIssue.mock.calls.length + getPullRequest.mock.calls.length,
    getIssue,
    getPullRequest,
  };
}

/** The fields the old raw-row payload dropped — the whole point of #146. */
const ENRICHED_FIELDS = [
  'repo',
  'dependencies',
  'blocked',
  'blocked_by',
  'health',
  'container_name',
  'runtime_status',
  'effective_agent_profile_id',
  'agent_profile_source',
  'repo_agent_profile_id',
  'global_agent_profile_id',
  'effective_review_agent_profile_id',
  'review_agent_profile_source',
  'repo_review_agent_profile_id',
  'global_review_agent_profile_id',
] as const;

beforeEach(() => {
  db = initDatabase(':memory:');
  _clearSnapshotCache();
  _clearDependencyCache();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// peekSnapshot — cache-only, never calls Forgejo
// ---------------------------------------------------------------------------

describe('peekSnapshot', () => {
  it('returns null on an empty cache without calling Forgejo', () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = countingForgejo({});

    expect(peekSnapshot(task.id)).toBeNull();
    expect(forgejo.calls()).toBe(0);
  });

  it('returns an EXPIRED cached entry, still without calling Forgejo', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const forgejo = countingForgejo({ labels: ['human-review'] });

    // ttlMs: 0 → the entry is already expired the moment it lands.
    const fetched = await getSnapshot(task, forgejo.client, { ttlMs: 0 });
    expect(fetched).not.toBeNull();
    const callsAfterFetch = forgejo.calls();
    expect(callsAfterFetch).toBeGreaterThan(0);

    const peeked = peekSnapshot(task.id);
    expect(peeked).toEqual(fetched);
    // No refetch, and no background refresh scheduled either.
    expect(forgejo.calls()).toBe(callsAfterFetch);
  });
});

// ---------------------------------------------------------------------------
// buildSnapshot — the connect-time payload
// ---------------------------------------------------------------------------

describe('buildSnapshot', () => {
  it('emits enriched tasks, not raw DB rows', () => {
    seedProfile('repo-profile');
    seedRepo(1, { agent_profile_id: 'repo-profile' });
    const task = insertTask({
      issue_id: 10,
      repo_id: 1,
      status: 'queued',
      issue_title: 'Do the thing',
    });
    upsertTaskDependency({
      task_id: task.id,
      dep_issue_number: 5,
      state: 'open',
      detail: 'issue open',
      checked: false,
      last_evaluated_at: new Date().toISOString(),
    });

    const snapshot = buildSnapshot();
    expect(snapshot.tasks).toHaveLength(1);
    const view = snapshot.tasks[0];

    for (const field of ENRICHED_FIELDS) {
      expect(view).toHaveProperty(field);
    }
    expect(view.repo).toEqual({ id: 1, owner: 'owner', name: 'repo1' });
    expect(view.dependencies.map((d) => d.dep_issue_number)).toEqual([5]);
    expect(view.blocked).toBe(true);
    expect(view.blocked_by).toEqual([5]);
    expect(view.effective_agent_profile_id).toBe('repo-profile');
    expect(view.agent_profile_source).toBe('repo');
    // No review tier anywhere → falls through to the implementation profile.
    expect(view.effective_review_agent_profile_id).toBe('repo-profile');
    expect(view.review_agent_profile_source).toBe('implementation');
  });

  it('resolves the global profile defaults once for the whole snapshot', () => {
    seedRepo(1);
    for (const issue_id of [10, 11, 12]) {
      insertTask({ issue_id, repo_id: 1, status: 'queued' });
    }
    updateSetting('default_agent_profile_id', seedProfile('global-profile'));

    vi.mocked(getSetting).mockClear();
    const snapshot = buildSnapshot();
    // Two reads for the whole snapshot, not two per task.
    expect(vi.mocked(getSetting).mock.calls.map(([key]) => key)).toEqual([
      'default_agent_profile_id',
      'default_review_agent_profile_id',
    ]);
    expect(snapshot.tasks.map((t) => t.effective_agent_profile_id)).toEqual([
      'global-profile',
      'global-profile',
      'global-profile',
    ]);
    expect(snapshot.tasks.map((t) => t.agent_profile_source)).toEqual([
      'global',
      'global',
      'global',
    ]);
  });
});

// ---------------------------------------------------------------------------
// updateTaskWithSync — the hot-path broadcaster
// ---------------------------------------------------------------------------

describe('updateTaskWithSync broadcast payload', () => {
  function emittedTask(): TaskView {
    const events = taskUpdatedEvents();
    expect(events.length).toBeGreaterThan(0);
    return events[events.length - 1].task;
  }

  it('carries the same enriched fields as GET /api/tasks', () => {
    seedProfile('repo-profile');
    seedRepo(1, { agent_profile_id: 'repo-profile' });
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    upsertTaskDependency({
      task_id: task.id,
      dep_issue_number: 7,
      state: 'open',
      detail: 'issue open',
      checked: false,
      last_evaluated_at: new Date().toISOString(),
    });

    updateTaskWithSync(task.id, { queue_position: 3 });

    const view = emittedTask();
    for (const field of ENRICHED_FIELDS) {
      expect(view).toHaveProperty(field);
    }
    expect(view.repo).toEqual({ id: 1, owner: 'owner', name: 'repo1' });
    expect(view.blocked).toBe(true);
    expect(view.blocked_by).toEqual([7]);
    expect(view.effective_agent_profile_id).toBe('repo-profile');
    expect(view.agent_profile_source).toBe('repo');
    expect(view.effective_review_agent_profile_id).toBe('repo-profile');
    expect(view.review_agent_profile_source).toBe('implementation');
  });

  it('carries the Forgejo-derived status when a snapshot is warm', async () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    updateTask(task.id, { status: 'in-review', pr_number: 42 });

    // Warm the cache the way a REST read would: the PR is merged on
    // Forgejo even though the stored row still says in-review.
    const forgejo = countingForgejo({
      pr: { number: 42, state: 'closed', merged: true },
    });
    await getSnapshot(getTask(task.id)!, forgejo.client);
    const callsAfterWarm = forgejo.calls();

    updateTaskWithSync(task.id, { container_id: null });

    const view = emittedTask();
    expect(view.status).toBe('merged');
    // …while the stored runtime state is still preserved for debugging.
    expect(view.runtime_status).toBe('in-review');
    // The broadcast itself issued no Forgejo traffic.
    expect(forgejo.calls()).toBe(callsAfterWarm);
  });

  it('falls back to the stored status when no snapshot is cached', () => {
    seedRepo(1);
    const task = insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });

    updateTaskWithSync(task.id, { status: 'in-progress' });

    const view = emittedTask();
    expect(view.status).toBe('in-progress');
    expect(view.runtime_status).toBe('in-progress');
    expect(view.has_human_review_label).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dependencies.evaluateTaskDependencies — broadcasts post-evaluation state
// ---------------------------------------------------------------------------

describe('dependency evaluation broadcast', () => {
  it('emits the re-read row, so blocked/blocked_by reflect the new deps', async () => {
    seedRepo(1);
    const inserted = insertTask({
      issue_id: 10,
      repo_id: 1,
      status: 'in-progress',
    });
    // The caller's captured object is stale: the row moved to `queued`
    // after it was read. Broadcasting the captured object would emit
    // status 'in-progress' and blocked: false.
    const stale = getTask(inserted.id)!;
    updateTask(inserted.id, { status: 'queued' });

    const forgejo = {
      getIssue: vi.fn(async () => ({ state: 'open' })),
    } as unknown as Parameters<typeof evaluateTaskDependencies>[2];

    const summary = await evaluateTaskDependencies(
      stale,
      [{ issue: 5, checked: false }],
      forgejo,
      log
    );
    expect(summary.blocked).toBe(true);

    const events = taskUpdatedEvents();
    expect(events).toHaveLength(1);
    const view = events[0].task;

    expect(view.status).toBe('queued');
    expect(view.blocked).toBe(true);
    expect(view.blocked_by).toEqual([5]);
    expect(view.dependencies).toHaveLength(1);
  });
});
