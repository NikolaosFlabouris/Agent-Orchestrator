/**
 * Alert merge semantics (#173).
 *
 * `GET /api/status/alerts` recomputes the entire active set on every poll,
 * so the store REPLACES rather than accumulates — and the only stateful
 * thing on the client is which ids the operator dismissed. That dismissal
 * must survive re-polls of a still-live condition and must NOT survive the
 * condition clearing, or a "the git host is down" banner dismissed at 09:00
 * would stay invisible through the outage that starts at 15:00.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { OrchestratorAlert } from '@orchestrator/shared';
import { mergeAlerts, useStore } from '../store.js';

function alert(
  id: string,
  overrides: Partial<OrchestratorAlert> = {}
): OrchestratorAlert {
  return {
    id,
    level: 'warning',
    message: `alert ${id}`,
    task_id: null,
    ...overrides,
  };
}

const none = new Set<string>();

describe('mergeAlerts', () => {
  it('replaces the previous set wholesale', () => {
    const { alerts } = mergeAlerts([alert('a'), alert('b')], [alert('c')], none);
    expect(alerts.map((a) => a.id)).toEqual(['c']);
  });

  it('drops an alert the server no longer reports', () => {
    const { alerts } = mergeAlerts([alert('a')], [], none);
    expect(alerts).toEqual([]);
  });

  it('hides a dismissed alert that is still active', () => {
    const { alerts, dismissedAlertIds } = mergeAlerts(
      [],
      [alert('stuck:1'), alert('pool-saturated')],
      new Set(['stuck:1'])
    );
    expect(alerts.map((a) => a.id)).toEqual(['pool-saturated']);
    // Still reported by the server, so the dismissal is still needed.
    expect([...dismissedAlertIds]).toEqual(['stuck:1']);
  });

  it('forgets a dismissal once the condition clears, so a re-fire shows', () => {
    // Poll 1: dismissed while active.
    let state = mergeAlerts([], [alert('stuck:1')], new Set(['stuck:1']));
    expect(state.alerts).toEqual([]);
    expect([...state.dismissedAlertIds]).toEqual(['stuck:1']);

    // Poll 2: the task un-stuck itself — the id disappears from the
    // dismissed set along with the condition.
    state = mergeAlerts(state.alerts, [], state.dismissedAlertIds);
    expect([...state.dismissedAlertIds]).toEqual([]);

    // Poll 3: it gets stuck again. Same id, but nothing suppresses it now.
    state = mergeAlerts(state.alerts, [alert('stuck:1')], state.dismissedAlertIds);
    expect(state.alerts.map((a) => a.id)).toEqual(['stuck:1']);
  });

  it('keeps a dismissal across many polls while the condition persists', () => {
    let state = {
      alerts: [] as OrchestratorAlert[],
      dismissedAlertIds: new Set(['git-prep-backoff']),
    };
    for (let i = 0; i < 5; i++) {
      state = mergeAlerts(
        state.alerts,
        [alert('git-prep-backoff')],
        state.dismissedAlertIds
      );
      expect(state.alerts).toEqual([]);
    }
  });

  it('never carries a dismissed id that was never reported', () => {
    // Defensive: a stale id from an earlier session/condition must not
    // accumulate in the set forever.
    const { dismissedAlertIds } = mergeAlerts(
      [],
      [alert('a')],
      new Set(['ancient', 'a'])
    );
    expect([...dismissedAlertIds]).toEqual(['a']);
  });

  it('returns the SAME array when the visible list is unchanged', () => {
    // Identity is load-bearing: this runs on a 60s poll whose result is
    // usually identical, and a new array re-renders every subscriber.
    const prev = [alert('a'), alert('b')];
    const { alerts } = mergeAlerts(prev, [alert('a'), alert('b')], none);
    expect(alerts).toBe(prev);
  });

  it('returns a new array when a message changes under the same id', () => {
    // Alert messages carry live numbers (elapsed minutes, retry level), so
    // identity by id alone would freeze the text on screen.
    const prev = [alert('stuck:1', { message: 'running 90m' })];
    const { alerts } = mergeAlerts(
      prev,
      [alert('stuck:1', { message: 'running 150m' })],
      none
    );
    expect(alerts).not.toBe(prev);
    expect(alerts[0].message).toBe('running 150m');
  });

  it('returns a new array when only the order changes', () => {
    const prev = [alert('a'), alert('b')];
    const { alerts } = mergeAlerts(prev, [alert('b'), alert('a')], none);
    expect(alerts).not.toBe(prev);
    expect(alerts.map((a) => a.id)).toEqual(['b', 'a']);
  });
});

describe('store alert actions', () => {
  beforeEach(() => {
    useStore.setState({ alerts: [], dismissedAlertIds: new Set() });
  });

  it('setAlerts publishes the active set', () => {
    useStore.getState().setAlerts([alert('a'), alert('b')]);
    expect(useStore.getState().alerts.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('dismissAlert hides the row immediately, before the next poll', () => {
    useStore.getState().setAlerts([alert('a'), alert('b')]);
    useStore.getState().dismissAlert('a');

    expect(useStore.getState().alerts.map((x) => x.id)).toEqual(['b']);
    expect(useStore.getState().dismissedAlertIds.has('a')).toBe(true);
  });

  it('keeps a dismissed alert hidden when the next poll still reports it', () => {
    useStore.getState().setAlerts([alert('a'), alert('b')]);
    useStore.getState().dismissAlert('a');
    useStore.getState().setAlerts([alert('a'), alert('b')]);

    expect(useStore.getState().alerts.map((x) => x.id)).toEqual(['b']);
  });

  it('shows a dismissed alert again after it clears and re-fires', () => {
    useStore.getState().setAlerts([alert('a')]);
    useStore.getState().dismissAlert('a');
    useStore.getState().setAlerts([]); // condition cleared
    useStore.getState().setAlerts([alert('a')]); // and came back

    expect(useStore.getState().alerts.map((x) => x.id)).toEqual(['a']);
  });
});
