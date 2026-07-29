/**
 * Forgejo snapshot cache.
 *
 * Captures the subset of Forgejo state the orchestrator needs in order to
 * derive an external-facing task status: the issue's open/closed state plus
 * its labels, and (if a PR exists) the PR's state/merged/mergeable/draft
 * fields. The cache is per-task (keyed by `task_id`) and has a short TTL;
 * webhooks should call `invalidateSnapshot` on relevant events so the UI
 * doesn't wait out the TTL for state changes that were already announced.
 *
 * Three read paths:
 *
 * - `peekSnapshot(taskId)` — cache-only, synchronous. Returns the cached
 *   entry (even if expired) or null. Never fetches, never schedules a
 *   refresh. For callers that must not do network I/O at all.
 *
 * - `getSnapshot(task, forgejo)` — single-task lookup. Stale-while-revalidate:
 *   if a cached entry exists (even expired), return it immediately and kick
 *   off a background refresh. Only the very first lookup with no cache at all
 *   blocks on Forgejo. In-flight refreshes for the same task are deduplicated.
 *
 * - `warmRepoSnapshots(repo, tasks, forgejo)` — batched warm. Issues two
 *   list calls per repo (issues + pulls, paginated) and populates the cache
 *   for every task in `tasks` whose issue/PR is found. Used by `/api/tasks`
 *   to avoid the per-task fan-out that previously turned a dashboard refresh
 *   into N+M Forgejo round-trips.
 *
 * The cache is best-effort: failures are swallowed and `getSnapshot`
 * returns `null`. Callers that need a fresh read on a stale cache should
 * treat `null` as "no reliable Forgejo view" and fall back to the stored
 * `task.status`.
 */

import type { Task, Repo } from '@orchestrator/shared';
import type {
  ForgejoClient,
  ForgejoIssue,
  ForgejoPullRequest,
} from './forgejo.js';
import { getRepo } from './db.js';
import type { FastifyBaseLogger } from 'fastify';

export interface SnapshotPr {
  number: number;
  state: string;          // 'open' | 'closed'
  merged: boolean;
  /** Forgejo's computed mergeability. `null` = not yet determined (Forgejo
   *  recomputes asynchronously after a push, so a fresh PR reports null/false
   *  before the check settles). Mirrors the tri-state in conflict-detector.ts.
   *  Carried for diagnostics; `deriveStatus` intentionally does not act on it
   *  (conflicts are the orchestrator's concern, not a display concern). */
  mergeable: boolean | null;
  draft: boolean;
}

export interface Snapshot {
  issue: {
    state: string;         // 'open' | 'closed'
    labels: string[];
  };
  pr: SnapshotPr | null;
  /** Epoch ms at which this snapshot was taken. */
  fetched_at: number;
}

interface CachedEntry {
  value: Snapshot;
  expires_at: number;
}

const DEFAULT_TTL_MS = 30_000;

// Page through up to 500 (= 10 × 50) issues / PRs per warm call. Most repos
// fit comfortably in one page; the cap stops a runaway loop on installs with
// thousands of historical items. Anything not found in the capped pages
// falls through to the per-task `getSnapshot` fetch.
const PAGE_LIMIT = 50;
const MAX_PAGES = 10;

const cache = new Map<number, CachedEntry>();
// Dedupe in-flight per-task refreshes: a stale-while-revalidate read that
// fires while a previous refresh is still pending must reuse that promise
// rather than spawning a parallel duplicate fetch.
const inFlight = new Map<number, Promise<Snapshot | null>>();

/** Exposed for tests. */
export function _clearSnapshotCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Remove any cached snapshot for this task. Call on every webhook event
 * that could change the issue or PR state (closed/reopened/labeled/merged).
 */
export function invalidateSnapshot(taskId: number): void {
  cache.delete(taskId);
}

