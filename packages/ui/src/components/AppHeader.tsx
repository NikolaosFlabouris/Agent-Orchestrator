import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store.js';
import { SignOutButton } from './SignOutButton.js';

/** Shared sticky topbar used across every authenticated view.
 *  Extracted from the dashboard's header so the signed-in user chip
 *  and the Sign-out control live in exactly one place rather than
 *  being copy-pasted into each view's header.
 *
 *  Layout: a single row with a left column (back link, title, meta)
 *  and a right column (view-specific controls, then the UserChip and
 *  Sign-out link). Each view decides what to put in the controls slot
 *  — this component owns the chrome, the user chip, and Sign out.
 *
 *  Below `lg` (1024px) that right column does not fit — it used to be a
 *  single non-wrapping row, which pushed the document wider than the
 *  viewport on every route. So under `lg` everything except the
 *  connection indicator collapses into a disclosure panel hung off the
 *  bottom of the sticky header. Desktop is untouched: the same markup
 *  is switched with `hidden`/`lg:contents`, so at `lg` and above the
 *  cluster is byte-for-byte the row it always was. */
export interface AppHeaderProps {
  /** Element rendered above the title — typically the "← Dashboard"
   *  link on detail views. Omit on the dashboard itself. */
  back?: ReactNode;
  /** Page title. Rendered as the <h1>. */
  title?: ReactNode;
  /** Optional content directly below the title row (subtitle line,
   *  branch/PR meta, etc.). The right column does not extend over it. */
  meta?: ReactNode;
  /** View-specific controls on the right, rendered before the
   *  user chip. */
  children?: ReactNode;
}

export function AppHeader({ back, title, meta, children }: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  /* Escape closes the panel and hands focus back to the toggle — the
     panel is a disclosure, so focus must not be left on a node that is
     about to be unmounted. Bound on the document (not the panel) so it
     works whether focus is inside the panel or still on the toggle. */
  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-20 border-b border-gray-800 bg-gray-900 px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {back && <div className="mb-1 min-w-0 break-words">{back}</div>}
          {title && (
            <h1 className="text-xl font-semibold break-words">{title}</h1>
          )}
          {meta && <div className="mt-1 min-w-0 break-words">{meta}</div>}
        </div>
        {/* `lg:flex-shrink-0` rather than a flat `flex-shrink-0`: at the
            desktop width the cluster must never be squeezed (as before),
            but below `lg` it has to be allowed to give way so the amber
            "data may be stale" chip wraps instead of widening the page. */}
        <div className="flex items-center gap-3 lg:gap-6 text-sm lg:flex-shrink-0">
          {/* `hidden lg:contents` keeps one copy of the markup: below
              `lg` the wrapper is display:none (so its contents leave the
              layout *and* the accessibility tree), and at `lg` it is
              display:contents, which dissolves it — the controls become
              direct flex items of the row again, gap-6 and all. */}
          <div className="hidden lg:contents">{children}</div>
          <ConnectionIndicator />
          <div className="hidden lg:contents">
            <UserChip />
            {/* Soft logout — a body-less POST form to the server endpoint,
                which clears the session cookie and redirects to
                /signed-out. POST (not a GET <a>) so a cross-origin
                navigation can't force a logout; see SignOutButton.
                Rendered unconditionally (even in auth-disabled dev mode)
                so the control is always reachable. */}
            <SignOutButton />
          </div>
          <button
            ref={toggleRef}
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
            /* min-h/min-w-11 = 44px, the minimum comfortable touch
               target; -my-2 keeps it from growing the header row. */
            className="lg:hidden -my-2 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-gray-300 hover:text-gray-100"
          >
            <MenuIcon open={menuOpen} />
          </button>
        </div>
      </div>
      {menuOpen && (
        <div
          id={menuId}
          /* Hung off the bottom of the sticky header, full-bleed via
             `-mx-6` against the header's own px-6. `lg:hidden` so a
             resize to desktop can't leave a stray panel on screen while
             the (hidden) toggle still reads as expanded. */
          className="lg:hidden -mx-6 mt-4 flex flex-col items-start gap-4 border-t border-gray-800 bg-gray-900 px-6 py-4 text-sm"
        >
          {children}
          <UserChip />
          <SignOutButton />
        </div>
      )}
    </header>
  );
}

/** Hamburger / close glyph for the disclosure toggle. Inline so the
 *  header keeps its zero-dependency footprint; `currentColor` so it
 *  inherits the button's gray palette. */
function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      {open ? (
        <path d="M5 5l10 10M15 5L5 15" />
      ) : (
        <path d="M3 6h14M3 10h14M3 14h14" />
      )}
    </svg>
  );
}

/** Health of the shared dashboard WebSocket. Because AppHeader is on every
 *  authenticated view and the socket is owned app-wide by `LiveData`, this
 *  indicator is visible everywhere — not just the Dashboard.
 *
 *  Healthy is deliberately quiet (a muted dot + "Live"); a dead feed gets an
 *  amber chip, because the failure mode this exists for is a client that
 *  looks perfectly healthy while showing minutes-old data. */
function ConnectionIndicator() {
  const connection = useStore((s) => s.connection);

  if (connection === 'connected') {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-gray-500"
        title="Live updates are connected"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-green-500"
          aria-hidden="true"
        />
        Live
      </span>
    );
  }

  return (
    <span
      role="status"
      className="flex items-center gap-1.5 rounded bg-amber-900 px-2 py-0.5 text-xs font-medium text-amber-300"
      title="The live update stream is down — retrying with backoff. Displayed data may be stale."
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
        aria-hidden="true"
      />
      Reconnecting — data may be stale
    </span>
  );
}

/** Avatar + login. Reads the signed-in user from the store (populated
 *  once by AuthGate on startup). Renders nothing when there's no
 *  identity — happens in dev-mode with auth disabled, or when the
 *  /auth/callback userinfo lookup failed (the session still works,
 *  the chip just stays hidden). */
function UserChip() {
  const user = useStore((s) => s.user);
  if (!user || !user.login) return null;
  const tooltip = user.name ? `${user.name} (${user.login})` : user.login;
  return (
    <div className="flex items-center gap-2" title={tooltip}>
      {user.avatar_url && (
        <img
          src={user.avatar_url}
          alt=""
          className="w-6 h-6 rounded-full bg-gray-800"
        />
      )}
      <span className="text-gray-300">{user.login}</span>
    </div>
  );
}
