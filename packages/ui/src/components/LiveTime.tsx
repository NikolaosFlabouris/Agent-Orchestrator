import { useCallback, useSyncExternalStore } from 'react';

/** Shared tickers, one interval per distinct cadence for the whole page.
 *
 *  Durations used to be computed during render with no ticker at all, so a
 *  running task's elapsed time only advanced when some unrelated store
 *  mutation happened to re-render it — jumping in 30-second steps or
 *  standing still. The fix is a ticker, but a naive `useEffect` +
 *  `setInterval` per row would spawn one timer per visible task and re-render
 *  the whole Dashboard on every tick.
 *
 *  Instead: components subscribe to a cadence, the interval is created lazily
 *  on the first subscriber and cleared when the last one leaves (so a page
 *  with no active tasks runs no timer at all), and only the leaf components
 *  that actually display a duration re-render. */
interface Ticker {
  timer: ReturnType<typeof setInterval>;
  listeners: Set<() => void>;
  /** Monotonic counter, not a timestamp: `useSyncExternalStore` requires a
   *  snapshot that is stable between ticks and changes on every tick. */
  version: number;
}

const tickers = new Map<number, Ticker>();

/** Register `onTick` on the shared ticker for `intervalMs`, creating the
 *  interval if this is its first subscriber. Returns the unsubscribe, which
 *  clears the interval once the last subscriber leaves. Exported for tests;
 *  components should use `useTicker`. */
export function subscribeTick(
  intervalMs: number,
  onTick: () => void
): () => void {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const created: Ticker = {
      listeners: new Set(),
      version: 0,
      timer: setInterval(() => {
        created.version += 1;
        for (const listener of [...created.listeners]) listener();
      }, intervalMs),
    };
    tickers.set(intervalMs, created);
    ticker = created;
  }
  ticker.listeners.add(onTick);

  return () => {
    const current = tickers.get(intervalMs);
    if (!current) return;
    current.listeners.delete(onTick);
    if (current.listeners.size === 0) {
      clearInterval(current.timer);
      tickers.delete(intervalMs);
    }
  };
}

/** Re-render the calling component every `intervalMs`. Returns an opaque
 *  tick counter — callers read the clock themselves. */
export function useTicker(intervalMs: number): number {
  const subscribe = useCallback(
    (onTick: () => void) => subscribeTick(intervalMs, onTick),
    [intervalMs]
  );
  const snapshot = useCallback(
    () => tickers.get(intervalMs)?.version ?? 0,
    [intervalMs]
  );
  // Server snapshot: never rendered on a server here, but React requires the
  // third argument for `useSyncExternalStore` in SSR-capable builds.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const SECOND_MS = 1_000;
/** `timeAgo` bottoms out at minute granularity, so a per-second tick would
 *  re-render 30 times for every visible change. */
const TIME_AGO_TICK_MS = 30_000;

export function elapsed(startedAt: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(startedAt).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Countdown to a scheduled retry (`tasks.prep_next_attempt_at` /
 *  `salvage_next_attempt_at`, both written as ISO UTC by the scheduler).
 *  Reads "in 3m 12s"; once the timestamp has passed — or when nothing is
 *  scheduled — it reads "now", because the retry then happens on the very
 *  next scheduler tick. Pure: `now` is injected so tests need no clock. */
export function retryIn(at: string | null, now: number = Date.now()): string {
  if (!at) return 'now';
  const target = new Date(at).getTime();
  if (Number.isNaN(target)) return 'now';
  const seconds = Math.ceil((target - now) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours}h ${minutes % 60}m`;
}

export function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Live-updating "how long has this been running" label. Ticks once a
 *  second; mounting none of these leaves no timer running. */
export function Elapsed({ startedAt }: { startedAt: string }) {
  useTicker(SECOND_MS);
  return <>{elapsed(startedAt)}</>;
}

/** Live-updating "retry in …" countdown. Per-second cadence — a countdown
 *  that only moved every 30s would look stuck for most of a short backoff. */
export function RetryIn({ at }: { at: string | null }) {
  useTicker(SECOND_MS);
  return <>{retryIn(at)}</>;
}

/** Live-updating "how long ago" label, on the coarser 30s cadence. */
export function TimeAgo({ date }: { date: string }) {
  useTicker(TIME_AGO_TICK_MS);
  return <>{timeAgo(date)}</>;
}
