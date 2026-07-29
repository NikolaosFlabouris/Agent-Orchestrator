/**
 * Pure predicates over the `task_dependencies` projection.
 *
 * Deliberately a LEAF module: it imports nothing but shared types, so the
 * task serializer (`task-view.ts`, reached from `ws/dashboard.ts`) can use
 * it without pulling in `dependencies.ts` — which imports `state-sync.ts`
 * and `ws/dashboard.ts` and would close an import cycle.
 *
 * `dependencies.ts` re-exports everything here, so call sites and tests can
 * keep importing from the module that owns the dependency concept.
 */

import type { TaskDependency } from '@orchestrator/shared';
import { SATISFIED_DEP_STATES } from '@orchestrator/shared';

/** A task is blocked when any dependency is not satisfied. Zero deps =
 *  not blocked. */
export function isBlocked(deps: readonly TaskDependency[]): boolean {
  return deps.some((d) => !SATISFIED_DEP_STATES.has(d.state));
}

/** Issue numbers of the dependencies that are currently gating launch. */
export function unsatisfiedDepIssues(
  deps: readonly TaskDependency[]
): number[] {
  return deps
    .filter((d) => !SATISFIED_DEP_STATES.has(d.state))
    .map((d) => d.dep_issue_number);
}
