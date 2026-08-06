import { useCallback, useSyncExternalStore } from 'react';

/** Reactive `window.matchMedia`. Tailwind's responsive classes cover layout,
 *  but a handful of props are plain JavaScript values — Recharts axis widths,
 *  tick intervals — and those need the breakpoint as a boolean. Subscribing to
 *  the media query list's `change` event (rather than polling or listening to
 *  every `resize`) means a re-render happens exactly when the breakpoint is
 *  crossed. */

/** One MediaQueryList per query for the whole page: `matchMedia` allocates a
 *  new object per call, and `useSyncExternalStore` calls the snapshot on every
 *  render. */
const lists = new Map<string, MediaQueryList>();

function mediaQueryList(query: string): MediaQueryList | null {
  // Non-browser environments (tests, any future SSR build) have no matchMedia.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return null;
  let list = lists.get(query);
  if (!list) {
    list = window.matchMedia(query);
    lists.set(query, list);
  }
  return list;
}

const NOT_MATCHED = () => false;

/** True while `query` matches. Falls back to `false` when `matchMedia` is
 *  unavailable, so callers should phrase queries such that `false` means the
 *  default (desktop) rendering. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaQueryList(query);
      if (!list) return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );
  const snapshot = useCallback(
    () => mediaQueryList(query)?.matches ?? false,
    [query]
  );
  // Server snapshot: never rendered on a server here, but React requires the
  // third argument for `useSyncExternalStore` in SSR-capable builds.
  return useSyncExternalStore(subscribe, snapshot, NOT_MATCHED);
}

/** Everything below Tailwind's `sm` breakpoint (640px) — phone widths. The
 *  fractional bound mirrors Tailwind's own `max-sm:` so a viewport of, say,
 *  639.5px doesn't fall between the CSS and the JS rules. */
export const SMALL_SCREEN = '(max-width: 639.98px)';
