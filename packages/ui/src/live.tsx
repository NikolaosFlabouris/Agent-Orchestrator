import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { subscribeDashboardWs, dashboardConnectionState } from './ws.js';
import type { DashboardWsEvent } from './ws.js';
import { useStore } from './store.js';

/** Owns the one dashboard WebSocket for the whole authenticated app.
 *
 *  Mounted by `GatedLayout` *inside* `AuthGate` (so it never connects
 *  before identity resolves) and outside the route table, so navigating
 *  Dashboard → TaskDetail → Dashboard neither tears the socket down nor
 *  cold-starts a new snapshot. The store's snapshot / task_updated /
 *  task_created / status_changed / resource_changed handlers live here,
 *  which keeps store state live no matter which route is rendered.
 *
 *  Views that need the raw events (TaskDetail) subscribe through
 *  `useDashboardEvents`; nobody else opens a socket of their own. */
export function LiveDataProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    // Actions are read from getState() rather than subscribed to: they're
    // stable, and this component renders nothing that depends on them.
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
          // Wholesale replace, intentionally (docs/06-web-ui.md): a
          // reconnect snapshot is the authoritative view, so merging it
          // would let rows the server has forgotten survive forever.
          setSnapshot(event);
          break;
        case 'task_updated':
          updateTask(event.task);
          break;
        case 'task_created':
          addTask(event.task);
          break;
        case 'status_changed':
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

    setConnection(dashboardConnectionState());
    return subscribeDashboardWs(handler, { onState: setConnection });
  }, []);

  return <>{children}</>;
}

/**
 * Subscribe a view to the shared dashboard event stream.
 *
 * The handler is latched in a ref so an inline closure (the normal case)
 * doesn't resubscribe on every render — the subscription is created once
 * per mount and always calls the newest closure.
 */
export function useDashboardEvents(handler: (event: DashboardWsEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => subscribeDashboardWs((event) => latest.current(event)), []);
}
