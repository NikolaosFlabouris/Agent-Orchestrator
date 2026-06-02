/** Soft-logout control.
 *
 * Renders a body-less `method="post"` form targeting `/auth/logout`.
 * Logout is a POST-only route on purpose: a state-changing GET is
 * reachable via a top-level cross-origin navigation (a hostile link or
 * `<img src>` would suffice), which would let any other origin force a
 * logout. POST + `sameSite=lax` on the session cookie closes that gap —
 * a cross-site form POST carries no session cookie, so the handler runs
 * without a session and the attacker's POST is a no-op. No CSRF token
 * is needed.
 *
 * It must be a full-page form submit (not a `fetch` or a React-Router
 * `<Link>`): the browser navigates to the server, which clears the
 * cookie and redirects on to the public `/signed-out` page. A `fetch`
 * would swallow that redirect; a `<Link>` never hits the server at all.
 *
 * The button is styled to read as the same inline text link it
 * replaced, so callers pass through the per-header `className` (e.g. the
 * `text-sm` variant used in the secondary headers).
 */
export function SignOutButton({ className = '' }: { className?: string }) {
  return (
    <form method="post" action="/auth/logout" className="inline">
      <button
        type="submit"
        className={`cursor-pointer border-0 bg-transparent p-0 text-blue-400 hover:text-blue-300 ${className}`}
      >
        Sign out
      </button>
    </form>
  );
}
