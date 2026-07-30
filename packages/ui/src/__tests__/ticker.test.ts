import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeTicker, _activeTickerCount } from '../ticker.js';

// The ticker exists so a running task's elapsed time advances on its own,
// without waiting for an unrelated store mutation to force a re-render.
// The properties that matter are cost properties: ONE interval shared by
// every row that displays a duration, and NO interval at all when nothing
// is on screen that needs one.
describe('shared ticker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs no timer until something subscribes', () => {
    expect(_activeTickerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('notifies the subscriber once per period', () => {
    const tick = vi.fn();
    const stop = subscribeTicker(1_000, tick);

    vi.advanceTimersByTime(3_000);
    expect(tick).toHaveBeenCalledTimes(3);

    stop();
  });

  it('shares a single interval across many subscribers of the same period', () => {
    // The pre-ticker alternative was a timer per row; 50 active tasks must
    // still cost exactly one interval.
    const stops = Array.from({ length: 50 }, () =>
      subscribeTicker(1_000, vi.fn())
    );

    expect(_activeTickerCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    for (const stop of stops) stop();
  });

  it('keeps distinct periods on their own intervals', () => {
    const stopFast = subscribeTicker(1_000, vi.fn());
    const stopSlow = subscribeTicker(30_000, vi.fn());

    expect(_activeTickerCount()).toBe(2);

    stopFast();
    stopSlow();
  });

  it('ticks each period at its own cadence', () => {
    const fast = vi.fn();
    const slow = vi.fn();
    const stopFast = subscribeTicker(1_000, fast);
    const stopSlow = subscribeTicker(30_000, slow);

    vi.advanceTimersByTime(30_000);
    expect(fast).toHaveBeenCalledTimes(30);
    expect(slow).toHaveBeenCalledTimes(1);

    stopFast();
    stopSlow();
  });

  it('stops the interval once the last subscriber leaves', () => {
    // "Do not run it when there are no active tasks": the last card
    // unmounting must actually clear the timer, not just stop reading it.
    const first = subscribeTicker(1_000, vi.fn());
    const second = subscribeTicker(1_000, vi.fn());

    first();
    expect(_activeTickerCount()).toBe(1);

    second();
    expect(_activeTickerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts cleanly after going idle', () => {
    subscribeTicker(1_000, vi.fn())();
    expect(_activeTickerCount()).toBe(0);

    const tick = vi.fn();
    const stop = subscribeTicker(1_000, tick);
    vi.advanceTimersByTime(2_000);

    expect(_activeTickerCount()).toBe(1);
    expect(tick).toHaveBeenCalledTimes(2);

    stop();
  });

  it('lets a listener unsubscribe from inside a tick', () => {
    // Leaf components unmount in response to the very re-render a tick
    // causes, so the dispatch loop must tolerate the set mutating.
    const stops: Array<() => void> = [];
    const survivor = vi.fn();
    stops.push(
      subscribeTicker(1_000, () => {
        stops[0]();
      })
    );
    stops.push(subscribeTicker(1_000, survivor));

    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);

    stops[1]();
    expect(_activeTickerCount()).toBe(0);
  });
});
