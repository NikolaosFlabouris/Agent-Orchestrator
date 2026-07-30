import { useCallback, useSyncExternalStore } from 'react';

/** Shared wallclock tickers.
 *
 *  Relative timestamps (`elapsed`, `timeAgo`) are computed during render
 *  from `Date.now()`, so without a ticker they only advance when some
 *  unrelated store mutation happens to re-render the component — a
 *  running task's duration stood still or jumped in 30-second steps.
 *
 *  One interval per distinct period is shared by every subscriber, and it
 *  only exists while something is subscribed: with no active tasks on
 *  screen nothing subscribes to the 1s ticker and no timer runs. Callers
 *  should subscribe from the smallest component that renders a duration
 *  so a tick re-renders a `<span>`, not a page. */
interface Ticker {
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** Monotonic counter — the `useSyncExternalStore` snapshot. Must be a
   *  primitive that changes exactly once per tick. */
  version: number;
}

const tickers = new Map<number, Ticker>();

function getTicker(periodMs: number): Ticker {
  let ticker = tickers.get(periodMs);
  if (!ticker) {
    ticker = { listeners: new Set(), timer: null, version: 0 };
    tickers.set(periodMs, ticker);
  }
  return ticker;
}

/** Register `onTick` on the shared interval for `periodMs`, creating the
 *  interval if this is the first subscriber and clearing it when the last
 *  one leaves. Returns the unsubscribe.
 *
 *  Exported (rather than kept private behind `useTicker`) because this is
 *  where the "one interval per period, none when idle" guarantee lives,
 *  and the UI suite has no DOM renderer to exercise the hook through. */
export function subscribeTicker(
  periodMs: number,
  onTick: () => void
): () => void {
  const ticker = getTicker(periodMs);
  ticker.listeners.add(onTick);
  if (ticker.timer === null) {
    ticker.timer = setInterval(() => {
      ticker.version++;
      for (const listener of [...ticker.listeners]) listener();
    }, periodMs);
  }
  return () => {
    ticker.listeners.delete(onTick);
    if (ticker.listeners.size === 0 && ticker.timer !== null) {
      clearInterval(ticker.timer);
      ticker.timer = null;
    }
  };
}

/** Re-render the calling component every `periodMs`. Returns the tick
 *  counter, which callers can ignore — reading it is what registers the
 *  subscription. */
export function useTicker(periodMs: number): number {
  const subscribeToPeriod = useCallback(
    (onTick: () => void) => subscribeTicker(periodMs, onTick),
    [periodMs]
  );
  return useSyncExternalStore(
    subscribeToPeriod,
    () => getTicker(periodMs).version,
    () => 0
  );
}

/** Test helper: number of live intervals (0 when nothing is subscribed). */
export function _activeTickerCount(): number {
  let count = 0;
  for (const ticker of tickers.values()) if (ticker.timer !== null) count++;
  return count;
}
