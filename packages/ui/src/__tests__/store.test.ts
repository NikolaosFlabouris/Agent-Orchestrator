import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store.js';
import type { TaskResponse } from '../api.js';

/**
 * Merge semantics of the task slice (issue #148).
 *
 * The store used to be update-only: `updateTask` mapped over the existing
 * array, so a row it had never seen was silently dropped and the periodic
 * REST refresh could not heal a missed `task_created`. Rows the server had
 * forgotten were never pruned either. These tests pin both directions.
 */

// Only `id` and `status` matter to the merge logic; the rest of TaskView is
// irrelevant here, so fixtures stay minimal and are cast at the boundary.
function task(
  id: number,
  status: string,
  extra: Partial<TaskResponse> = {}
): TaskResponse {
  return { id, issue_id: 1000 + id, status, ...extra } as TaskResponse;
}

function ids(): number[] {
  return useStore.getState().tasks.map((t) => t.id);
}

beforeEach(() => {
  useStore.setState({ tasks: [], connection: 'reconnecting' });
});

describe('updateTask', () => {
  it('replaces the row when the id is already present', () => {
    useStore.setState({ tasks: [task(1, 'queued'), task(2, 'queued')] });
    useStore.getState().updateTask(task(2, 'in-progress'));

    expect(ids()).toEqual([1, 2]);
    expect(useStore.getState().tasks[1].status).toBe('in-progress');
  });

  it('appends the task when the id is unseen instead of dropping it', () => {
    useStore.setState({ tasks: [task(1, 'queued')] });
    useStore.getState().updateTask(task(7, 'in-progress'));

    expect(ids()).toEqual([1, 7]);
  });

  it('leaves the array identity untouched for unrelated rows', () => {
    const first = task(1, 'queued');
    useStore.setState({ tasks: [first, task(2, 'queued')] });
    useStore.getState().updateTask(task(2, 'merged'));

    expect(useStore.getState().tasks[0]).toBe(first);
  });
});

describe('addTask', () => {
  it('does not duplicate a row the snapshot already carried', () => {
    useStore.setState({ tasks: [task(3, 'queued')] });
    useStore.getState().addTask(task(3, 'preparing'));

    expect(ids()).toEqual([3]);
    expect(useStore.getState().tasks[0].status).toBe('preparing');
  });
});

describe('syncTasks', () => {
  it('replaces existing rows and appends unseen ones', () => {
    useStore.setState({ tasks: [task(1, 'queued'), task(2, 'in-progress')] });
    useStore.getState().syncTasks([
      task(1, 'preparing'),
      task(2, 'in-review'),
      task(9, 'queued'),
    ]);

    expect(ids()).toEqual([1, 2, 9]);
    expect(useStore.getState().tasks.map((t) => t.status)).toEqual([
      'preparing',
      'in-review',
      'queued',
    ]);
  });

  it('prunes active and queued rows the server no longer reports', () => {
    useStore.setState({
      tasks: [
        task(1, 'queued'),
        task(2, 'in-progress'),
        task(3, 'in-review'),
        task(4, 'changes-needed'),
        task(5, 'preparing'),
      ],
    });
    useStore.getState().syncTasks([task(2, 'in-progress')]);

    expect(ids()).toEqual([2]);
  });

  it('keeps a completed row the server omitted via its `limit` truncation', () => {
    // GET /api/tasks returns active + queued whole but slices the completed
    // bucket to `?limit` (default 20). An older completed row missing from
    // the response is therefore intentionally withheld, not deleted.
    useStore.setState({
      tasks: [
        task(1, 'merged'),
        task(2, 'failed'),
        task(3, 'cancelled'),
        task(4, 'awaiting-human-merge'),
        task(5, 'reset'),
        task(6, 'in-progress'),
      ],
    });
    useStore.getState().syncTasks([task(6, 'in-progress')]);

    expect(ids()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('is a no-op on task state when the response repeats what we hold', () => {
    useStore.setState({ tasks: [task(1, 'queued'), task(2, 'merged')] });
    useStore.getState().syncTasks([task(1, 'queued'), task(2, 'merged')]);

    expect(ids()).toEqual([1, 2]);
  });

  it('does not prune anything when the response is empty but we only hold completed rows', () => {
    useStore.setState({ tasks: [task(1, 'merged')] });
    useStore.getState().syncTasks([]);

    expect(ids()).toEqual([1]);
  });

  it('drops every local row when the server reports an empty active/queued world', () => {
    useStore.setState({ tasks: [task(1, 'queued'), task(2, 'preparing')] });
    useStore.getState().syncTasks([]);

    expect(ids()).toEqual([]);
  });
});

describe('connection state', () => {
  it('starts pessimistic and follows the socket', () => {
    expect(useStore.getState().connection).toBe('reconnecting');
    useStore.getState().setConnection('connected');
    expect(useStore.getState().connection).toBe('connected');
    useStore.getState().setConnection('reconnecting');
    expect(useStore.getState().connection).toBe('reconnecting');
  });
});
