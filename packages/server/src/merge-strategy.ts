/**
 * Merge-strategy resolution. Forgejo enforces which merge styles a repo
 * permits (set in repo settings). Calling the merge endpoint with a
 * disallowed `Do` value fails — so the orchestrator queries the repo's
 * allowed styles and adapts, rather than blindly using whatever the
 * operator stored on `repos.merge_strategy`.
 *
 * Resolution rules:
 *   1. If exactly one strategy is allowed, use it (the operator's preference
 *      is moot — the repo only permits one option).
 *   2. If multiple are allowed and the operator's preferred strategy is in
 *      the allowed set, use it.
 *   3. Otherwise, fall back to the first allowed strategy in PRIORITY_ORDER.
 *
 * The user-selectable preference (UI dropdown, repos.merge_strategy column)
 * stays narrow at squash / merge / rebase. The runtime resolution can pick
 * any of Forgejo's five values when falling back, which covers repos that
 * only allow rebase-merge or fast-forward-only without forcing those into
 * the operator's mental model.
 */

/** The three options exposed in the UI for `repos.merge_strategy`. */
export type PreferredMergeStrategy = 'squash' | 'merge' | 'rebase';

/** Full set of `Do` values Forgejo's merge endpoint accepts.
 *  `manually-merged` is admin-only and not selectable by the orchestrator. */
export type ForgejoMergeStrategy =
  | 'squash'
  | 'merge'
  | 'rebase'
  | 'rebase-merge'
  | 'fast-forward-only';

/** Fallback order when the operator's preferred strategy isn't allowed.
 *  Squash first because it matches the orchestrator's app-level default
 *  preference and is the most common modern default; merge next for repos
 *  that prefer keeping the branch history; the rebase variants and
 *  fast-forward-only after that since they impose more constraints. */
const PRIORITY_ORDER: ForgejoMergeStrategy[] = [
  'squash',
  'merge',
  'rebase',
  'rebase-merge',
  'fast-forward-only',
];

export interface ResolveResult {
  /** Strategy to send to Forgejo's merge endpoint. */
  strategy: ForgejoMergeStrategy;
  /** Why this strategy was chosen. Populated for log clarity. */
  reason: 'only-allowed' | 'preferred' | 'fallback';
}

/**
 * Pure resolver. Called by `attemptMerge` after fetching the repo's allowed
 * strategies. Throws if `allowed` is empty (a misconfigured repo).
 */
export function resolveMergeStrategy(
  allowed: ForgejoMergeStrategy[],
  preferred: PreferredMergeStrategy
): ResolveResult {
  if (allowed.length === 0) {
    throw new Error(
      'Repo has no allowed merge strategies — check the Forgejo repo settings'
    );
  }
  if (allowed.length === 1) {
    return { strategy: allowed[0], reason: 'only-allowed' };
  }
  if ((allowed as ForgejoMergeStrategy[]).includes(preferred)) {
    return { strategy: preferred, reason: 'preferred' };
  }
  for (const candidate of PRIORITY_ORDER) {
    if (allowed.includes(candidate)) {
      return { strategy: candidate, reason: 'fallback' };
    }
  }
  // Unreachable: allowed is non-empty and PRIORITY_ORDER covers every
  // Forgejo strategy. Defensive throw rather than silent return.
  throw new Error(
    `Repo allowed strategies [${allowed.join(', ')}] don't intersect known set`
  );
}