/**
 * Cache-only read. Returns whatever entry is cached for this task — even an
 * expired one — and `null` when nothing is cached. NEVER issues a Forgejo
 * call and never schedules a background refresh, unlike `getSnapshot`.
 *
 * For the synchronous WebSocket broadcast path, which runs on hot paths
 * (including the scheduler tick) and cannot await network I/O. A `null`
 * result means the payload carries the stored `task.status` instead of a
 * derived one — the documented degradation in `status-derivation.ts`.
 * Serving an expired entry is deliberate: it is strictly better evidence
 * than none, and any REST read or webhook will refresh/invalidate it.
 */
export function peekSnapshot(taskId: number): Snapshot | null {
  return cache.get(taskId)?.value ?? null;
}

/**
 * Return a snapshot for this task. Stale-while-revalidate semantics:
 *
 * - Fresh cached entry → returned immediately, no Forgejo call.
 * - Stale cached entry → returned immediately, background refresh kicked off.
 * - No cached entry    → blocks on a single fetch.
 * - `force: true`      → always blocks on a fresh fetch.
 *
 * Returns `null` only when there's no cached entry AND the fetch fails (or
 * the task's repo can't be found). Callers should treat `null` as "no
 * reliable Forgejo view" and fall back to `task.status`.
 */
export async function getSnapshot(
  task: Task,
  forgejo: ForgejoClient,
  opts: { ttlMs?: number; force?: boolean } = {}
): Promise<Snapshot | null> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const entry = cache.get(task.id);

  if (entry && !opts.force) {
    if (entry.expires_at > now) {
      return entry.value;
    }
    // Stale: serve cached value, refresh in the background. Discard the
    // promise — any caller that wants to await the new value passes
    // `force: true` instead.
    void getOrStartFetch(task, forgejo, ttl);
    return entry.value;
  }

  return getOrStartFetch(task, forgejo, ttl);
}

/**
 * Batch-warm the snapshot cache for every task in `tasks` belonging to
 * `repo`. Issues two paginated list calls (issues + pulls) and populates
 * cache entries for matches. Tasks whose issue/PR isn't found in the capped
 * pages are left untouched — `getSnapshot` will fall back to a per-task
 * fetch for those.
 *
 * Skips repos for which every relevant task already has a fresh cache entry.
 * Failures during the list fetch leave the cache untouched (per-task
 * fallback path then handles individual lookups).
 */
