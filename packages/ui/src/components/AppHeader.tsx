import type { ReactNode } from 'react';
import { useStore } from '../store.js';

/** Shared sticky topbar used across every authenticated view.
 *  Extracted from the dashboard's header so the signed-in user chip
 *  and the Sign-out control live in exactly one place rather than
 *  being copy-pasted into each view's header.
 *
 *  Layout: a single row with a left column (back link, title, meta)
 *  and a right column (view-specific controls, then the UserChip and
 *  Sign-out link). Each view decides what to put in the controls slot
 *  — this component owns the chrome, the user chip, and Sign out. */
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
  return (
    <header className="sticky top-0 z-20 border-b border-gray-800 bg-gray-900 px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {back && <div className="mb-1">{back}</div>}
          {title && <h1 className="text-xl font-semibold">{title}</h1>}
          {meta && <div className="mt-1">{meta}</div>}
        </div>
        <div className="flex items-center gap-6 text-sm flex-shrink-0">
          {children}
          <UserChip />
          {/* Soft logout — full-page nav to the server endpoint, which
              clears the session cookie and redirects to /signed-out.
              Must be <a>, not <Link>, or the server never sees it.
              Rendered unconditionally (even in auth-disabled dev mode)
              so the control is always reachable. */}
          <a
            href="/auth/logout"
            className="text-blue-400 hover:text-blue-300"
          >
            Sign out
          </a>
        </div>
      </div>
    </header>
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
