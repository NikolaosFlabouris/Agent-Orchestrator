import { Link, useLocation } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader.js';

/** Catch-all for unknown paths. Without it an unmatched URL — a stale
 *  bookmark, a mistyped task id — matched no route, so the layout
 *  rendered an empty <Outlet> and the visitor got a blank page with no
 *  way back. It sits inside the authenticated layout so it keeps the
 *  usual chrome (and the usual sign-in redirect for a signed-out
 *  visitor) rather than becoming a second public route. */
export function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader
        back={
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
            &larr; Dashboard
          </Link>
        }
        title="Page not found"
      />

      <main className="mx-auto max-w-7xl px-6 py-6 space-y-4">
        <p className="text-sm text-gray-400">
          {/* `break-all` because the unmatched path is arbitrary and an
              unbroken one would widen the document at 375px. */}
          Nothing lives at{' '}
          <span className="font-mono text-gray-300 break-all">{pathname}</span>. The page may
          have moved, or the link may be wrong.
        </p>
        <Link to="/" className="inline-block text-sm text-blue-400 hover:text-blue-300">
          Go to the dashboard
        </Link>
      </main>
    </div>
  );
}
