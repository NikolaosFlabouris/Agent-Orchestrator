/**
 * The shared ticker behind the live duration labels.
 *
 * Durations used to be computed during render with no ticker at all, so a
 * running task's elapsed time only advanced when some unrelated store
 * mutation re-rendered it. The fix must not trade that for one timer per
 * visible row — hence one interval per cadence, created lazily and cleared
 * when the last subscriber leaves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { subscribeTick, elapsed, timeAgo } from '../components/LiveTime.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeTick', () => {
  it('creates one interval for many subscribers on the same cadence', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const a = subscribeTick(1_000, () => {});
    const b = subscribeTick(1_000, () => {});
    const c = subscribeTick(1_000, () => {});

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    a();
    b();
    c();
    setIntervalSpy.mockRestore();
  });

  it('notifies every subscriber once per tick', () => {
    let a = 0;
    let b = 0;
    const releaseA = subscribeTick(1_000, () => {
      a += 1;
    });
    const releaseB = subscribeTick(1_000, () => {
      b += 1;
    });

    vi.advanceTimersByTime(3_000);

    expect(a).toBe(3);
    expect(b).toBe(3);

    releaseA();
    releaseB();
  });

  it('clears the interval only when the last subscriber leaves', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const a = subscribeTick(1_000, () => {});
    const b = subscribeTick(1_000, () => {});

    a();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    b();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    // Nothing is left running once the page has no durations on screen.
    let ticks = 0;
    const c = subscribeTick(1_000, () => {
      ticks += 1;
    });
    c();
    vi.advanceTimersByTime(10_000);
    expect(ticks).toBe(0);

    clearIntervalSpy.mockRestore();
  });

  it('keeps distinct cadences independent', () => {
    let fast = 0;
    let slow = 0;
    const releaseFast = subscribeTick(1_000, () => {
      fast += 1;
    });
    const releaseSlow = subscribeTick(30_000, () => {
      slow += 1;
    });

    vi.advanceTimersByTime(30_000);
    expect(fast).toBe(30);
    expect(slow).toBe(1);

    releaseFast();
    releaseSlow();
  });
});

describe('elapsed', () => {
  it('advances every second as the clock moves, with no other input', () => {
    const startedAt = '2026-01-01T11:59:30Z';

    expect(elapsed(startedAt)).toBe('30s');
    vi.advanceTimersByTime(1_000);
    expect(elapsed(startedAt)).toBe('31s');
    vi.advanceTimersByTime(1_000);
    expect(elapsed(startedAt)).toBe('32s');
  });

  it('rolls up into minutes and hours', () => {
    expect(elapsed('2026-01-01T11:55:00Z')).toBe('5m');
    expect(elapsed('2026-01-01T09:30:00Z')).toBe('2h 30m');
  });
});

describe('timeAgo', () => {
  it('formats each granularity', () => {
    expect(timeAgo('2026-01-01T11:59:30Z')).toBe('just now');
    expect(timeAgo('2026-01-01T11:45:00Z')).toBe('15m ago');
    expect(timeAgo('2026-01-01T09:00:00Z')).toBe('3h ago');
    expect(timeAgo('2025-12-29T12:00:00Z')).toBe('3d ago');
  });
});
