import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';

/** Wraps the authenticated React tree and blocks render until
 *  GET /api/me resolves. Two reasons this exists:
 *
 *  1. Without it the dashboard would mount and start hitting /api/*
 *     before any auth check. An unauthenticated visitor sees a flash
 *     of the empty shell before the first 401 bounces them to
 *     /auth/login — visually broken and gives away the layout.
 *  2. The store needs the signed-in user before the shared header
 *     can render the user chip on every view. Doing it here keeps
 *     each view free of identity-loading boilerplate.
 *
 *  401 handling lives in `api.ts` — a failed /api/me redirects the
 *  whole window to /auth/login, so we never reach the `setReady`
 *  branch for unauthenticated users. The catch below covers transient
 *  non-401 failures (orchestrator restarting, network blip) — we let
 *  the UI render anyway with user=null so the app isn't permanently
 *  stuck on the loading screen. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const setUser = useStore((s) => s.setUser);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .getMe()
      .then((res) => {
        setUser(res.user);
        setReady(true);
      })
      .catch(() => {
        // 401s redirect via api.ts — anything that reaches this
        // catch is a transient failure. Render anyway so we don't
        // wedge the UI on a server hiccup.
        setReady(true);
      });
  }, [setUser]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
