import { describe, it, expect, vi } from 'vitest';
import {
  handleDashboardEvent,
  appendTaskEvent,
} from '../views/TaskDetail.js';
import type { TaskEventResponse } from '../api.js';
import type { DashboardWsEvent } from '../ws.js';

// How TaskDetail reacts to the dashboard stream (issue #149). The timeline
// used to move only when a `task_updated` for this task happened to arrive
// and trigger a full `GET /api/tasks/:id`; `task_event` now streams each row
// as it is written, and must fold into local state WITHOUT a refetch — these
// fire continuously while a task runs.

function row(overrides: Partial<TaskEventResponse> = {}): TaskEventResponse {
  return {
    id: 1,
    task_id: 42,
    event_type: 'workspace_cloned',
    message: 'Workspace cloned for owner/repo',
    created_at: '2026-05-12T12:31:59.000Z',
    ...overrides,
  };
}

function taskEvent(event: TaskEventResponse): DashboardWsEvent {
  return { type: 'task_event', taskId: event.task_id, event };
}

/** Drives the component's handler against a tiny state double. */
function harness(taskId: number | undefined, events: TaskEventResponse[] = []) {
  const refetch = vi.fn();
  let current = events;
  return {
    refetch,
    events: () => current,
    send(event: DashboardWsEvent) {
      handleDashboardEvent(event, {
        taskId,
        refetch,
        appendEvent: (r) => {
          current = appendTaskEvent(current, r);
        },
      });
    },
  };
}

describe('TaskDetail dashboard-event handling', () => {
  it('appends an arriving task_event without refetching the task', () => {
    const h = harness(42);

    h.send(taskEvent(row({ id: 7, message: 'Branch created' })));

    expect(h.events().map((e) => e.id)).toEqual([7]);
    expect(h.events()[0].message).toBe('Branch created');
    // The whole point: no GET /api/tasks/:id for a timeline row.
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('does not duplicate a row that arrives twice', () => {
    const h = harness(42);

    // A `task_updated` refetch can land the same row the stream just
    // delivered, so the same id is expected to show up more than once.
    h.send(taskEvent(row({ id: 7 })));
    h.send(taskEvent(row({ id: 7 })));

    expect(h.events()).toHaveLength(1);
    expect(h.events().map((e) => e.id)).toEqual([7]);
  });

  it('keeps arrival order across several rows', () => {
    const h = harness(42);

    h.send(taskEvent(row({ id: 7, message: 'first' })));
    h.send(taskEvent(row({ id: 8, message: 'second' })));
    h.send(taskEvent(row({ id: 9, message: 'third' })));

    expect(h.events().map((e) => e.message)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('ignores a task_event for a different task', () => {
    const h = harness(42);

    h.send(taskEvent(row({ id: 7, task_id: 99 })));

    expect(h.events()).toEqual([]);
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('ignores events entirely before the task has loaded', () => {
    const h = harness(undefined);

    h.send(taskEvent(row({ id: 7 })));

    expect(h.events()).toEqual([]);
    expect(h.refetch).not.toHaveBeenCalled();
  });

  it('still refetches on a task_updated for this task', () => {
    const h = harness(42);

    h.send({
      type: 'task_updated',
      task: { id: 42 } as never,
    });

    // task_updated carries the task but not its attempts/events, so the
    // full fetch stays the reconciliation path for those.
    expect(h.refetch).toHaveBeenCalledWith(42);
  });

  it('ignores a task_updated for another task and non-task events', () => {
    const h = harness(42);

    h.send({ type: 'task_updated', task: { id: 43 } as never });
    h.send({ type: 'task_created', task: { id: 44 } as never });
    h.send({
      type: 'status_changed',
      paused: false,
      hostPool: {
        memory_used_mb: 0,
        memory_total_mb: 1,
        cpu_used_cores: 0,
        cpu_total_cores: 1,
      },
      queueDepth: 0,
    });

    expect(h.refetch).not.toHaveBeenCalled();
    expect(h.events()).toEqual([]);
  });
});

describe('appendTaskEvent', () => {
  it('returns the SAME array when the row is already held', () => {
    const events = [row({ id: 7 })];

    // Identity is load-bearing: TaskDetail uses it to skip a re-render.
    expect(appendTaskEvent(events, row({ id: 7 }))).toBe(events);
  });

  it('tolerates an undefined events list', () => {
    expect(appendTaskEvent(undefined, row({ id: 7 })).map((e) => e.id)).toEqual([
      7,
    ]);
  });

  it('passes the row through untouched, timestamp included', () => {
    // Timestamps are normalized at render time by Timeline (issue #72), so a
    // streamed row and a refetched one must reach it in the same shape.
    const legacy = row({ id: 7, created_at: '2026-05-12 12:31:59' });
    expect(appendTaskEvent([], legacy)[0]).toEqual(legacy);
  });
});
