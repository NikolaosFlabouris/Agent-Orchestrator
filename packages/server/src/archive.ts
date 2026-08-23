/**
 * Persistent archive of per-task agent run artifacts.
 *
 * Attempt rows live in the database forever, but the files the agent
 * produced — `progress.log`, `result.json`, `review.json`, `meta.json` —
 * live inside the task workspace and are deleted by `cleanupOldWorkspaces`
 * once WORKSPACE_RETENTION_DAYS have passed. After that `attempts.log_path`
 * dangles and any log-based post-mortem ("why did model X fail on task Y
 * three weeks ago?") is impossible.
 *
 * So the handful of small text artifacts are copied onto the persistent
 * /data volume before the workspace goes, and again eagerly the moment a
 * task reaches a terminal state (a crash between completion and the sweep
 * would otherwise lose them). Everything else in the workspace — the
 * checkout, node_modules, build output — is deliberately NOT archived:
 * workspaces are large and re-creatable, these four files are neither.
 *
 * Layout: ARCHIVE_ROOT/<repo_id>/issue-<issue_id>/. Repo-scoped for the same
 * reason workspaces are (`<repo_id>-issue-<n>`): Forgejo issue numbers are
 * per-repo, so the issue number alone collides across repos.
 *
 * The archive has no retention sweep — it is retained indefinitely. Total
 * size is bounded by (tasks × gzipped log), which is orders of magnitude
 * below the workspaces it replaces.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import type { Task } from '@orchestrator/shared';
import { ARCHIVE_ROOT } from './constants.js';
import { getOutputDir, getTaskDir } from './workspace.js';
import { updateAttemptsLogPath } from './db.js';
import type { FastifyBaseLogger } from 'fastify';

/** Name of the live progress log inside the workspace output dir. */
export const LOG_FILENAME = 'progress.log';
/** Name of the same log inside the archive (gzipped). */
export const ARCHIVED_LOG_FILENAME = 'progress.log.gz';

/**
 * The complete set of files copied out of a workspace. Only `progress.log`
 * is gzipped — it's the only one that can reach megabytes; the JSON files
 * are a few KB each and stay readable with `cat`.
 */
const ARCHIVED_FILES: ReadonlyArray<{ name: string; gzip: boolean }> = [
  { name: LOG_FILENAME, gzip: true },
  { name: 'result.json', gzip: false },
  { name: 'review.json', gzip: false },
  { name: 'meta.json', gzip: false },
];

/**
 * Where a given file is looked for, in order. `progress.log`, `result.json`
 * and `review.json` are written by the harness into `.output/`; `meta.json`
 * is written by the orchestrator into `.task/` (see `writeTaskFiles`). Both
 * directories are probed for every file so a harness that puts one somewhere
 * else still gets archived rather than silently skipped.
 */
function sourceCandidates(task: Task, name: string): string[] {
  return [path.join(getOutputDir(task), name), path.join(getTaskDir(task), name)];
}

/** The single task → archive-directory mapping. Every other path in this
 *  module derives from it. */
export function getArchiveDir(task: Pick<Task, 'repo_id' | 'issue_id'>): string {
  return path.join(ARCHIVE_ROOT, String(task.repo_id), `issue-${task.issue_id}`);
}