export async function warmRepoSnapshots(
  repo: Repo,
  tasks: Task[],
  forgejo: ForgejoClient,
  log: FastifyBaseLogger,
  opts: { ttlMs?: number } = {}
): Promise<void> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  // Skip tasks that are already fresh — the warm call is purely an
  // optimisation, no point hitting Forgejo if the cache already has them.
  const stale = tasks.filter((t) => {
    const entry = cache.get(t.id);
    return !entry || entry.expires_at <= now;
  });
  if (stale.length === 0) return;

  const wantIssues = new Set(stale.map((t) => t.issue_id));
  const wantPrs = new Set<number>();
  for (const t of stale) {
    if (t.pr_number !== null && t.pr_number !== undefined) {
      wantPrs.add(t.pr_number);
    }
  }

  const issuesByNumber = new Map<number, ForgejoIssue>();
  const prsByNumber = new Map<number, ForgejoPullRequest>();

  // Issues + PRs in parallel — they don't depend on each other.
  await Promise.all([
    walkPages(
      (page) =>
        forgejo.listIssues(repo, { state: 'all', page, limit: PAGE_LIMIT }),
      (issue) => {
        if (wantIssues.has(issue.number)) {
          issuesByNumber.set(issue.number, issue);
        }
      },
      () => issuesByNumber.size === wantIssues.size,
      log,
      { repo: `${repo.owner}/${repo.name}`, kind: 'issues' }
    ),
    wantPrs.size === 0
      ? Promise.resolve()
      : walkPages(
          (page) =>
            forgejo.listPullRequests(repo, {
              state: 'all',
              page,
              limit: PAGE_LIMIT,
            }),
          (pr) => {
            if (wantPrs.has(pr.number)) {
              prsByNumber.set(pr.number, pr);
            }
          },
          () => prsByNumber.size === wantPrs.size,
          log,
          { repo: `${repo.owner}/${repo.name}`, kind: 'pulls' }
        ),
  ]);

  const expiresAt = now + ttl;
  for (const task of stale) {
    const issue = issuesByNumber.get(task.issue_id);
    if (!issue) continue; // not in the batch — leave cache untouched

    let pr: SnapshotPr | null = null;
    if (task.pr_number !== null && task.pr_number !== undefined) {
      const prData = prsByNumber.get(task.pr_number);
      if (prData) {
        pr = {
          number: prData.number,
          state: prData.state,
          merged: Boolean(prData.merged),
          // Preserve "not yet determined" as null rather than collapsing it
          // to a boolean. Forgejo's list endpoint can omit `mergeable` for
          // very fresh PRs; the per-task fetch path treats it identically.
          mergeable: prData.mergeable ?? null,
          draft: Boolean((prData as { draft?: boolean }).draft),
        };
      }
    }

    cache.set(task.id, {
      value: {
        issue: { state: issue.state, labels: issue.labels.map((l) => l.name) },
        pr,
        fetched_at: now,
      },
      expires_at: expiresAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function getOrStartFetch(
  task: Task,
  forgejo: ForgejoClient,
  ttl: number
): Promise<Snapshot | null> {
  const existing = inFlight.get(task.id);
  if (existing) return existing;

  const promise = (async () => {
    const repo = getRepo(task.repo_id);
    if (!repo) return null;
    const snapshot = await fetchSnapshot(task, repo, forgejo);
    if (snapshot) {
      cache.set(task.id, {
        value: snapshot,
        expires_at: Date.now() + ttl,
      });
    }
    return snapshot;
  })().finally(() => {
    inFlight.delete(task.id);
  });

  inFlight.set(task.id, promise);
  return promise;
}

async function fetchSnapshot(
  task: Task,
  repo: Repo,
  forgejo: ForgejoClient
): Promise<Snapshot | null> {
  let issueState: string;
  let issueLabels: string[];
  try {
    const issue = await forgejo.getIssue(repo, task.issue_id);
    issueState = issue.state;
    issueLabels = issue.labels.map((l) => l.name);
  } catch {
    return null;
  }

  let pr: SnapshotPr | null = null;
  if (task.pr_number !== null && task.pr_number !== undefined) {
    try {
      const prData = await forgejo.getPullRequest(repo, task.pr_number);
      pr = {
        number: prData.number,
        state: prData.state,
        merged: Boolean(prData.merged),
        // null = Forgejo hasn't computed mergeability yet (see SnapshotPr).
        mergeable: prData.mergeable ?? null,
        draft: Boolean((prData as { draft?: boolean }).draft),
      };
    } catch {
      pr = null;
    }
  }

  return {
    issue: { state: issueState, labels: issueLabels },
    pr,
    fetched_at: Date.now(),
  };
}

/**
 * Walk paginated Forgejo list endpoint pages until either:
 *   - `done()` returns true (we have everything we wanted)
 *   - the endpoint returns an empty page (no more results)
 *   - we hit MAX_PAGES (safety cap)
 *   - a fetch throws (best-effort: stop, leave the partial result in place)
 */
async function walkPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  ingest: (item: T) => void,
  done: () => boolean,
  log: FastifyBaseLogger,
  ctx: { repo: string; kind: 'issues' | 'pulls' }
): Promise<void> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    let pageItems: T[];
    try {
      pageItems = await fetchPage(page);
    } catch (err) {
      log.warn(
        { event: 'snapshot_warm_page_failed', ...ctx, page, err },
        'Snapshot warm fetch failed; per-task fallback will fill gaps'
      );
      return;
    }
    if (pageItems.length === 0) return;
    for (const item of pageItems) ingest(item);
    if (done()) return;
  }
  log.debug(
    { event: 'snapshot_warm_page_cap_reached', ...ctx, max_pages: MAX_PAGES },
    'Snapshot warm hit page cap; remaining tasks fall back to per-task fetch'
  );
}
