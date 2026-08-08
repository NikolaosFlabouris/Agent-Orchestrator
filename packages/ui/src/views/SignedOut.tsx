import { buttonClasses } from '../components/Button.js';

/** Public landing page shown after `/auth/logout` clears the
 *  orchestrator session cookie. Renders without an authenticated
 *  session and MUST NOT call any `/api/*` endpoint — the global
 *  401-handler in `api.ts` would redirect straight back into the
 *  Forgejo login flow, making logout feel like a no-op.
 *
 *  Sign-in is soft: clicking the link bounces through `/auth/login`,
 *  which Forgejo may complete with a single click if the upstream SSO
 *  session is still alive. The logout handler intentionally does not
 *  end the Forgejo session. */
export function SignedOut() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center space-y-6">
        <h1 className="text-2xl font-semibold">You're signed out</h1>
        <p className="text-gray-400 text-sm">
          Your orchestrator session has ended. You can sign back in at
          any time.
        </p>
        {/* The page's only control, and on a phone the only thing to aim
            at: `min-h-11` (44px) is the minimum comfortable touch target,
            which `py-2` alone falls short of. `inline-flex` centres the
            label inside that taller box; from `sm` up the min-height is
            released, so the button keeps its original size. */}
        <a
          href="/auth/login"
          className={buttonClasses(
            'primary',
            'inline-flex items-center justify-center min-h-11 sm:min-h-0 px-4 py-2 text-sm font-medium'
          )}
        >
          Sign in
        </a>
      </div>
    </div>
  );
}