/** Archived (gzipped) copy of a task's progress log. */
export function getArchivedLogPath(
  task: Pick<Task, 'repo_id' | 'issue_id'>
): string {
  return path.join(getArchiveDir(task), ARCHIVED_LOG_FILENAME);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** First existing source path for `name`, or null when the attempt never
 *  produced that file (common for `review.json`). */
async function findSource(task: Task, name: string): Promise<string | null> {
  for (const candidate of sourceCandidates(task, name)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Copy a task's run artifacts into the persistent archive.
 *
 * Idempotent: re-archiving overwrites each file with the current workspace
 * copy (via write-to-`.partial`-then-rename, so a crash mid-copy can never
 * leave a truncated file where a complete one used to be). Files the attempt
 * never produced are logged at debug and skipped — not every attempt writes a
 * `review.json`.
 *
 * THROWS on any real I/O failure. Callers that delete the workspace
 * afterwards (`cleanupOldWorkspaces`) must treat a throw as "do not delete";
 * callers archiving opportunistically catch and warn.
 *
 * Returns the archived destination paths (empty when the workspace held
 * nothing worth keeping).
 */
export async function archiveTaskArtifacts(
  task: Task,
  log: FastifyBaseLogger
): Promise<string[]> {
  // Resolve sources first so a task with nothing on disk (cancelled before
  // launch, workspace already swept) doesn't leave an empty archive dir
  // behind. This also makes the function safe to call on every terminal
  // transition regardless of how far the task got.
  const jobs: Array<{ src: string; dest: string; gzip: boolean }> = [];
  const archiveDir = getArchiveDir(task);
  for (const file of ARCHIVED_FILES) {
    const src = await findSource(task, file.name);
    if (!src) {
      log.debug(
        { event: 'archive_file_missing', task_id: task.id, file: file.name },
        `No ${file.name} to archive for task ${task.id}`
      );
      continue;
    }
    jobs.push({
      src,
      dest: path.join(archiveDir, file.gzip ? `${file.name}.gz` : file.name),
      gzip: file.gzip,
    });
  }

  const archived: string[] = [];
  if (jobs.length > 0) {
    await fsp.mkdir(archiveDir, { recursive: true });
    for (const job of jobs) {
      const partial = `${job.dest}.partial`;
      try {
        if (job.gzip) {
          await pipeline(
            fs.createReadStream(job.src),
            createGzip(),
            fs.createWriteStream(partial)
          );
        } else {
          await pipeline(
            fs.createReadStream(job.src),
            fs.createWriteStream(partial)
          );
        }
        await fsp.rename(partial, job.dest);
      } catch (err) {
        await fsp.rm(partial, { force: true }).catch(() => {});
        throw err;
      }
      archived.push(job.dest);
    }
    log.info(
      {
        event: 'artifacts_archived',
        task_id: task.id,
        issue_id: task.issue_id,
        dir: archiveDir,
        files: archived.length,
      },
      `Archived ${archived.length} run artifact(s) for issue #${task.issue_id}`
    );
  }

  // Re-point the attempt rows at the archived log whenever one exists —
  // including the re-archive case where this pass copied nothing new but a
  // previous pass already stored the log. Attempts share one log file per
  // task workspace, so they all get the same path (as they did before).
  const archivedLog = getArchivedLogPath(task);
  if (await exists(archivedLog)) {
    updateAttemptsLogPath(task.id, archivedLog);
  }

  return archived;
}

/**
 * Open a task's progress log wherever it currently lives: the live workspace
 * copy if the workspace is still around, the gzipped archive copy (unpacked
 * on the fly) once it has been swept, null when neither exists.
 *
 * Single code path so the HTTP route and any other consumer can't drift on
 * where a log is found. Streams throughout — logs can be large.
 */
export async function readTaskLog(task: Task): Promise<Readable | null> {
  const livePath = path.join(getOutputDir(task), LOG_FILENAME);
  if (await exists(livePath)) {
    return fs.createReadStream(livePath);
  }

  const archivedPath = getArchivedLogPath(task);
  if (await exists(archivedPath)) {
    const source = fs.createReadStream(archivedPath);
    const gunzip = createGunzip();
    // Forward read errors onto the stream the caller consumes; otherwise a
    // mid-stream failure surfaces as an unhandled 'error' on the source.
    source.on('error', (err) => gunzip.destroy(err));
    return source.pipe(gunzip);
  }

  return null;
}

/** Last-N-lines view of a task's progress log, as produced by
 *  {@link readTaskLogTail}. */
export interface TaskLogTail {
  /** The last `lines.length` lines of the log, oldest first, without their
   *  terminating newline. */
  lines: string[];
  /** How many lines the whole log has, however many were returned. */
  total_lines: number;
  /** True when earlier lines were dropped to honour `maxLines`. */
  truncated: boolean;
}

/**
 * Read the tail of a task's progress log, from wherever
 * {@link readTaskLog} finds it. Returns null when no log exists in either
 * the workspace or the archive.
 *
 * Streams and keeps only a `maxLines` ring buffer, so reading the tail of a
 * multi-hundred-megabyte log costs a constant amount of memory. That's the
 * whole point: bounded output for callers (the MCP `get_task_log` tool)
 * that must not pull an entire log into a model's context. Consumers
 * wanting the full text stream `GET /api/tasks/:id/log` instead.
 */
export async function readTaskLogTail(
  task: Task,
  maxLines: number
): Promise<TaskLogTail | null> {
  const stream = await readTaskLog(task);
  if (!stream) return null;

  const cap = Math.max(1, Math.trunc(maxLines));
  // Fixed-size circular buffer: `ring[total % cap]` is always the slot the
  // next line goes in, so no per-line shift() over a growing array.
  const ring: string[] = new Array<string>(cap);
  let total = 0;
  const push = (line: string): void => {
    ring[total % cap] = line;
    total += 1;
  };

  const decoder = new StringDecoder('utf8');
  // `pending` only ever holds the trailing partial line between chunks —
  // each chunk is scanned in place and sliced once, never per line.
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.write(chunk as Buffer);
    let start = 0;
    let nl = pending.indexOf('\n', start);
    while (nl !== -1) {
      push(pending.slice(start, nl));
      start = nl + 1;
      nl = pending.indexOf('\n', start);
    }
    if (start > 0) pending = pending.slice(start);
  }
  pending += decoder.end();
  // A log that doesn't end in a newline still has a final line; one that
  // does must not report a phantom empty one.
  if (pending !== '') push(pending);

  const lines =
    total <= cap
      ? ring.slice(0, total)
      : [...ring.slice(total % cap), ...ring.slice(0, total % cap)];

  return { lines, total_lines: total, truncated: total > lines.length };
}
