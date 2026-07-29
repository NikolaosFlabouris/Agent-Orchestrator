/**
 * Task dependencies — single owner of the `## Dependencies` issue-body
 * convention and the `task_dependencies` projection.
 *
 * The issue body is the source of truth: dependencies are checklist items
 * (`- [ ] #38`) under a `## Dependencies` heading, editable by humans
 * directly on Forgejo. This module is the only code that parses or writes
 * that section, and the only writer of `task_dependencies` rows (the
 * evaluator re-derives them from the body on every pass — "sync" is
 * re-derivation, not reconciliation).
 *
 * Completion rule: a dependency is satisfied when its issue is closed
 * (Forgejo's issues API returns PRs too, so a closed PR reference also
 * satisfies). A checked box (`- [x] #N`) is a manual override that
 * satisfies regardless of issue state. Everything else — open, missing,
 * fetch error, cycle — blocks, fail-closed.
 *
 * "Blocked" is never a TaskStatus: the scheduler gate and the UI compute
 * it from the rows via `isBlocked`.
 */

import type {
  Task,
  Repo,
  TaskDependency,
  DependencyState,
} from '@orchestrator/shared';
import { SATISFIED_DEP_STATES } from '@orchestrator/shared';
import {
  getRepo,
  getTask,
  getQueuedTasks,
  getDependentTasks,
  getTaskByRepoIssue,
  getTaskDependencies,
  upsertTaskDependency,
  deleteTaskDependenciesExcept,
} from './db.js';
import { isBlocked } from './dependency-state.js';
import { buildTaskView } from './task-view.js';
import { DEP_EVAL_MIN_INTERVAL_SECONDS } from './constants.js';
import { recordTaskEvent } from './state-sync.js';
import { broadcastDashboardEvent } from './ws/dashboard.js';
import { ForgejoApiError, type ForgejoClient } from './forgejo.js';
import type { FastifyBaseLogger } from 'fastify';

/** The one Forgejo capability this module needs — keeps tests to a stub. */
export type DependencyForgejo = Pick<ForgejoClient, 'getIssue'>;

export interface ParsedDependency {
  issue: number;
  checked: boolean;
}

