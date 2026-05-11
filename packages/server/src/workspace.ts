import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '@orchestrator/shared';
import type { HarnessConfigFile } from './harnesses/types.js';
import { getRepo } from './db.js';
import type { ForgejoClient } from './forgejo.js';
import type { FastifyBaseLogger } from 'fastify';
import { insertTaskEvent } from './db.js';
import { WORKSPACES_ROOT, CACHES_ROOT } from './constants.js';

const execFileP = promisify(execFile);

const FORGEJO_URL = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
const AGENT_TOKEN = process.env.FORGEJO_AGENT_TOKEN ?? '';

// Agent containers run as UID/GID 1000 (the `agent` user in the base image).
// The orchestrator runs as root, so any file/dir it creates inside the shared
// /workspaces, /caches volumes is root-owned and unwritable by the agent.
// Chown everything we create to 1000:1000 so the agent can read/write.
const AGENT_UID = 1000;
const AGENT_GID = 1000;

/** chown a directory tree to the agent user. No-op on non-Linux platforms —
 *  fs.chown is a no-op on Windows and the agent user mapping doesn't apply
 *  there either. Async + parallel so a deep tree doesn't block the event loop.
 *  Safe to call on every prepare since chown is idempotent and cheap. */
async function chownRecursive(dir: string): Promise<void> {
  if (process.platform !== 'linux') return;
  let entries: fs.Dirent[];
  try {
    await fsp.chown(dir, AGENT_UID, AGENT_GID);
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; /* best effort — dir may not exist */
  }
  await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await chownRecursive(child);
      } else {
        try {
          await fsp.chown(child, AGENT_UID, AGENT_GID);
        } catch {
          /* best effort — file may have vanished */
        }
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getWorkdir(task: Task): string {
  return path.join(WORKSPACES_ROOT, `issue-${task.issue_id}`);
}

export function getTaskDir(task: Task): string {
  return path.join(getWorkdir(task), '.task');
}

export function getOutputDir(task: Task): string {
  return path.join(getWorkdir(task), '.output');
}

export function getCacheDir(repoOwner: string, repoName: string): string {
  return path.join(CACHES_ROOT, `${repoOwner}-${repoName}`);
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic branch name for a task.
 * Format: agent/issue-{id}-{sanitized_title}
 *
 * sanitized_title: lowercase, spaces to hyphens, strip non-alphanumeric (except hyphens),
 * truncate to 50 chars, no trailing hyphens.
 */
export function generateBranchName(issueId: number, title: string): string {
  let sanitized = title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');

  if (!sanitized) {
    sanitized = 'task';
  }

  return `agent/issue-${issueId}-${sanitized}`;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  cwd: string,
  log: FastifyBaseLogger
): Promise<string> {
  log.debug({ event: 'git_exec', args, cwd }, `git ${args[0]}`);
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000, // 2 minute timeout for git operations
    });
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    const stderr = error.stderr ?? error.message ?? String(err);
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
}

function getAgentAuthUrl(repoOwner: string, repoName: string): string {
  const url = new URL(FORGEJO_URL);
  return `${url.protocol}//agent:${AGENT_TOKEN}@${url.host}/${repoOwner}/${repoName}.git`;
}

// ---------------------------------------------------------------------------
// Workspace state verification
// ---------------------------------------------------------------------------

/**
 * Verify and restore the workspace to a known-good git state.
 * Aborts stale rebase/merge, restores expected branch.
 */
