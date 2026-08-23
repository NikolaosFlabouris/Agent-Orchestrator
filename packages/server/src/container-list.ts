/**
 * Memoized listing of the orchestrator's managed Docker containers.
 *
 * Task health derivation needs "which containers exist right now", and
 * every read path wants it: `GET /api/tasks`, the task-detail assembly
 * (`services/task-detail.ts`), `GET /api/reports/tasks`, and the MCP read
 * tools. Hitting the Docker socket once per caller meant N round-trips per
 * dashboard refresh, so the listing is shared behind a short TTL.
 *
 * Lives in its own module (rather than in `routes/tasks.ts`, where it used
 * to) so non-route consumers can use it without importing a route module —
 * `routes/tasks.ts` re-exports it for the existing call sites and tests.
 */

import { listContainers } from './docker.js';
import { getContainerDisplayName } from './orphan-recovery.js';

/** How long one `listContainers()` result is reused. Sized to be shorter
 *  than any UI cadence but long enough that the requests a single dashboard
 *  refresh fans out — N open tabs polling `GET /api/tasks`, plus the detail
 *  endpoint and the reports route — collapse onto one Docker round-trip
 *  instead of one each. Container health is derived from it, so it must
 *  stay short: a container that vanishes is noticed within this window. */
const CONTAINER_LIST_TTL_MS = 3_000;

/** In-flight-or-fresh managed-container listing. Holds the PROMISE, not the
 *  resolved value, so concurrent callers inside the window share the same
 *  round-trip rather than each starting their own. Every consumer only reads
 *  the set (`computeTaskHealth` does a `.has`), so handing out one shared
 *  instance is safe. */
let containerListCache: {
  expiresAt: number;
  promise: Promise<Set<string>>;
} | null = null;

/** Drop the memoized container listing. Exported for tests. */
export function _clearManagedContainerCache(): void {
  containerListCache = null;
}

export async function loadManagedContainerIds(
  log: Parameters<typeof getContainerDisplayName>[1]
): Promise<Set<string> | undefined> {
  // Returns undefined on Docker failure so callers propagate the "unknown"
  // signal down to enrichTask, which will fall back to the Docker-less
  // health derivation. Returning an empty Set here would incorrectly
  // flag every containerised task as orphaned.
  try {
    return await cachedManagedContainerIds();
  } catch (err) {
    log.warn(
      { event: 'tasks_route_docker_unavailable', err },
      'Could not list containers — task health will degrade to partial'
    );
    return undefined;
  }
}

function cachedManagedContainerIds(): Promise<Set<string>> {
  const now = Date.now();
  if (containerListCache && containerListCache.expiresAt > now) {
    return containerListCache.promise;
  }

  const promise = listContainers().then(
    (containers) => new Set(containers.map((c) => c.Id))
  );
  const entry = { expiresAt: now + CONTAINER_LIST_TTL_MS, promise };
  containerListCache = entry;

  // A rejection must not be served for the rest of the window — a daemon
  // that came back should be retried by the next caller. Concurrent callers
  // still share this one failed round-trip. The handler also keeps the
  // shared promise from surfacing as an unhandled rejection when every
  // caller happens to be a cache hit.
  promise.catch(() => {
    if (containerListCache === entry) containerListCache = null;
  });

  return promise;
}