export interface DepSummary {
  blocked: boolean;
  deps: TaskDependency[];
  /** True when any row was added, removed, or changed state this pass. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Parsing / formatting
// ---------------------------------------------------------------------------

/** `## Dependencies` / `### Dependencies` heading (case-insensitive). */
const SECTION_HEADING = /^(#{2,3})\s*dependencies\s*$/i;
/** Any markdown heading — terminates a section when its level is ≤ ours. */
const ANY_HEADING = /^(#{1,6})(?:\s|$)/;
/** Checklist item: `-`/`*`/`+` bullet (indentation tolerated), `[ ]` or
 *  `[x]`, then `#<digits>`. Same-repo references only — `owner/repo#N`
 *  and URLs deliberately don't match. */
const CHECKLIST_ITEM = /^\s*[-*+]\s*\[([ xX])\]\s*#(\d+)\b/;

interface SectionRange {
  /** Line index of the heading itself. */
  headingIdx: number;
  /** Exclusive end: index of the terminating heading, or lines.length. */
  endIdx: number;
}

function findDependencySections(lines: string[]): SectionRange[] {
  const sections: SectionRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = SECTION_HEADING.exec(lines[i]);
    if (!heading) continue;
    const level = heading[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const other = ANY_HEADING.exec(lines[j]);
      if (other && other[1].length <= level) {
        end = j;
        break;
      }
    }
    sections.push({ headingIdx: i, endIdx: end });
    i = end - 1;
  }
  return sections;
}

/**
 * Parse dependency checklist items from the `## Dependencies` section(s) of
 * an issue body. Items outside a Dependencies section are NOT dependencies
 * (acceptance-criteria checklists stay inert). When the same issue number
 * appears both checked and unchecked, unchecked wins (fail closed).
 */
export function parseDependencySection(body: string): ParsedDependency[] {
  const lines = body.split(/\r?\n/);
  const byIssue = new Map<number, boolean>();
  for (const { headingIdx, endIdx } of findDependencySections(lines)) {
    for (let i = headingIdx + 1; i < endIdx; i++) {
      const item = CHECKLIST_ITEM.exec(lines[i]);
      if (!item) continue;
      const issue = parseInt(item[2], 10);
      const checked = item[1] !== ' ';
      const existing = byIssue.get(issue);
      byIssue.set(issue, existing === undefined ? checked : existing && checked);
    }
  }
  return [...byIssue.entries()].map(([issue, checked]) => ({ issue, checked }));
}

/** Canonical section text. Used by every programmatic intake path so the
 *  format never drifts from what the parser expects. */
export function formatDependencySection(deps: number[]): string {
  const unique = [...new Set(deps)];
  return ['## Dependencies', ...unique.map((n) => `- [ ] #${n}`)].join('\n');
}

/**
 * Add dependencies to an issue body, creating the `## Dependencies` section
 * if absent. Union semantics: numbers already present (checked or not) are
 * left untouched, so a manual `[x]` override survives. Everything outside
 * the inserted lines is preserved byte-for-byte.
 */
export function upsertDependencySection(body: string, add: number[]): string {
  const existing = new Set(parseDependencySection(body).map((d) => d.issue));
  const missing = [...new Set(add)].filter((n) => !existing.has(n));
  if (missing.length === 0) return body;

  const lines = body.split(/\r?\n/);
  const sections = findDependencySections(lines);
  const itemLines = missing.map((n) => `- [ ] #${n}`);

  if (sections.length === 0) {
    const trimmed = body.replace(/\s+$/, '');
    const section = formatDependencySection(missing);
    return trimmed.length > 0 ? `${trimmed}\n\n${section}\n` : `${section}\n`;
  }

  // Insert into the first section, after its last non-blank line (or right
  // after the heading when the section is empty).
  const { headingIdx, endIdx } = sections[0];
  let insertAfter = headingIdx;
  for (let i = endIdx - 1; i > headingIdx; i--) {
    if (lines[i].trim() !== '') {
      insertAfter = i;
      break;
    }
  }
  lines.splice(insertAfter + 1, 0, ...itemLines);
  return lines.join('\n');
}

/**
 * Remove the `## Dependencies` section(s) from a body. Used when assembling
 * agent prompts so the checklist isn't misread as subtasks — scheduling
 * metadata is the orchestrator's concern, not the agent's.
 *
 * A section that holds only checklist items and blank lines is removed
 * wholesale. If a human interleaved prose into the section, only the
 * heading and the checklist items are removed — their text survives.
 */
export function stripDependencySection(body: string): string {
  const lines = body.split(/\r?\n/);
  const sections = findDependencySections(lines);
  if (sections.length === 0) return body;

  for (let s = sections.length - 1; s >= 0; s--) {
    const { headingIdx, endIdx } = sections[s];
    const content = lines.slice(headingIdx + 1, endIdx);
    const hasProse = content.some(
      (l) => l.trim() !== '' && !CHECKLIST_ITEM.test(l)
    );
    if (!hasProse) {
      lines.splice(headingIdx, endIdx - headingIdx);
    } else {
      for (let i = endIdx - 1; i > headingIdx; i--) {
        if (CHECKLIST_ITEM.test(lines[i])) lines.splice(i, 1);
      }
      lines.splice(headingIdx, 1);
    }
  }

  // Tidy the seams: no leading/trailing blank lines, no triple blanks.
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Blocked computation
// ---------------------------------------------------------------------------

// `isBlocked` lives in the leaf module `dependency-state.ts` so the task
// serializer can reach it without importing this module (which pulls in
// state-sync + ws/dashboard and would close an import cycle). Re-exported
// here because this module owns the dependency concept — call sites and
// tests are unaffected.
export { isBlocked, unsatisfiedDepIssues } from './dependency-state.js';

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/** True when `fromIssue` reaches `targetIssue` by following dependency rows
 *  of tracked tasks in the repo. Walks the persisted projection — untracked
 *  issues are leaves (their bodies aren't parsed, and they can't be
 *  scheduled, so they can't participate in a scheduling cycle). */
export function dependencyPathExists(
  repoId: number,
  fromIssue: number,
  targetIssue: number,
  seen: Set<number> = new Set()
): boolean {
  if (fromIssue === targetIssue) return true;
  if (seen.has(fromIssue)) return false;
  seen.add(fromIssue);
  const task = getTaskByRepoIssue(repoId, fromIssue);
  if (!task) return false;
  for (const row of getTaskDependencies(task.id)) {
    if (dependencyPathExists(repoId, row.dep_issue_number, targetIssue, seen)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Intake validation
// ---------------------------------------------------------------------------

export interface DependencyValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a dependency list at intake (MCP / UI), fail-closed: anything
 * that can't be positively verified is an error. `selfIssueNumber` is set
 * on the queue-existing path where the issue already exists; create-new
 * issues can't self-reference or form cycles (their number isn't assigned
 * yet), so those checks are skipped.
 */
export async function validateDependencies(
  repo: Repo,
  deps: number[],
  forgejo: DependencyForgejo,
  opts: { selfIssueNumber?: number } = {}
): Promise<DependencyValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const seen = new Set<number>();
  for (const n of deps) {
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(`Invalid issue number: ${n}`);
      continue;
    }
    if (seen.has(n)) {
      errors.push(`Duplicate dependency: #${n}`);
      continue;
    }
    seen.add(n);
    if (opts.selfIssueNumber !== undefined && n === opts.selfIssueNumber) {
      errors.push(`Issue #${n} cannot depend on itself`);
    }
  }

  if (
    opts.selfIssueNumber !== undefined &&
    [...seen].some(
      (n) =>
        n !== opts.selfIssueNumber &&
        dependencyPathExists(repo.id, n, opts.selfIssueNumber!)
    )
  ) {
    errors.push(
      `Circular dependency: a listed issue already depends on #${opts.selfIssueNumber}`
    );
  }

  for (const n of seen) {
    if (errors.some((e) => e.includes(`#${n} `) || e.endsWith(`#${n}`))) continue;
    try {
      const issue = await forgejo.getIssue(repo, n);
      if (issue.state === 'closed') {
        warnings.push(`#${n} is already closed — dependency is already satisfied`);
      }
    } catch (err) {
      if (err instanceof ForgejoApiError && err.status === 404) {
        errors.push(`Issue #${n} not found in ${repo.owner}/${repo.name}`);
      } else {
        errors.push(`Could not verify issue #${n}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Short-TTL cache of dep-issue lookups, keyed by repo+number. Dep issues
 *  are often untracked (no task, no snapshot entry), so they get their own
 *  cache. Webhooks invalidate on close/reopen; the TTL bounds staleness for
 *  everything else. Errors are not cached. */
const depIssueCache = new Map<
  string,
  { state: 'open' | 'closed' | 'missing'; expires_at: number }
>();
const DEP_ISSUE_TTL_MS = 30_000;

function depCacheKey(repoId: number, issueNumber: number): string {
  return `${repoId}#${issueNumber}`;
}

export function invalidateDepIssue(repoId: number, issueNumber: number): void {
  depIssueCache.delete(depCacheKey(repoId, issueNumber));
}

/** Exposed for tests. */
export function _clearDependencyCache(): void {
  depIssueCache.clear();
}

async function fetchDepIssueState(
  repo: Repo,
  issueNumber: number,
  forgejo: DependencyForgejo
): Promise<'open' | 'closed' | 'missing' | 'error'> {
  const key = depCacheKey(repo.id, issueNumber);
  const cached = depIssueCache.get(key);
  if (cached && cached.expires_at > Date.now()) return cached.state;
  try {
    const issue = await forgejo.getIssue(repo, issueNumber);
    const state = issue.state === 'closed' ? 'closed' : 'open';
    depIssueCache.set(key, { state, expires_at: Date.now() + DEP_ISSUE_TTL_MS });
    return state;
  } catch (err) {
    if (err instanceof ForgejoApiError && err.status === 404) {
      depIssueCache.set(key, {
        state: 'missing',
        expires_at: Date.now() + DEP_ISSUE_TTL_MS,
      });
      return 'missing';
    }
    return 'error';
  }
}

/** Tracked-task statuses that read as "actively being worked". */
const RUNNING_STATUSES = new Set<string>([
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
]);
/** Tracked-task statuses that read as "gave up while the issue is open". */
const STALLED_STATUSES = new Set<string>(['failed', 'cancelled', 'reset']);

/**
 * Evaluate one task's dependencies from a parsed body and reconcile the
 * `task_dependencies` rows to match (upsert per dep, delete rows for deps
 * no longer listed). Records `dependencies_blocked`/`dependencies_unblocked`
 * timeline events and broadcasts a dashboard update on transitions — but
 * never touches `tasks.status`.
 *
 * Ladder per dep, cheapest first:
 *   1. checked box                         → manually-satisfied (no I/O)
 *   2. tracked task merged                 → satisfied (no I/O; stable —
 *      merges don't un-happen, and this dodges the merge→issue-close race)
 *   3. issue fetch: missing / error / closed → missing / error / satisfied
 *   4. open → cycle / in-progress / failed / open
 *
 * Cycle is derived only for open issues (a closed issue satisfies no matter
 * what stale rows claim), which is why it sits after the fetch.
 *
 * Fail-closed with one anti-flap rule: a fetch error keeps a previously-
 * satisfied row satisfied; anything else becomes `error` and is retried on
 * the next pass.
 */
export async function evaluateTaskDependencies(
  task: Task,
  parsed: ParsedDependency[],
  forgejo: DependencyForgejo,
  log: FastifyBaseLogger
): Promise<DepSummary> {
  const before = getTaskDependencies(task.id);
  const beforeByIssue = new Map(before.map((d) => [d.dep_issue_number, d]));
  const blockedBefore = isBlocked(before);
  const repo = getRepo(task.repo_id);
  const now = new Date().toISOString();

  let changed = false;
  for (const dep of parsed) {
    const prior = beforeByIssue.get(dep.issue);
    let state: DependencyState;
    let detail: string;

    const tracked = repo
      ? getTaskByRepoIssue(repo.id, dep.issue)
      : undefined;

    if (dep.checked) {
      state = 'manually-satisfied';
      detail = 'checked in issue body';
    } else if (tracked && tracked.status === 'merged') {
      state = 'satisfied';
      detail =
        `merged via task #${tracked.id}` +
        (tracked.pr_number ? ` / PR #${tracked.pr_number}` : '');
    } else if (!repo) {
      state = 'error';
      detail = 'repo not found';
    } else {
      const issueState = await fetchDepIssueState(repo, dep.issue, forgejo);
      if (issueState === 'closed') {
        state = 'satisfied';
        detail = 'issue closed';
      } else if (issueState === 'missing') {
        state = 'missing';
        detail = 'issue not found';
      } else if (issueState === 'error') {
        if (prior && SATISFIED_DEP_STATES.has(prior.state)) {
          state = prior.state;
          detail = prior.detail ?? 'retained after fetch error';
        } else {
          state = 'error';
          detail = 'could not check issue';
        }
      } else if (dependencyPathExists(task.repo_id, dep.issue, task.issue_id)) {
        state = 'cycle';
        detail = `circular dependency via #${dep.issue}`;
      } else if (tracked && RUNNING_STATUSES.has(tracked.status)) {
        state = 'in-progress';
        detail = `task #${tracked.id} ${tracked.status}`;
      } else if (tracked && STALLED_STATUSES.has(tracked.status)) {
        state = 'failed';
        detail = `task #${tracked.id} ${tracked.status}, issue still open`;
      } else {
        state = 'open';
        detail = tracked ? `task #${tracked.id} ${tracked.status}` : 'issue open';
      }
    }

    if (
      !prior ||
      prior.state !== state ||
      prior.detail !== detail ||
      prior.checked !== dep.checked
    ) {
      changed = true;
    }
    upsertTaskDependency({
      task_id: task.id,
      dep_issue_number: dep.issue,
      state,
      detail,
      checked: dep.checked,
      last_evaluated_at: now,
    });
  }

  const keep = new Set(parsed.map((d) => d.issue));
  const removed = deleteTaskDependenciesExcept(task.id, keep);
  if (removed > 0) changed = true;

  const after = getTaskDependencies(task.id);
  const blocked = isBlocked(after);

  // Timeline events only for queued tasks — the gate only applies there.
  // Rows for running tasks still sync (the UI shows them), but a task
  // mid-implementation must not narrate "waiting on dependencies".
  if (blocked !== blockedBefore && task.status === 'queued') {
    if (blocked) {
      const blocking = after
        .filter((d) => !SATISFIED_DEP_STATES.has(d.state))
        .map((d) => `#${d.dep_issue_number} (${d.state})`)
        .join(', ');
      recordTaskEvent(
        task.id,
        'dependencies_blocked',
        `Waiting on dependencies: ${blocking}`
      );
    } else {
      recordTaskEvent(
        task.id,
        'dependencies_unblocked',
        'All dependencies satisfied'
      );
    }
    log.info(
      {
        event: blocked ? 'dependencies_blocked' : 'dependencies_unblocked',
        task_id: task.id,
      },
      blocked ? 'Task blocked by dependencies' : 'Task dependencies satisfied'
    );
  }
  if (changed) {
    // Re-read the row: `task` was captured before evaluation, and this
    // broadcast exists precisely because dependency state moved. Sending
    // the stale object would emit an event whose `blocked` / `blocked_by`
    // describe the world before the change that triggered it.
    const fresh = getTask(task.id);
    if (fresh) {
      broadcastDashboardEvent({
        type: 'task_updated',
        task: buildTaskView(fresh),
      });
    }
  }

  return { blocked, deps: after, changed };
}

/** Parse + evaluate in one call, for callers that already hold the issue
 *  body (webhook payloads, polling's per-task issue fetch). */
export async function syncTaskDependencies(
  task: Task,
  body: string,
  forgejo: DependencyForgejo,
  log: FastifyBaseLogger
): Promise<DepSummary> {
  return evaluateTaskDependencies(
    task,
    parseDependencySection(body),
    forgejo,
    log
  );
}

/**
 * Re-evaluate every queued task that depends on `issueNumber` after that
 * issue changed state (closed → may unblock; reopened → may re-block).
 * Re-evaluates from the persisted rows — the dependents' own bodies didn't
 * change, so no per-dependent body fetch is needed. Returns the number of
 * dependents touched so webhook callers know whether to trigger a tick.
 */
export async function reevaluateDependentsOfIssue(
  repoId: number,
  issueNumber: number,
  forgejo: DependencyForgejo,
  log: FastifyBaseLogger
): Promise<number> {
  invalidateDepIssue(repoId, issueNumber);
  const dependents = getDependentTasks(repoId, issueNumber).filter(
    (t) => t.status === 'queued'
  );
  for (const task of dependents) {
    const parsed = getTaskDependencies(task.id).map((d) => ({
      issue: d.dep_issue_number,
      checked: d.checked,
    }));
    try {
      await evaluateTaskDependencies(task, parsed, forgejo, log);
    } catch (err) {
      log.warn(
        { event: 'dependent_reeval_failed', task_id: task.id, err },
        'Could not re-evaluate dependent task'
      );
    }
  }
  return dependents.length;
}

// ---------------------------------------------------------------------------
// Scheduler pass + launch gate
// ---------------------------------------------------------------------------

/** Per-process memory for the scheduler's dependency pass. Owned by the
 *  Scheduler instance; kept here so the pass and the gate that reads it
 *  are testable without constructing a Scheduler. */
export interface DependencyPassState {
  /** Epoch ms of the last completed full pass — the webhook-burst floor. */
  lastFullPassAt: number;
  /** Tasks whose dependencies have been successfully evaluated at least
   *  once this process. The launch gate refuses tasks not in this set, so
   *  "no rows" can never be mistaken for "no dependencies". Never pruned:
   *  ids are cheap, and a stale entry only means the task is gated by its
   *  (persisted) rows instead of by absence. */
  evaluatedTaskIds: Set<number>;
}

export function createDependencyPassState(): DependencyPassState {
  return { lastFullPassAt: 0, evaluatedTaskIds: new Set() };
}

/**
 * Evaluate dependencies for queued tasks, re-deriving rows from the live
 * issue body. Runs on every scheduler tick, independent of pause state and
 * pool capacity (the pre-projection gate skipped dependency checks entirely
 * while the pool was saturated).
 *
 * Full passes are floored to one per DEP_EVAL_MIN_INTERVAL_SECONDS so
 * webhook-triggered tick bursts don't multiply into Forgejo fetch storms;
 * tasks that have never been evaluated bypass the floor. A failed body
 * fetch leaves the task out of `evaluatedTaskIds` (and its prior rows
 * untouched), which the gate treats as blocked — fail closed, retried on
 * the next tick.
 */
export async function runQueuedDependencyPass(
  forgejo: DependencyForgejo,
  log: FastifyBaseLogger,
  state: DependencyPassState,
  opts: { minIntervalMs?: number; now?: () => number } = {}
): Promise<void> {
  const now = opts.now?.() ?? Date.now();
  const minInterval =
    opts.minIntervalMs ?? DEP_EVAL_MIN_INTERVAL_SECONDS * 1000;
  const fullPass = now - state.lastFullPassAt >= minInterval;

  const queued = getQueuedTasks().filter(
    (t) => fullPass || !state.evaluatedTaskIds.has(t.id)
  );

  for (const task of queued) {
    const repo = getRepo(task.repo_id);
    if (!repo) continue;
    try {
      const issue = await forgejo.getIssue(repo, task.issue_id);
      await syncTaskDependencies(task, issue.body ?? '', forgejo, log);
      state.evaluatedTaskIds.add(task.id);
    } catch (err) {
      log.warn(
        { event: 'dependency_eval_failed', task_id: task.id, err },
        'Could not evaluate task dependencies — task stays gated'
      );
    }
  }

  if (fullPass) state.lastFullPassAt = now;
}

/** Launch gate for queued candidates. True only when the task has been
 *  successfully evaluated at least once this process AND every persisted
 *  dependency is satisfied. Synchronous — fillSlots stays free of
 *  per-candidate Forgejo calls. */
export function dependencyGateAllows(
  task: Task,
  state: DependencyPassState
): boolean {
  return (
    state.evaluatedTaskIds.has(task.id) &&
    !isBlocked(getTaskDependencies(task.id))
  );
}