export async function verifyWorkspaceState(
  task: Task,
  log: FastifyBaseLogger
): Promise<void> {
  const workdir = getWorkdir(task);
  if (!fs.existsSync(workdir)) return;

  const gitDir = path.join(workdir, '.git');
  if (!fs.existsSync(gitDir)) return;

  // Abort any in-progress rebase
  if (
    fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
    fs.existsSync(path.join(gitDir, 'rebase-apply'))
  ) {
    try {
      await git(['rebase', '--abort'], workdir, log);
      log.warn(
        { event: 'rebase_aborted', task_id: task.id },
        'Aborted stale rebase left by agent'
      );
    } catch {
      // Best effort
    }
  }

  // Abort any in-progress merge conflict
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    try {
      await git(['merge', '--abort'], workdir, log);
      log.warn(
        { event: 'merge_aborted', task_id: task.id },
        'Aborted stale merge left by agent'
      );
    } catch {
      // Best effort
    }
  }

  // Ensure we're on the expected branch
  if (task.branch_name) {
    try {
      const currentBranch = await git(
        ['branch', '--show-current'],
        workdir,
        log
      );
      if (currentBranch !== task.branch_name) {
        try {
          await git(['checkout', task.branch_name], workdir, log);
        } catch {
          // Branch doesn't exist locally — recreate from remote
          await git(
            ['fetch', 'origin', task.branch_name],
            workdir,
            log
          );
          await git(
            ['checkout', '-B', task.branch_name, `origin/${task.branch_name}`],
            workdir,
            log
          );
        }
        log.warn(
          {
            event: 'branch_restored',
            task_id: task.id,
            expected: task.branch_name,
            found: currentBranch,
          },
          'Restored expected branch'
        );
      }
    } catch {
      // Non-fatal — workspace may be newly cloned
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace preparation
// ---------------------------------------------------------------------------

/**
 * Prepare the workspace for an agent container.
 * Clones if new, sets URL if existing, checks out branch.
 */
export async function prepareWorkspace(
  task: Task,
  log: FastifyBaseLogger
): Promise<void> {
  const repo = getRepo(task.repo_id);
  if (!repo) {
    throw new Error(`Repo not found for task ${task.id}`);
  }

  const workdir = getWorkdir(task);
  const authUrl = getAgentAuthUrl(repo.owner, repo.name);

  if (!fs.existsSync(path.join(workdir, '.git'))) {
    // Clone workspace
    log.info(
      { event: 'workspace_clone', task_id: task.id },
      'Cloning workspace'
    );
    await fsp.mkdir(workdir, { recursive: true });
    await execFileP('git', ['clone', authUrl, workdir], {
      encoding: 'utf-8',
      timeout: 300_000, // 5 minute timeout for clone
    });
    insertTaskEvent(task.id, 'workspace_cloned', `Workspace cloned for ${repo.owner}/${repo.name}`);
  } else {
    // Workspace exists — update remote URL (token rotation)
    await git(['remote', 'set-url', 'origin', authUrl], workdir, log);
  }

  if (task.attempt === 1) {
    // New task: create branch from latest base
    await git(['fetch', 'origin', repo.base_branch], workdir, log);
    await git(
      ['checkout', '-B', task.branch_name!, `origin/${repo.base_branch}`],
      workdir,
      log
    );
    insertTaskEvent(task.id, 'branch_created', `Branch ${task.branch_name} created from ${repo.base_branch}`);
  } else {
    // Rework: checkout the existing branch as-is
    await verifyWorkspaceState(task, log);
    try {
      await git(['checkout', task.branch_name!], workdir, log);
    } catch {
      // Local branch missing — try to recreate from remote
      try {
        await git(['fetch', 'origin', task.branch_name!], workdir, log);
        await git(
          [
            'checkout',
            '-B',
            task.branch_name!,
            `origin/${task.branch_name}`,
          ],
          workdir,
          log
        );
        log.warn(
          { event: 'rework_branch_restored', task_id: task.id },
          'Local branch missing, restored from remote'
        );
      } catch {
        // Remote branch also gone — unrecoverable
        log.error(
          { event: 'rework_branch_lost', task_id: task.id },
          'Branch not found on local or remote'
        );
        throw new Error(
          `Branch ${task.branch_name} not found on local or remote`
        );
      }
    }
  }

  // Ensure output and task dirs exist
  const taskDir = getTaskDir(task);
  const outputDir = getOutputDir(task);
  await fsp.mkdir(taskDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });

  // Ensure cache directory exists
  const cacheDir = getCacheDir(repo.owner, repo.name);
  await fsp.mkdir(cacheDir, { recursive: true });

  // Add orchestrator/agent metadata paths to the per-clone exclude list. These
  // are NOT in the upstream .gitignore (and shouldn't be — they're orchestrator
  // implementation details). Without this, the salvage logic's `git add -A`
  // sweeps them into a commit and the resulting PR contains only orchestrator
  // metadata instead of real source changes. .git/info/exclude is local-only
  // (never committed, never pushed), so this is the right place.
  await writeLocalGitExclude(workdir, [
    '.task/',
    '.output/',
    'opencode.json',
    '.opencode/',
  ]);

  // Chown everything to the agent user. The orchestrator runs as root and the
  // git clone / mkdir above creates root-owned files; without this the agent
  // (UID 1000) can't write to /output/progress.log and the harness exits 2.
  // Idempotent — safe to run on every prepare (including reworks).
  await chownRecursive(workdir);
  await chownRecursive(cacheDir);

  log.info(
    { event: 'workspace_ready', task_id: task.id, workdir },
    'Workspace prepared'
  );
}

async function writeLocalGitExclude(
  workdir: string,
  patterns: string[]
): Promise<void> {
  const excludePath = path.join(workdir, '.git', 'info', 'exclude');
  try {
    await fsp.mkdir(path.dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await fsp.readFile(excludePath, 'utf-8');
    } catch {
      /* file doesn't exist yet */
    }
    const lines = new Set(existing.split('\n').map((l) => l.trim()));
    let changed = false;
    for (const p of patterns) {
      if (!lines.has(p)) {
        lines.add(p);
        changed = true;
      }
    }
    if (changed) {
      await fsp.writeFile(
        excludePath,
        Array.from(lines).filter(Boolean).join('\n') + '\n'
      );
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Harness config-file injection
// ---------------------------------------------------------------------------
//
// Some harnesses (OpenCode) need a config file (`opencode.json`) dropped
// into the workspace before the agent starts. The harness module computes
// the file's path and content as part of its `buildInvocation` output;
// the scheduler hands the resulting list to this writer.
//
// Paths must be absolute under `/repo/`. Files at other locations (e.g.
// pi's `~/.pi/agent/models.json`) are not expressible here — the orchestrator
// has no path into the agent container's home — and those harnesses bake
// the file creation into their `agent_command` instead. See harnesses/pi.ts.

const REPO_ROOT_PREFIX = '/repo/';

/** Validate a harness-supplied target path. Returns the workdir-relative
 *  path on success, or an Error with a human-readable reason on failure.
 *
 *  Defence layers:
 *    1. Path must start with `/repo/` (per the documented contract).
 *    2. After stripping the prefix, normalize and reject any path that
 *       escapes the workdir (`..` segments, absolute paths via `//`).
 *    3. Verified after `mkdir` (just before writeFile) by lstat'ing the
 *       target's parent chain and refusing if any component is a symlink
 *       pointing outside the workdir. A repo-tree-planted symlink at
 *       `/repo/opencode.json` -> `/etc/passwd` would otherwise be
 *       followed by `fsp.writeFile`. */
function validateHarnessConfigPath(
  fullPath: string,
  workdir: string
): { rel: string; target: string } | { error: string } {
  if (!fullPath.startsWith(REPO_ROOT_PREFIX)) {
    return { error: 'path must be absolute under /repo/' };
  }
  const rel = fullPath.slice(REPO_ROOT_PREFIX.length);
  // posix.normalize collapses `.`/`..` and `//`. If the result still
  // contains `..` segments (escapes the root) or is absolute, reject.
  const normalized = path.posix.normalize(rel);
  if (
    normalized.startsWith('..') ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    return { error: 'path must not escape /repo/' };
  }
  if (normalized === '' || normalized === '.') {
    return { error: 'path must not be empty' };
  }
  const target = path.join(workdir, normalized);
  // Final guard: after path.join, the resolved target must still live
  // strictly under workdir. (path.posix.normalize above already covers
  // the simple cases; this is the belt-and-braces check that handles
  // platform-specific quirks like Windows backslashes.)
  const workdirReal = path.resolve(workdir) + path.sep;
  if (!(path.resolve(target) + path.sep).startsWith(workdirReal)) {
    return { error: 'path resolves outside the task workspace' };
  }
  return { rel: normalized, target };
}

/** Walk from the workdir down to (but excluding) `target` and refuse if
 *  any intermediate component is a symlink. Symlinks pointing inside the
 *  workdir would be fine if we resolved them, but a symlink at e.g.
 *  `/repo/opencode.json` pointing at `/etc/passwd` would let
 *  `fsp.writeFile(target)` overwrite an arbitrary file. Easier to refuse
 *  symlinks in the harness-config path entirely than to canonicalize. */
async function assertNoSymlinkOnPath(target: string, workdir: string): Promise<void> {
  const rel = path.relative(workdir, target);
  const parts = rel.split(path.sep);
  // Walk components: workdir/parts[0], workdir/parts[0]/parts[1], ...
  let current = workdir;
  for (const part of parts) {
    if (!part) continue;
    current = path.join(current, part);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(current);
    } catch {
      // Doesn't exist yet — fine, writeFile / mkdir will create it.
      return;
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to follow symlink at ${current} while writing harness config`
      );
    }
  }
}

export async function writeHarnessConfigFiles(
  task: Task,
  files: HarnessConfigFile[],
  harnessId: string,
  log: FastifyBaseLogger
): Promise<void> {
  if (files.length === 0) return;

  const workdir = getWorkdir(task);
  const repoExcludeEntries: string[] = [];
  for (const file of files) {
    const v = validateHarnessConfigPath(file.path, workdir);
    if ('error' in v) {
      // Refuse to launch rather than silently continue with no config —
      // a missing opencode.json would mean OpenCode uses default
      // provider settings, silently routing the run to the wrong place.
      throw new Error(
        `Harness '${harnessId}' supplied invalid config path '${file.path}': ${v.error}`
      );
    }
    try {
      await fsp.mkdir(path.dirname(v.target), { recursive: true });
      await assertNoSymlinkOnPath(v.target, workdir);
      await fsp.writeFile(v.target, file.content);
      if (process.platform === 'linux') {
        try {
          await fsp.chown(v.target, AGENT_UID, AGENT_GID);
        } catch {
          /* best effort */
        }
      }
      repoExcludeEntries.push(v.rel);
      log.info(
        {
          event: 'harness_config_written',
          task_id: task.id,
          harness_id: harnessId,
          path: v.target,
        },
        'Wrote harness config file'
      );
    } catch (err) {
      log.error(
        { event: 'harness_config_write_failed', task_id: task.id, err },
        'Failed to write harness config file'
      );
      // Hard failure: aborting the launch is better than running the
      // agent against the wrong provider config (or no config at all).
      throw err instanceof Error
        ? err
        : new Error(String(err));
    }
  }

  // Append all written paths to .git/info/exclude in a single pass so a
  // salvage `git add -A` doesn't sweep them into a commit. Local-only
  // file; never lands in upstream config.
  if (repoExcludeEntries.length > 0) {
    await writeLocalGitExclude(workdir, repoExcludeEntries);
  }
}

// ---------------------------------------------------------------------------
// Change detection (for salvage / recovery)
// ---------------------------------------------------------------------------

export interface ChangeDetection {
  hasUncommitted: boolean;
  hasUntracked: boolean;
  hasLocalCommits: boolean;
}

export async function detectChanges(
  task: Task,
  baseBranch: string,
  log: FastifyBaseLogger
): Promise<ChangeDetection> {
  const workdir = getWorkdir(task);

  let hasUncommitted = false;
  try {
    await git(['diff', '--quiet'], workdir, log);
    await git(['diff', '--cached', '--quiet'], workdir, log);
  } catch {
    hasUncommitted = true;
  }

  let hasUntracked = false;
  try {
    const untracked = await git(
      ['ls-files', '--others', '--exclude-standard'],
      workdir,
      log
    );
    hasUntracked = untracked.length > 0;
  } catch {
    // Best effort
  }

  let hasLocalCommits = false;
  try {
    const commits = await git(
      ['log', `origin/${baseBranch}..HEAD`, '--oneline'],
      workdir,
      log
    );
    hasLocalCommits = commits.length > 0;
  } catch {
    // Best effort
  }

  return { hasUncommitted, hasUntracked, hasLocalCommits };
}
