import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useStore } from '../store.js';
import { subscribeDashboard } from '../ws.js';
import type { DashboardWsEvent } from '../ws.js';

/** Owns the one dashboard WebSocket for the whole authenticated app and
 *  pumps its events into the store.
 *
 *  Mounted by `GatedLayout` above the <Outlet>, so it stays mounted across
 *  every route change: navigating Dashboard → TaskDetail → Dashboard no
 *  longer tears the socket down and cold-starts a replacement (new
 *  connection, new snapshot, new slow REST fetch). Store state therefore
 *  stays live no matter which view is on screen — Reports and Settings
 *  included.
 *
 *  Views that need the raw event stream (TaskDetail, which refetches its own
 *  task on `task_updated`) call `useDashboardEvents` rather than opening a
 *  second socket. */
export function LiveData({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Actions come from getState() — we only invoke them, so subscribing
    // would add re-render churn for nothing.
    const {
      setSnapshot,
      updateTask,
      addTask,
      setStatus,
      bumpResourceVersion,
      setConnection,
    } = useStore.getState();

    const handler = (event: DashboardWsEvent) => {
      switch (event.type) {
        case 'snapshot':
          // Wholesale replace on (re)connect — intentional, see
          // docs/06-web-ui.md. Merging would keep rows the server no
          // longer knows about.
          setSnapshot(event);
          break;
        case 'task_updated':
          updateTask(event.task);
          break;
        case 'task_created':
          addTask(event.task);
          break;
        case 'status_changed':
          // Doubles as the server's heartbeat frame, so this fires every
          // ~25s even when nothing changed. setStatus is idempotent.
          setStatus(event);
          break;
        case 'resource_changed':
          // Bump the version counter — every Settings tab + the
          // Dashboard's profilesVersion useEffect subscribes to this and
          // refetches when it ticks. No inline fetch here: the bump is
          // debounced (store.ts), and an inline fetch would both bypass
          // that debounce and duplicate the request.
          bumpResourceVersion(event.resource);
          break;
      }
    };

    return subscribeDashboard(handler, setConnection);
  }, []);

  return <>{children}</>;
}

/** Subscribe a view to the shared dashboard stream for as long as it is
 *  mounted. The handler is held in a ref and refreshed on every render, so
 *  callers can pass an inline closure without resubscribing (and without
 *  reading stale props) — the subscription itself is created exactly once. */
export function useDashboardEvents(
  handler: (event: DashboardWsEvent) => void
): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribeDashboard((event) => ref.current(event)), []);
}
