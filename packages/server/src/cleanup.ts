import fsp from 'node:fs/promises';
import path from 'node:path';
import { getTasks } from './db.js';
import { getWorkdir } from './workspace.js';
import { archiveTaskArtifacts } from './archive.js';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import { WORKSPACE_RETENTION_DAYS, WORKSPACES_ROOT } from './constants.js';
import type { FastifyBaseLogger } from 'fastify';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Two-pass workspace cleanup, run on every poll cycle:
 *
 *   1. Task-driven sweep — for each task in a terminal state whose
 *      `completed_at` is older than WORKSPACE_RETENTION_DAYS, delete the
 *      corresponding /workspaces/issue-N/ directory. Applies uniformly to
 *      `merged`, `failed`, `cancelled`, `reset`, `awaiting-human-*`, and
 *      `needs-human-review`. The task's run artifacts are archived to
 *      ARCHIVE_ROOT first (see archive.ts); if that fails the workspace is
 *      left in place and retried on the next cycle.
 *
 *   2. Orphan sweep — list /workspaces/ for issue-N directories whose N has
 *      no matching task row. If the directory's mtime is older than the same
 *      retention, delete it. Catches stranded workspaces from manual DB
 *      intervention, restored backups, or test runs. The mtime + retention
 *      buffer guarantees a freshly-launched workspace can't be swept. No
 *      archiving here — there is no task row to attribute the artifacts to.
 *
 * Async fs operations throughout so the recursive delete doesn't block the
 * event loop. Per-repo dependency caches under /caches/ are NOT touched —
 * they're shared across tasks and persist.
 */
export async function cleanupOldWorkspaces(log: FastifyBaseLogger): Promise<void> {
  const cutoffMs = WORKSPACE_RETENTION_DAYS * MS_PER_DAY;
  const now = Date.now();

  const tasks = getTasks();

  // ---- Pass 1: task-driven cleanup ----
  for (const task of tasks) {
    if (!TERMINAL_STATUSES.has(task.status)) continue;
    if (!task.completed_at) continue;

    const completedAt = new Date(task.completed_at).getTime();
    if (now - completedAt < cutoffMs) continue;

    const workdir = getWorkdir(task);

    // Skip if already gone — avoids logging a spurious "cleaned" message on
    // every poll cycle for tasks whose workspace was deleted long ago.
    try {
      await fsp.access(workdir);
    } catch {
      continue;
    }

    // Copy the small run artifacts onto the persistent volume BEFORE the
    // workspace goes. A failure here skips the delete for this cycle (the
    // next poll retries) — an undeleted workspace costs disk, a lost log is
    // gone for good.
    try {
      await archiveTaskArtifacts(task, log);
    } catch (err) {
      log.warn(
        {
          event: 'artifacts_archive_failed',
          task_id: task.id,
          issue_id: task.issue_id,
          err,
        },
        'Failed to archive run artifacts — keeping workspace for retry on the next cycle'
      );
      continue;
    }

    try {
      await fsp.rm(workdir, { recursive: true, force: true });
      log.info(
        {
          event: 'workspace_cleaned',
          task_id: task.id,
          issue_id: task.issue_id,
          status: task.status,
          age_days: Math.floor((now - completedAt) / MS_PER_DAY),
        },
        `Deleted workspace for issue #${task.issue_id} (${task.status}, ${WORKSPACE_RETENTION_DAYS}d retention)`
      );
    } catch (err) {
      log.warn(
        { event: 'workspace_cleanup_failed', task_id: task.id, err },
        'Failed to delete old workspace'
      );
    }
  }

  // ---- Pass 2: orphan sweep ----
  // Defence in depth — catches workspaces that no task row points at. Strict
  // regex on the directory name; anything else (stray files, oddly-named
  // subdirs) is ignored. mtime + retention buffer prevents racing fresh
  // workspaces during launch. Recognises both the current repo-scoped name
  // (`<repo_id>-issue-<n>`) and the legacy pre-v27 name (`issue-<n>`); a dir
  // is orphaned when no live task maps to it.
  const liveScoped = new Set(
    tasks.map((t) => `${t.repo_id}-issue-${t.issue_id}`)
  );
  const liveIssueIds = new Set(tasks.map((t) => t.issue_id));
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fsp.readdir(WORKSPACES_ROOT, { withFileTypes: true });
  } catch {
    return; // WORKSPACES_ROOT not present yet — nothing to sweep
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const scoped = entry.name.match(/^(\d+)-issue-(\d+)$/);
    const legacy = entry.name.match(/^issue-(\d+)$/);
    if (!scoped && !legacy) continue;
    // Repo-scoped dir: orphaned unless an exact (repo, issue) task exists.
    if (scoped && liveScoped.has(entry.name)) continue;
    // Legacy dir: at most one existed per issue number (the old global
    // UNIQUE(issue_id)), so an issue_id match across any repo keeps it.
    if (legacy && liveIssueIds.has(parseInt(legacy[1], 10))) continue;
    const issueId = scoped ? parseInt(scoped[2], 10) : parseInt(legacy![1], 10);

    const fullPath = path.join(WORKSPACES_ROOT, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = (await fsp.stat(fullPath)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < cutoffMs) continue; // too fresh to be considered orphaned

    try {
      await fsp.rm(fullPath, { recursive: true, force: true });
      log.info(
        {
          event: 'workspace_orphan_cleaned',
          issue_id: issueId,
          dir: entry.name,
          age_days: Math.floor((now - mtimeMs) / MS_PER_DAY),
        },
        `Deleted orphaned workspace ${entry.name} (no task row, ${WORKSPACE_RETENTION_DAYS}d retention)`
      );
    } catch (err) {
      log.warn(
        {
          event: 'workspace_orphan_cleanup_failed',
          dir: entry.name,
          err,
        },
        'Failed to delete orphaned workspace'
      );
    }
  }
}
