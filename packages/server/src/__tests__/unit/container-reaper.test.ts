import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Mocks. db.ts transitively loads better-sqlite3 and docker.ts loads
// dockerode; stub both so the reaper can be exercised in isolation.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getTasks: vi.fn<(args: { status: string }) => Task[]>(),
  listContainers:
    vi.fn<() => Promise<Array<{ Id: string; Labels?: Record<string, string> }>>>(),
  getContainer: vi.fn(),
  stopContainer: vi.fn<(...a: unknown[]) => Promise<void>>(),
  removeContainer: vi.fn<(...a: unknown[]) => Promise<void>>(),
}));

vi.mock('../../db.js', () => ({
  getTasks: mocks.getTasks,
}));

vi.mock('../../docker.js', () => ({
  listContainers: mocks.listContainers,
  getContainer: mocks.getContainer,
  stopContainer: mocks.stopContainer,
  removeContainer: mocks.removeContainer,
}));

const { reapOrphanedContainers } = await import('../../container-reaper.js');

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
} as any;

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 1,
    issue_title: 'Test',
    repo_id: 1,
    branch_name: null,
    pr_number: null,
    status: 'in-progress',
    queue_position: null,
    attempt: 1,
    max_attempts: 3,
    prep_failure_count: 0,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-04-21T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTasks.mockReturnValue([]);
  mocks.getContainer.mockImplementation((id: string) => ({ id }));
  mocks.stopContainer.mockResolvedValue(undefined);
  mocks.removeContainer.mockResolvedValue(undefined);
});

describe('reapOrphanedContainers', () => {
  it('removes a managed container whose task-id maps to no active task', async () => {
    // Container labelled for task 99, but no task is active.
    mocks.listContainers.mockResolvedValue([
      { Id: 'ctr-99', Labels: { 'managed-by': 'orchestrator', 'task-id': '99' } },
    ]);

    await reapOrphanedContainers(silentLog);

    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
    expect(mocks.getContainer).toHaveBeenCalledWith('ctr-99');
  });

  it('leaves a container whose task is still active', async () => {
    mocks.listContainers.mockResolvedValue([
      { Id: 'ctr-5', Labels: { 'managed-by': 'orchestrator', 'task-id': '5' } },
    ]);
    mocks.getTasks.mockImplementation(({ status }) =>
      status === 'in-progress' ? [mkTask({ id: 5, status: 'in-progress' })] : []
    );

    await reapOrphanedContainers(silentLog);

    expect(mocks.removeContainer).not.toHaveBeenCalled();
  });

  it('treats preparing/in-review/changes-needed as active (no reap)', async () => {
    mocks.listContainers.mockResolvedValue([
      { Id: 'ctr-1', Labels: { 'managed-by': 'orchestrator', 'task-id': '1' } },
      { Id: 'ctr-2', Labels: { 'managed-by': 'orchestrator', 'task-id': '2' } },
      { Id: 'ctr-3', Labels: { 'managed-by': 'orchestrator', 'task-id': '3' } },
    ]);
    mocks.getTasks.mockImplementation(({ status }) => {
      if (status === 'preparing') return [mkTask({ id: 1, status: 'preparing' })];
      if (status === 'in-review') return [mkTask({ id: 2, status: 'in-review' })];
      if (status === 'changes-needed')
        return [mkTask({ id: 3, status: 'changes-needed' })];
      return [];
    });

    await reapOrphanedContainers(silentLog);

    expect(mocks.removeContainer).not.toHaveBeenCalled();
  });

  it('reaps a container whose task exists but is in a terminal state', async () => {
    mocks.listContainers.mockResolvedValue([
      { Id: 'ctr-7', Labels: { 'managed-by': 'orchestrator', 'task-id': '7' } },
    ]);
    // Task 7 is merged — not in any ACTIVE_STATUSES bucket, so getTasks for
    // the active statuses returns nothing for it.
    mocks.getTasks.mockReturnValue([]);

    await reapOrphanedContainers(silentLog);

    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
    expect(mocks.getContainer).toHaveBeenCalledWith('ctr-7');
  });

  it('only ever enumerates via listContainers (managed-by filter), so a non-managed container is never touched', async () => {
    // listContainers() filters to managed-by=orchestrator at the Docker API
    // level, so a container without that label can never appear in the list
    // the reaper iterates. Simulate that contract: the daemon has a foreign
    // container, but listContainers returns only the managed one.
    mocks.listContainers.mockResolvedValue([
      { Id: 'managed-orphan', Labels: { 'managed-by': 'orchestrator', 'task-id': '42' } },
      // A foreign container would NOT be returned by listContainers — assert
      // by absence: removeContainer is only ever called for managed ids.
    ]);

    await reapOrphanedContainers(silentLog);

    // The reaper made exactly one removal, for the managed orphan, and the
    // container id it resolved carries the managed label.
    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
    expect(mocks.getContainer).toHaveBeenCalledWith('managed-orphan');
    expect(mocks.getContainer).not.toHaveBeenCalledWith('foreign-container');
  });

  it('skips a managed container that has no task-id label', async () => {
    mocks.listContainers.mockResolvedValue([
      { Id: 'no-label', Labels: { 'managed-by': 'orchestrator' } },
    ]);

    await reapOrphanedContainers(silentLog);

    expect(mocks.removeContainer).not.toHaveBeenCalled();
  });

  it('is a no-op when Docker is unreachable', async () => {
    mocks.listContainers.mockRejectedValue(new Error('docker down'));

    await reapOrphanedContainers(silentLog);

    expect(mocks.removeContainer).not.toHaveBeenCalled();
    expect(mocks.getTasks).not.toHaveBeenCalled();
  });

  it('continues reaping after a per-container removal error', async () => {
    mocks.listContainers.mockResolvedValue([
      { Id: 'ctr-a', Labels: { 'managed-by': 'orchestrator', 'task-id': '100' } },
      { Id: 'ctr-b', Labels: { 'managed-by': 'orchestrator', 'task-id': '101' } },
    ]);
    mocks.removeContainer.mockRejectedValueOnce(new Error('daemon error'));

    await reapOrphanedContainers(silentLog);

    // Both were attempted despite the first throwing.
    expect(mocks.removeContainer).toHaveBeenCalledTimes(2);
  });
});
