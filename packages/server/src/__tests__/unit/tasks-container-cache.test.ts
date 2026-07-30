/**
 * Memoized managed-container listing (issue #149).
 *
 * `GET /api/tasks` calls `loadManagedContainerIds`, which used to hit the
 * Docker socket once per request — so N open dashboard tabs meant N
 * round-trips, plus one more for every Task Detail view and every reports
 * read. The listing is now shared behind a short TTL.
 *
 * The failure semantics are the delicate part and are pinned below: a Docker
 * failure must still surface as `undefined` ("unknown"), never as an empty
 * `Set` — an empty set would mark every containerised task orphaned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { initDatabase, insertTask, getDb } from '../../db.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';
import { _clearSnapshotCache } from '../../forgejo-snapshot.js';

// Only `listContainers` is replaced — everything else in docker.js stays
// real so unrelated importers (orphan-recovery, the reaper) behave normally.
vi.mock('../../docker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../docker.js')>();
  return { ...actual, listContainers: vi.fn() };
});

const { listContainers } = await import('../../docker.js');
const { createTaskRoutes, loadManagedContainerIds, _clearManagedContainerCache } =
  await import('../../routes/tasks.js');

const listMock = vi.mocked(listContainers);

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as FastifyBaseLogger;

/** Forgejo double: enough for the snapshot warm + per-task derivation. */
const fakeForgejo = {
  getIssue: vi.fn(async () => ({ number: 10, state: 'open', labels: [] })),
  getPullRequest: vi.fn(async () => ({
    number: 1,
    state: 'open',
    merged: false,
    mergeable: true,
  })),
  listIssues: vi.fn(async () => []),
  listPullRequests: vi.fn(async () => []),
} as unknown as ForgejoClient;

const fakeScheduler = { triggerTick: () => {} } as unknown as Scheduler;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.log.warn = () => app.log as never;
  await app.register(createTaskRoutes(fakeForgejo, fakeScheduler));
  await app.ready();
  return app;
}

beforeEach(() => {
  initDatabase(':memory:');
  _clearSnapshotCache();
  _clearManagedContainerCache();
  vi.clearAllMocks();
  listMock.mockResolvedValue([]);
  getDb()
    .prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'owner', 'repo1')`)
    .run();
});

afterEach(() => {
  vi.useRealTimers();
  _clearManagedContainerCache();
});

describe('GET /api/tasks container listing', () => {
  it('shares one Docker round-trip across two requests inside the TTL', async () => {
    insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const app = await buildApp();

    const first = await app.inject({ method: 'GET', url: '/api/tasks' });
    const second = await app.inject({ method: 'GET', url: '/api/tasks' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('shares one round-trip across CONCURRENT requests', async () => {
    insertTask({ issue_id: 10, repo_id: 1, status: 'queued' });
    const app = await buildApp();

    // The cache holds the in-flight promise, not just the settled value, so
    // requests that overlap collapse too — the N-open-tabs case.
    let release: (value: []) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise<[]>((resolve) => {
        release = resolve;
      }) as ReturnType<typeof listContainers>
    );

    const both = Promise.all([
      app.inject({ method: 'GET', url: '/api/tasks' }),
      app.inject({ method: 'GET', url: '/api/tasks' }),
    ]);
    // Let both handlers reach the (still unresolved) Docker call before
    // completing it, so the second one genuinely arrives mid-flight.
    await new Promise((resolve) => setImmediate(resolve));
    release([]);
    const [first, second] = await both;

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(listMock).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

describe('loadManagedContainerIds', () => {
  it('re-lists once the TTL window has passed', async () => {
    vi.useFakeTimers();

    await loadManagedContainerIds(silentLog);
    await loadManagedContainerIds(silentLog);
    expect(listMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    await loadManagedContainerIds(silentLog);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined — not an empty Set — when Docker fails', async () => {
    listMock.mockRejectedValue(new Error('docker down'));

    const result = await loadManagedContainerIds(silentLog);

    // An empty Set would make every containerised task look orphaned; the
    // "unknown" signal has to survive.
    expect(result).toBeUndefined();
    expect(result).not.toEqual(new Set());
  });

  it('does not cache a failure — the next caller retries the daemon', async () => {
    listMock.mockRejectedValueOnce(new Error('docker down'));

    expect(await loadManagedContainerIds(silentLog)).toBeUndefined();

    listMock.mockResolvedValue([{ Id: 'abc' }] as never);
    expect(await loadManagedContainerIds(silentLog)).toEqual(new Set(['abc']));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('reports the ids Docker returned', async () => {
    listMock.mockResolvedValue([{ Id: 'abc' }, { Id: 'def' }] as never);

    expect(await loadManagedContainerIds(silentLog)).toEqual(
      new Set(['abc', 'def'])
    );
  });
});
