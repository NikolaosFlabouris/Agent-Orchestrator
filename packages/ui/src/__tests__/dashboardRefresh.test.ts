import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Dashboard's /api/tasks poll has one invariant that is easy to break and
// impossible to see in the UI when it is broken: the `limit` it sends and the
// `completedLimit` it hands `syncTasks` must be the SAME number. `syncTasks`
// uses `completedLimit` to tell a complete response from one the route
// truncated, and only prunes from a complete one — a `completedLimit` larger
// than the `limit` actually requested makes a truncated response look complete
// and deletes live rows. Now that the Recent size selector can raise the
// limit, pin both values.

const getTasks = vi.fn();

vi.mock('../api.js', () => ({ api: { getTasks: (...a: unknown[]) => getTasks(...a) } }));

const { refreshTasks, tasksFetchLimit } = await import('../views/Dashboard.js');
const { useStore } = await import('../store.js');

describe('tasksFetchLimit', () => {
  it('never asks for less than the route default', () => {
    expect(tasksFetchLimit(5)).toBe(20);
    expect(tasksFetchLimit(10)).toBe(20);
    expect(tasksFetchLimit(20)).toBe(20);
  });

  it('grows to cover a larger Recent selection', () => {
    expect(tasksFetchLimit(50)).toBe(50);
    expect(tasksFetchLimit(100)).toBe(100);
  });
});

describe('refreshTasks', () => {
  beforeEach(() => {
    getTasks.mockReset();
  });

  it('sends the same value as `limit` and `completedLimit`', async () => {
    const syncTasks = vi.spyOn(useStore.getState(), 'syncTasks');
    getTasks.mockResolvedValue({ tasks: [] });

    for (const selection of [5, 10, 20, 50, 100]) {
      refreshTasks(selection);
      await Promise.resolve();
      await Promise.resolve();

      const expected = Math.max(20, selection);
      expect(getTasks).toHaveBeenCalledWith({ limit: expected });
      expect(syncTasks).toHaveBeenCalledWith([], expect.objectContaining({ completedLimit: expected }));
      getTasks.mockClear();
      syncTasks.mockClear();
    }
    syncTasks.mockRestore();
  });

  it('swallows a failed request rather than rejecting', async () => {
    getTasks.mockRejectedValue(new Error('offline'));
    await expect(
      (async () => {
        refreshTasks(10);
        await Promise.resolve();
      })()
    ).resolves.toBeUndefined();
  });
});
