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
 * The cache is best-effort: failures are swallowed and `getSnapshot`
 * returns `null`. Callers that need a fresh read on a stale cache should
 * treat `null` as "no reliable Forgejo view" and fall back to the stored
 * `task.status`.
 */

import type { Task, Repo } from '@orchestrator/shared';
import type { ForgejoClient } from './forgejo.js';
import { getRepo } from './db.js';

export interface SnapshotPr {
  number: number;
  state: string;          // 'open' | 'closed'
  merged: boolean;
  mergeable: boolean;
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
const cache = new Map<number, CachedEntry>();

/** Exposed for tests. */
export function _clearSnapshotCache(): void {
  cache.clear();
}

/**
 * Remove any cached snapshot for this task. Call on every webhook event
 * that could change the issue or PR state (closed/reopened/labeled/merged).
 */
export function invalidateSnapshot(taskId: number): void {
  cache.delete(taskId);
}

/**
 * Return the cached snapshot if fresh, otherwise fetch a new one from
 * Forgejo. Returns `null` if the task's repo can't be found or Forgejo is
 * unreachable — callers must handle this and fall back to stored state.
 */
export async function getSnapshot(
  task: Task,
  forgejo: ForgejoClient,
  opts: { ttlMs?: number; force?: boolean } = {}
): Promise<Snapshot | null> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  if (!opts.force) {
    const entry = cache.get(task.id);
    if (entry && entry.expires_at > now) return entry.value;
  }

  const repo = getRepo(task.repo_id);
  if (!repo) return null;

  const snapshot = await fetchSnapshot(task, repo, forgejo);
  if (!snapshot) return null;

  cache.set(task.id, {
    value: snapshot,
    expires_at: now + ttl,
  });
  return snapshot;
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
        mergeable: Boolean(prData.mergeable),
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
