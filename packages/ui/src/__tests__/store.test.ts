/**
 * Store merge semantics for the live-data layer.
 *
 * `updateTask` used to map over the existing array, so an id it had never
 * seen was silently dropped — which meant the periodic REST refresh could
 * not heal a missed `task_created` event, and any future creation path that
 * forgot to emit one was invisible until a manual page reload.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskResponse } from '../api.js';
import { useStore } from '../store.js';

/** Minimal TaskResponse — the store never reads anything but `id` and
 *  `status`, so the rest is filler cast to the wire type. */
function task(
  id: number,
  status: string,
  extra: Partial<TaskResponse> = {}
): TaskResponse {
  return {
    id,
    issue_id: 100 + id,
    issue_title: `task ${id}`,
    status,
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-01-01T00:00:00Z',
    started_at: null,
    completed_at: null,
    ...extra,
  } as unknown as TaskResponse;
}

const ids = () => useStore.getState().tasks.map((t) => t.id);

beforeEach(() => {
  useStore.setState({ tasks: [], connection: 'reconnecting' });
});

describe('updateTask', () => {
  it('replaces the row in place when the id is already present', () => {
    useStore.setState({ tasks: [task(1, 'queued'), task(2, 'queued')] });

    useStore.getState().updateTask(task(1, 'in-progress'));

    expect(ids()).toEqual([1, 2]);
    expect(useStore.getState().tasks[0].status).toBe('in-progress');
  });

  it('appends a task with an unseen id instead of dropping it', () => {
    useStore.setState({ tasks: [task(1, 'queued')] });

    useStore.getState().updateTask(task(7, 'in-progress'));

    expect(ids()).toEqual([1, 7]);
    expect(useStore.getState().tasks[1].status).toBe('in-progress');
  });

  it('appends into an empty store', () => {
    useStore.getState().updateTask(task(3, 'merged'));
    expect(ids()).toEqual([3]);
  });
});

