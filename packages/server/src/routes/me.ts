import type { FastifyInstance } from 'fastify';
import { getSessionFromRequest } from '../auth.js';

/** GET /api/me — returns the Forgejo identity captured at /auth/callback.
 *
 *  Reads exclusively from the signed session cookie; no Forgejo round-
 *  trip. The /api/* auth hook (auth.ts) has already gated the route by
 *  the time this handler runs, so an unauthenticated request would
 *  never reach here — the 401 path is the hook's. We re-read the
 *  session here only to extract `user` from it.
 *
 *  When auth is disabled (ORCHESTRATOR_ALLOW_UNAUTHENTICATED=1), the
 *  hook is not registered, so we may genuinely have no session here.
 *  In that case the body is `{ user: null }` rather than 401 so the
 *  UI's AuthGate still resolves and renders the dev-mode dashboard. */
export function createMeRoutes() {
  return async function meRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/me', async (request) => {
      const session = getSessionFromRequest(request);
      return { user: session?.user ?? null };
    });
  };
}
