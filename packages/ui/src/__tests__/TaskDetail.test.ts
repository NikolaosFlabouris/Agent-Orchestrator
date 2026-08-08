import { describe, it, expect, vi } from 'vitest';
import {
  handleDashboardEvent,
  appendTaskEvent,
  applyTaskEvent,
  deriveLastFailure,
} from '../views/TaskDetail.js';
import type { TaskDetailResponse, TaskEventResponse } from '../api.js';
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

function detail(events: TaskEventResponse[]): TaskDetailResponse {
  return { id: 42, events } as unknown as TaskDetailResponse;
}

/** Drives the component's handler against a state double that stands in for
 *  `setTask`. `appendEvent` runs the component's OWN updater (`applyTaskEvent`)
 *  rather than a reimplementation, so a regression in that closure fails here. */
function harness(taskId: number | undefined, events: TaskEventResponse[] = []) {
  const refetch = vi.fn();
  let current: TaskDetailResponse | null = detail(events);
  return {
    refetch,
    task: () => current,
    events: () => current?.events ?? [],
    send(event: DashboardWsEvent) {
      handleDashboardEvent(event, {
        taskId,
        refetch,
        appendEvent: (r) => {
          current = applyTaskEvent(current, r);
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

// The `setTask` updater itself. Covered directly because a regression here —
// dropping the identity check, or spreading the rows into the wrong key —
// would leave every routing test above green while breaking the live timeline.
describe('applyTaskEvent', () => {
  it('returns a NEW task whose events end with the appended row', () => {
    const prev = detail([row({ id: 7 })]);

    const next = applyTaskEvent(prev, row({ id: 8, message: 'Branch created' }));

    expect(next).not.toBe(prev);
    expect(next!.events.map((e) => e.id)).toEqual([7, 8]);
    expect(next!.events.at(-1)!.message).toBe('Branch created');
    // Only `events` moves — the rest of the loaded task is preserved.
    expect(next!.id).toBe(prev.id);
    expect(prev.events.map((e) => e.id)).toEqual([7]);
  });

  it('returns the SAME task object for a duplicate row id', () => {
    const prev = detail([row({ id: 7 })]);

    // Identity is what makes React skip the re-render.
    expect(applyTaskEvent(prev, row({ id: 7 }))).toBe(prev);
  });

  it('is a no-op before the task has loaded', () => {
    expect(applyTaskEvent(null, row({ id: 7 }))).toBeNull();
  });
});

// Which event the failure banner promotes above the timeline (#173). Before
// this, only the two structural prep failures got a banner and every other
// way a task can die — no diff produced, salvage/PR/prep errors, timeout
// kills, orphan exhaustion — was one timeline row among twenty, visually
// identical to "Workspace cloned".
describe('deriveLastFailure', () => {
  /** Rows in the server's order: `created_at ASC, id ASC`. */
  function events(...types: string[]) {
    return types.map((event_type, i) =>
      row({ id: i + 1, event_type, message: `${event_type} message` })
    );
  }

  it('returns nothing for a task that is not failed or queued', () => {
    for (const status of ['in-progress', 'in-review', 'merged', 'cancelled']) {
      expect(deriveLastFailure(events('status_failed'), status)).toBeNull();
    }
  });

  it('returns nothing when a failed task recorded no failure-class event', () => {
    expect(
      deriveLastFailure(events('workspace_cloned', 'container_started'), 'failed')
    ).toBeNull();
  });

  it('tolerates a missing events list', () => {
    expect(deriveLastFailure(undefined, 'failed')).toBeNull();
  });

  it('surfaces each non-structural failure class with the failure heading', () => {
    for (const type of [
      'no_changes',
      'salvage_failed',
      'pr_creation_failed',
      'prep_failed',
      'salvage_push_failed',
      'container_timeout_kill',
      'orphan_recovery_exhausted',
    ]) {
      const failure = deriveLastFailure(events(type), 'failed');
      expect(failure).not.toBeNull();
      expect(failure!.event.event_type).toBe(type);
      expect(failure!.kind).toBe('failure');
      // The banner renders the server's message verbatim.
      expect(failure!.event.message).toBe(`${type} message`);
    }
  });

  it('marks the structural types so they keep their operator-action heading', () => {
    for (const type of ['agent_image_missing', 'harness_entrypoint_exec_failed']) {
      expect(deriveLastFailure(events(type), 'failed')!.kind).toBe('structural');
    }
  });

  it('prefers the specific failure over the generic status_failed beside it', () => {
    // The real shape of a failure episode: the specific reason is written
    // first, then state-sync appends the generic status row. Picking "the
    // latest" naively would always land on the useless one.
    const failure = deriveLastFailure(
      events('container_started', 'no_changes', 'status_failed'),
      'failed'
    );
    expect(failure!.event.event_type).toBe('no_changes');
  });

  it('falls back to status_failed when nothing more specific was recorded', () => {
    const failure = deriveLastFailure(
      events('container_started', 'status_failed'),
      'failed'
    );
    expect(failure!.event.event_type).toBe('status_failed');
    expect(failure!.kind).toBe('failure');
  });

  it('picks the most recent specific failure across several attempts', () => {
    const failure = deriveLastFailure(
      events('no_changes', 'status_failed', 'container_started', 'prep_failed'),
      'failed'
    );
    expect(failure!.event.event_type).toBe('prep_failed');
  });

  it('picks the latest status_failed when that is all there is', () => {
    const rows = [
      row({ id: 1, event_type: 'status_failed', message: 'first' }),
      row({ id: 2, event_type: 'status_failed', message: 'second' }),
    ];
    expect(deriveLastFailure(rows, 'failed')!.event.message).toBe('second');
  });

  it('keeps showing a structural failure while the task sits queued', () => {
    // A task bounces back to `queued` between transient prep retries, and a
    // reset leaves it there with the cause possibly unfixed — the operator
    // instruction has to survive the trip.
    const failure = deriveLastFailure(events('agent_image_missing'), 'queued');
    expect(failure!.event.event_type).toBe('agent_image_missing');
    expect(failure!.kind).toBe('structural');
  });

  it('does NOT surface a non-structural failure on a queued task', () => {
    // A queued task carrying a `no_changes` from a previous attempt is
    // waiting to run, not currently failing at anything.
    expect(deriveLastFailure(events('no_changes'), 'queued')).toBeNull();
    expect(
      deriveLastFailure(events('no_changes', 'status_failed'), 'queued')
    ).toBeNull();
  });
});