describe('syncTasks', () => {
  it('upserts new rows and replaces existing ones, preserving order', () => {
    useStore.setState({
      tasks: [task(1, 'in-progress'), task(2, 'queued')],
    });

    useStore
      .getState()
      .syncTasks([task(2, 'preparing'), task(1, 'in-review'), task(9, 'queued')]);

    expect(ids()).toEqual([1, 2, 9]);
    expect(useStore.getState().tasks[0].status).toBe('in-review');
    expect(useStore.getState().tasks[1].status).toBe('preparing');
  });

  it('prunes rows a complete response did not return', () => {
    useStore.setState({
      tasks: [
        task(1, 'in-progress'),
        task(2, 'queued'),
        task(3, 'preparing'),
        task(4, 'merged'),
      ],
    });

    // Only one completed row came back, well under the limit, so the
    // response is the server's whole task list.
    useStore
      .getState()
      .syncTasks([task(1, 'in-progress'), task(4, 'merged')], {
        completedLimit: 20,
      });

    expect(ids()).toEqual([1, 4]);
  });

  it('does NOT prune when the completed bucket hit the `limit`', () => {
    // GET /api/tasks slices the completed bucket to `limit`, so a response
    // that came back at the limit is silent about everything it dropped —
    // pruning from it would erase history the server never said was gone.
    const completed = [2, 3, 4].map((id) => task(id, 'merged'));
    useStore.setState({
      tasks: [task(1, 'in-progress'), ...completed, task(9, 'merged')],
    });

    useStore
      .getState()
      .syncTasks([task(1, 'in-progress'), ...completed], {
        completedLimit: 3,
      });

    expect(ids()).toEqual([1, 2, 3, 4, 9]);
  });

  it('does NOT prune an active row the server re-derived as completed and truncated', () => {
    // The regression this rule exists for. The server buckets on the
    // Forgejo-derived status, not the stored one — a task stored
    // `in-progress` whose issue was just closed externally is bucketed
    // `cancelled` and truncated away. Pruning "active rows are always
    // returned in full" would delete a live task on every poll.
    const completed = [5, 6].map((id) => task(id, 'merged'));
    useStore.setState({
      tasks: [task(1, 'in-progress'), task(42, 'in-progress'), ...completed],
    });

    useStore
      .getState()
      .syncTasks([task(1, 'in-progress'), ...completed], {
        completedLimit: 2,
        knownIds: new Set([1, 42, 5, 6]),
      });

    expect(ids()).toEqual([1, 42, 5, 6]);
  });

  it('converges on the server view when a task moves between buckets', () => {
    useStore.setState({ tasks: [task(1, 'in-progress'), task(2, 'queued')] });

    useStore.getState().syncTasks([task(1, 'merged'), task(2, 'queued')], {
      completedLimit: 20,
    });

    expect(ids()).toEqual([1, 2]);
    expect(useStore.getState().tasks[0].status).toBe('merged');
  });

  it('keeps a task that appeared after the request was issued', () => {
    // The Dashboard captures the id set before calling GET /api/tasks. A
    // `task_created` that lands over the WebSocket mid-flight must not be
    // pruned by a response that predates it — that's exactly the "task
    // blinks out until the next poll" bug this layer is meant to end.
    useStore.setState({
      tasks: [
        task(1, 'in-progress'),
        task(2, 'queued'),
        task(3, 'queued'), // arrived over the WS after the fetch started
      ],
    });

    useStore.getState().syncTasks([task(1, 'in-progress')], {
      completedLimit: 20,
      knownIds: new Set([1, 2]),
    });

    expect(ids()).toEqual([1, 3]);
  });

  it('never prunes when no limit hint is passed', () => {
    // Without the hint we cannot tell a complete response from a truncated
    // one, so the safe reading of "absent" is "unknown", not "deleted".
    useStore.setState({ tasks: [task(1, 'queued'), task(2, 'merged')] });
    useStore.getState().syncTasks([]);
    expect(ids()).toEqual([1, 2]);
  });

  it('collapses duplicate ids already in the store', () => {
    // addTask is an upsert now, but a store that somehow holds two rows for
    // one id would render both under the same React key — heal it here.
    useStore.setState({ tasks: [task(1, 'queued'), task(1, 'preparing')] });
    useStore.getState().syncTasks([task(1, 'in-progress')], {
      completedLimit: 20,
    });
    expect(ids()).toEqual([1]);
    expect(useStore.getState().tasks[0].status).toBe('in-progress');
  });

  it('seeds an empty store from a full response', () => {
    useStore.getState().syncTasks([task(1, 'queued'), task(2, 'merged')]);
    expect(ids()).toEqual([1, 2]);
  });
});

describe('addTask', () => {
  it('appends an unseen task', () => {
    useStore.setState({ tasks: [task(1, 'queued')] });
    useStore.getState().addTask(task(2, 'queued'));
    expect(ids()).toEqual([1, 2]);
  });

  it('does not duplicate a task the REST poll already inserted', () => {
    // syncTasks can now insert, so a poll response can land before the
    // task_created frame for the same task.
    useStore.setState({ tasks: [task(1, 'queued')] });
    useStore.getState().addTask(task(1, 'preparing'));
    expect(ids()).toEqual([1]);
    expect(useStore.getState().tasks[0].status).toBe('preparing');
  });
});

describe('setConnection', () => {
  it('flips between connected and reconnecting', () => {
    expect(useStore.getState().connection).toBe('reconnecting');
    useStore.getState().setConnection('connected');
    expect(useStore.getState().connection).toBe('connected');
    useStore.getState().setConnection('reconnecting');
    expect(useStore.getState().connection).toBe('reconnecting');
  });

  it('does not notify when re-asserting the current state', () => {
    // The liveness poller re-asserts `connected` on every healthy check;
    // that must not wake every store subscriber in the app.
    useStore.getState().setConnection('connected');
    let notifications = 0;
    const unsubscribe = useStore.subscribe(() => {
      notifications += 1;
    });

    useStore.getState().setConnection('connected');
    expect(notifications).toBe(0);

    useStore.getState().setConnection('reconnecting');
    expect(notifications).toBe(1);

    unsubscribe();
  });
});
