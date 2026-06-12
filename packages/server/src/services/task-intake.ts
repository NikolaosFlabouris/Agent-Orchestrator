/**
 * Task intake service — the single canonical path that creates a task in
 * both Forgejo (as an issue + status/queued label) and the orchestrator
 * (as a row in the `tasks` table, broadcast on the dashboard WS, with the
 * scheduler kicked).
 *
 * Two callers exist today (both go through this file):
 *
 *  - `POST /api/tasks`        — the UI's "Create and queue" form.
 *  - `POST /api/tasks/queue`  — the UI's "Queue existing issue" form.
 *
 * A third caller is planned (the MCP `create_task` tool, Phase 3) and
 * lands here too, so the REST route and the MCP tool can never diverge
 * on validation rules, label semantics, override handling, broadcast,
 * or scheduler kick. Anything that's "part of creating a task" lives in
 * this module; route handlers are thin adapters that map a request
 * shape onto this service and map its tagged-union result back to a
 * transport-appropriate response (HTTP status, MCP tool error, …).
 *
 * Validation behaviour intentionally matches the prior inline route
 * logic byte-for-byte so the refactor is a no-op for HTTP clients:
 * same field names, same error messages, same status code mapping at
 * the caller boundary.
 */

import type { Task, Repo } from '@orchestrator/shared';
import type { FastifyBaseLogger } from 'fastify';
import {
  getAgentProfile,
  getAgentProfiles,
  getModel,
  getProvider,
  getRepo,
  getRepos,
  getSetting,
  insertTask,
} from '../db.js';
import type { ForgejoClient } from '../forgejo.js';
import type { Scheduler } from '../scheduler.js';
import { notifyTaskCreated } from '../state-sync.js';
import {
  upsertDependencySection,
  validateDependencies,
} from '../dependencies.js';

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------
//
// These were inline helpers in routes/tasks.ts. They live here now because
// the service owns the validation contract — any caller (REST route, MCP
// tool, future SDK) gets the same input shape rules without re-implementing
// them. The route file re-exports `asPositiveInt` as a thin wrapper so
// existing imports from tests keep working without churn (see routes/tasks.ts).

/** Coerce a body value to a positive integer (>= 1). Returns null when
 *  the value is missing, the wrong type, non-finite, fractional, or
 *  zero/negative. JSON allows strings that look like numbers, so we
 *  accept those too. */
export function asPositiveInt(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 1 ? v : null;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }
  return null;
}

/** Validate an optional agent-profile override on a task-create body
 *  (`agent_profile_id` or `review_agent_profile_id`).
 *  - undefined / null / empty-string → no override, returns `null`
 *    (these are equivalent: the form posts '' meaning "inherit", the API
 *    accepts a literal null with the same meaning, and a missing key is
 *    "inherit" too).
 *  - non-empty string → must reference an existing profile row.
 *  - any other type → invalid.
 *
 *  The `lookupProfile` indirection lets unit tests substitute a stub
 *  rather than booting the DB for a pure validator check. Defaults to
 *  the real `getAgentProfile` so production callers pass two args.
 *  `fieldName` only affects error messages — pass the request-body key
 *  so a rejected review override names the right field. */
export function validateAgentProfileOverride(
  raw: unknown,
  lookupProfile: (id: string) => unknown = getAgentProfile,
  fieldName = 'agent_profile_id'
):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: `${fieldName} must be a string or null` };
  }
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!lookupProfile(trimmed)) {
    return { ok: false, error: `Unknown ${fieldName}: ${trimmed}` };
  }
  return { ok: true, value: trimmed };
}

/** Validate the shape of the optional `dependencies` input: an array of
 *  positive integers (issue numbers in the task's repo). Missing/null →
 *  empty list. Semantic validation (issues exist, no self-reference, no
 *  cycle) happens against Forgejo/DB in `validateDependencies` — this is
 *  just the type gate. */
export function validateDependenciesInput(
  raw: unknown
):
  | { ok: true; value: number[] }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'dependencies must be an array of issue numbers' };
  }
  const out: number[] = [];
  for (const item of raw) {
    const n = asPositiveInt(item);
    if (n === null) {
      return {
        ok: false,
        error: 'dependencies must contain only positive integers',
      };
    }
    out.push(n);
  }
  return { ok: true, value: out };
}

/** Validate the optional `max_attempts` override.
 *  - undefined / null → no override, returns `undefined` (caller passes
 *    nothing to insertTask, which then applies DEFAULT_MAX_ATTEMPTS).
 *  - anything else → must coerce to a positive integer.
 *
 *  Note: we deliberately do NOT accept `''` here — POST /api/tasks
 *  historically accepted only number or omitted, and the new direct-INSERT
 *  paths must keep the same strictness so a junk value can't slip past
 *  into the DB (where `attempt > max_attempts` would then mis-fire). */
export function validateMaxAttemptsOverride(
  raw: unknown
):
  | { ok: true; value: number | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const v = asPositiveInt(raw);
  if (v === null) {
    return { ok: false, error: 'max_attempts must be a positive integer' };
  }
  return { ok: true, value: v };
}

// ---------------------------------------------------------------------------
// Service result shape
// ---------------------------------------------------------------------------

/** Discriminated error kind — callers map this to HTTP status / MCP error.
 *  Keep the set small and meaningful; the same kind should map identically
 *  across all transports. */
export type TaskIntakeError =
  | { kind: 'invalid'; message: string }        // bad input shape / validation failure → 400
  | { kind: 'not_found'; message: string }       // repo (or issue) doesn't exist     → 404
  | { kind: 'forgejo_failure'; message: string }; // upstream Forgejo error            → 502/500

export type TaskIntakeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TaskIntakeError };

export interface CreatedTask {
  task: Task;
  /** The Forgejo issue that backs this task. Number and title are the
   *  fields the route response / MCP tool reply expose. */
  issue: { number: number; title: string };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
//
// Inputs are typed `unknown` at the boundary so route handlers can hand
// the raw body straight through without pre-validation. The service is
// the validation layer.

// All input fields are typed `unknown` (with every key optional) so a
// route adapter can hand the raw body straight through without
// pre-validating the shape. The service is the validation layer — it
// checks presence + type, and emits `kind: 'invalid'` for anything
// missing or malformed. Marking every field optional matches that
// contract; the interface is documentation, not enforcement.

export interface CreateTaskInput {
  repo_id?: unknown;
  title?: unknown;
  description?: unknown;
  /** Optional issue numbers this task must wait for. Written into the
   *  issue body as the canonical `## Dependencies` checklist. */
  dependencies?: unknown;
  agent_profile_id?: unknown;
  review_agent_profile_id?: unknown;
  max_attempts?: unknown;
  human_merge?: unknown;
  human_review?: unknown;
}

export interface QueueExistingIssueInput {
  repo_id?: unknown;
  issue_id?: unknown;
  /** Optional issue numbers to ADD to the existing issue's
   *  `## Dependencies` section (union — existing entries are kept). */
  dependencies?: unknown;
  agent_profile_id?: unknown;
  review_agent_profile_id?: unknown;
  max_attempts?: unknown;
  human_merge?: unknown;
  human_review?: unknown;
}

export interface IntakeDeps {
  forgejo: ForgejoClient;
  scheduler: Pick<Scheduler, 'triggerTick'>;
  /** Optional logger — used only for best-effort warnings (e.g. a label
   *  application that failed). Tests pass nothing. */
  log?: FastifyBaseLogger;
}

// ---------------------------------------------------------------------------
// Public services
// ---------------------------------------------------------------------------

/**
 * Create a new Forgejo issue (with the supplied title + body), apply the
 * orchestrator's status/queued label plus any optional override labels,
 * insert the matching task row with overrides set atomically, broadcast
 * the new-task event to dashboard websockets, and trigger a scheduler
 * tick.
 *
 * The label application is best-effort to match the prior behaviour of
 * `POST /api/tasks`: a label failure does NOT roll back the created issue
 * or the task row — the fallback 60s poller and the orchestrator's own
 * webhook handling will reconcile labels later. We log the warning
 * through the optional logger so the operator can see it post-hoc.
 *
 * Returns the inserted task + the issue identity. Errors are tagged so
 * the caller can map to its transport (HTTP / MCP / …).
 */
export async function createTask(
  input: CreateTaskInput,
  deps: IntakeDeps
): Promise<TaskIntakeResult<CreatedTask>> {
  const { forgejo, scheduler, log } = deps;

  // -- Validation ---------------------------------------------------------
  if (
    input.repo_id === undefined ||
    input.repo_id === null ||
    input.title === undefined ||
    input.description === undefined
  ) {
    return invalid('Required: repo_id, title, description');
  }
  const repoId = asPositiveInt(input.repo_id);
  if (repoId === null) {
    return invalid('repo_id must be a positive integer');
  }
  const repo = getRepo(repoId);
  if (!repo) return notFound('Repo not found');

  if (typeof input.title !== 'string' || typeof input.description !== 'string') {
    return invalid('title and description must be strings');
  }

  const profileCheck = validateAgentProfileOverride(input.agent_profile_id);
  if (!profileCheck.ok) return invalid(profileCheck.error);

  const reviewProfileCheck = validateAgentProfileOverride(
    input.review_agent_profile_id,
    getAgentProfile,
    'review_agent_profile_id'
  );
  if (!reviewProfileCheck.ok) return invalid(reviewProfileCheck.error);

  const maxAttemptsCheck = validateMaxAttemptsOverride(input.max_attempts);
  if (!maxAttemptsCheck.ok) return invalid(maxAttemptsCheck.error);

  const depsCheck = validateDependenciesInput(input.dependencies);
  if (!depsCheck.ok) return invalid(depsCheck.error);

  // Semantic dependency validation, fail-closed: every referenced issue
  // must exist in the repo. (No self/cycle checks here — the new issue's
  // number doesn't exist yet, so neither can occur.) Already-closed deps
  // are fine: they are simply satisfied from the start.
  let body = input.description;
  if (depsCheck.value.length > 0) {
    const depValidation = await validateDependencies(
      repo,
      depsCheck.value,
      forgejo
    );
    if (!depValidation.ok) {
      return invalid(depValidation.errors.join('; '));
    }
    // Canonical section writer — unions with any section the author
    // already typed into the description by hand.
    body = upsertDependencySection(input.description, depsCheck.value);
  }

  // -- Forgejo issue creation --------------------------------------------
  // Issue creation is the only step that can fail in a way the caller
  // needs to distinguish from a validation error — the upstream may be
  // unreachable, the token may be revoked, the repo may have been
  // deleted in Forgejo since registration. Wrap it explicitly.
  let issue;
  try {
    issue = await forgejo.createIssue(repo, {
      title: input.title,
      body,
    });
  } catch (err) {
    return forgejoFailure(
      `Failed to create Forgejo issue: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // -- Apply labels + insert the task row + broadcast + tick -------------
  const task = await applyLabelsAndInsertTask(
    { forgejo, scheduler, log },
    repo,
    { number: issue.number, title: issue.title },
    {
      agentProfileId: profileCheck.value,
      reviewAgentProfileId: reviewProfileCheck.value,
      maxAttempts: maxAttemptsCheck.value,
      humanMerge: input.human_merge === true,
      humanReview: input.human_review === true,
    }
  );

  return {
    ok: true,
    value: { task, issue: { number: issue.number, title: issue.title } },
  };
}

/**
 * Queue an issue that already exists in Forgejo: best-effort fetch its
 * title (so the orchestrator's task row shows something other than
 * "Issue #N"), apply labels, insert the task row with overrides,
 * broadcast, and tick. Same overrides contract as `createTask`.
 *
 * Title-fetch failure is non-fatal — we fall through with title=null
 * and `enrichTask` later renders "Issue #N" when surfacing the task.
 */
export async function queueExistingIssue(
  input: QueueExistingIssueInput,
  deps: IntakeDeps
): Promise<TaskIntakeResult<CreatedTask>> {
  const { forgejo, scheduler, log } = deps;

  // -- Validation ---------------------------------------------------------
  if (
    input.issue_id === undefined ||
    input.issue_id === null ||
    input.repo_id === undefined ||
    input.repo_id === null
  ) {
    return invalid('Required: issue_id, repo_id');
  }
  const repoId = asPositiveInt(input.repo_id);
  if (repoId === null) {
    return invalid('repo_id must be a positive integer');
  }
  const repo = getRepo(repoId);
  if (!repo) return notFound('Repo not found');

  const issueId = asPositiveInt(input.issue_id);
  if (issueId === null) {
    return invalid('issue_id must be a positive integer');
  }

  const profileCheck = validateAgentProfileOverride(input.agent_profile_id);
  if (!profileCheck.ok) return invalid(profileCheck.error);

  const reviewProfileCheck = validateAgentProfileOverride(
    input.review_agent_profile_id,
    getAgentProfile,
    'review_agent_profile_id'
  );
  if (!reviewProfileCheck.ok) return invalid(reviewProfileCheck.error);

  const maxAttemptsCheck = validateMaxAttemptsOverride(input.max_attempts);
  if (!maxAttemptsCheck.ok) return invalid(maxAttemptsCheck.error);

  const depsCheck = validateDependenciesInput(input.dependencies);
  if (!depsCheck.ok) return invalid(depsCheck.error);

  // -- Best-effort title fetch -------------------------------------------
  // (Mandatory when dependencies were supplied: we must read the current
  // body to union the section into it — writing blind would clobber.)
  let issueTitle: string | null = null;
  let issueBody: string | null = null;
  try {
    const fullIssue = await forgejo.getIssue(repo, issueId);
    issueTitle = fullIssue.title;
    issueBody = fullIssue.body ?? '';
  } catch (err) {
    if (depsCheck.value.length > 0) {
      return forgejoFailure(
        `Cannot add dependencies: failed to fetch issue #${issueId} from Forgejo`
      );
    }
    log?.warn(
      { event: 'task_intake_title_fetch_failed', issue_id: issueId, err },
      'Failed to fetch Forgejo issue title — falling back to "Issue #N"'
    );
  }

  // -- Dependency section write ------------------------------------------
  // Semantic validation includes self-reference and cycle checks here —
  // the issue already exists, so both are possible. The body update is
  // last-writer-wins (Forgejo has no conditional PATCH); the fetch above
  // happened moments ago, which keeps the race window small.
  if (depsCheck.value.length > 0) {
    const depValidation = await validateDependencies(
      repo,
      depsCheck.value,
      forgejo,
      { selfIssueNumber: issueId }
    );
    if (!depValidation.ok) {
      return invalid(depValidation.errors.join('; '));
    }
    const updated = upsertDependencySection(issueBody ?? '', depsCheck.value);
    if (updated !== issueBody) {
      try {
        await forgejo.updateIssueBody(repo, issueId, updated);
      } catch (err) {
        return forgejoFailure(
          `Failed to write dependencies onto issue #${issueId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  const task = await applyLabelsAndInsertTask(
    { forgejo, scheduler, log },
    repo,
    { number: issueId, title: issueTitle },
    {
      agentProfileId: profileCheck.value,
      reviewAgentProfileId: reviewProfileCheck.value,
      maxAttempts: maxAttemptsCheck.value,
      humanMerge: input.human_merge === true,
      humanReview: input.human_review === true,
    }
  );

  return {
    ok: true,
    value: { task, issue: { number: issueId, title: issueTitle ?? `Issue #${issueId}` } },
  };
}

// ---------------------------------------------------------------------------
// listReposWithEffectiveProfile — for the future MCP `list_repos` tool
// ---------------------------------------------------------------------------

export interface EffectiveProfileInfo {
  id: string;
  display_name: string;
  harness_id: string;
  timeout_minutes: number;
  model_id: string | null;
  provider_id: string | null;
  provider_display_name: string | null;
}

export interface RepoWithEffectiveProfile {
  id: number;
  owner: string;
  name: string;
  base_branch: string;
  /** The repo's own override, if any. */
  repo_agent_profile_id: string | null;
  /** The global default at the time of read. */
  global_default_agent_profile_id: string | null;
  /** The resolved profile id — repo override wins, else global default,
   *  else null. Mirrors `resolveEffectiveAgentProfile` minus the task tier
   *  (we don't have a task in this listing). */
  effective_agent_profile_id: string | null;
  agent_profile_source: 'repo' | 'global' | 'none';
  /** Joined-through profile info; null when no profile is resolvable
   *  (e.g. the global default points at a deleted profile). */
  effective_profile: EffectiveProfileInfo | null;
  /** The repo's review-stage override, if any. */
  repo_review_agent_profile_id: string | null;
  /** The resolved review profile id — repo review override → global
   *  review default → the effective implementation profile above. */
  effective_review_agent_profile_id: string | null;
  /** 'implementation' = no review tier set anywhere; review runs with
   *  the implementation profile. */
  review_agent_profile_source: 'repo' | 'global' | 'implementation' | 'none';
  effective_review_profile: EffectiveProfileInfo | null;
}

/**
 * List every registered repo with the agent profile that would run a
 * fresh task against it by default (repo override → global default →
 * none), with the profile's display name, harness, model, and provider
 * joined in. This is the data the MCP `list_repos` tool returns and
 * what the old `create-task-forgejo` skill assembled by hand via
 * `docker exec` SQL — centralised here so the skill (now an MCP client)
 * never has to know the schema.
 */
export function listReposWithEffectiveProfile(): RepoWithEffectiveProfile[] {
  const repos = getRepos();
  const globalDefault = getSetting('default_agent_profile_id') ?? null;
  const globalReviewDefault =
    getSetting('default_review_agent_profile_id') ?? null;

  // Pre-fetch profiles once and index by id so the per-repo resolution
  // is O(1) lookups rather than N×getAgentProfile calls.
  const profilesById = new Map(getAgentProfiles().map((p) => [p.id, p]));

  const joinProfile = (id: string | null): EffectiveProfileInfo | null => {
    if (!id) return null;
    const p = profilesById.get(id);
    if (!p) return null;
    const model = getModel(p.model_pk);
    const provider = model ? getProvider(model.provider_id) : undefined;
    return {
      id: p.id,
      display_name: p.display_name,
      harness_id: p.harness_id,
      timeout_minutes: p.timeout_minutes,
      model_id: model?.model_id ?? null,
      provider_id: model?.provider_id ?? null,
      provider_display_name: provider?.display_name ?? null,
    };
  };

  return repos.map((repo) => {
    const repoProfileId = repo.agent_profile_id ?? null;
    let effectiveId: string | null;
    let source: 'repo' | 'global' | 'none';
    if (repoProfileId) {
      effectiveId = repoProfileId;
      source = 'repo';
    } else if (globalDefault) {
      effectiveId = globalDefault;
      source = 'global';
    } else {
      effectiveId = null;
      source = 'none';
    }

    // Review chain (minus the task tier): repo review override → global
    // review default → the effective implementation profile.
    const repoReviewProfileId = repo.review_agent_profile_id ?? null;
    let effectiveReviewId: string | null;
    let reviewSource: 'repo' | 'global' | 'implementation' | 'none';
    if (repoReviewProfileId) {
      effectiveReviewId = repoReviewProfileId;
      reviewSource = 'repo';
    } else if (globalReviewDefault) {
      effectiveReviewId = globalReviewDefault;
      reviewSource = 'global';
    } else if (effectiveId) {
      effectiveReviewId = effectiveId;
      reviewSource = 'implementation';
    } else {
      effectiveReviewId = null;
      reviewSource = 'none';
    }

    return {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      base_branch: repo.base_branch,
      repo_agent_profile_id: repoProfileId,
      global_default_agent_profile_id: globalDefault,
      effective_agent_profile_id: effectiveId,
      agent_profile_source: source,
      effective_profile: joinProfile(effectiveId),
      repo_review_agent_profile_id: repoReviewProfileId,
      effective_review_agent_profile_id: effectiveReviewId,
      review_agent_profile_source: reviewSource,
      effective_review_profile: joinProfile(effectiveReviewId),
    };
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Apply the standard `status/queued` label (+ optional human-* overrides),
 *  insert the task row with the resolved overrides, broadcast on the
 *  dashboard WS, and trigger a scheduler tick. Shared by `createTask` and
 *  `queueExistingIssue` so the post-issue flow is identical regardless of
 *  whether the issue was just created or pre-existed.
 *
 *  Label application is **best-effort** — a failure logs a warning but
 *  does NOT abort the task creation. This matches the prior route
 *  behaviour: the orchestrator's own webhook handler / 60s poller would
 *  otherwise reconcile the label later, so a transient Forgejo blip
 *  shouldn't lose the task. The row insert is the load-bearing step. */
async function applyLabelsAndInsertTask(
  deps: IntakeDeps,
  repo: Repo,
  issue: { number: number; title: string | null },
  overrides: {
    agentProfileId: string | null;
    reviewAgentProfileId: string | null;
    maxAttempts: number | undefined;
    humanMerge: boolean;
    humanReview: boolean;
  }
): Promise<Task> {
  const { forgejo, scheduler, log } = deps;

  const labelNames = ['status/queued'];
  if (overrides.humanMerge) labelNames.push('human-merge');
  if (overrides.humanReview) labelNames.push('human-review');

  try {
    await forgejo.replaceLabelByNames(repo, issue.number, labelNames);
  } catch (err) {
    log?.warn(
      {
        event: 'task_intake_label_failed',
        issue_id: issue.number,
        labels: labelNames,
        err,
      },
      'Best-effort label application failed — the orchestrator will reconcile via the 60s poller'
    );
  }

  const task = insertTask({
    issue_id: issue.number,
    issue_title: issue.title,
    repo_id: repo.id,
    status: 'queued',
    max_attempts: overrides.maxAttempts,
    agent_profile_id: overrides.agentProfileId,
    review_agent_profile_id: overrides.reviewAgentProfileId,
  });

  notifyTaskCreated(task);
  scheduler.triggerTick();
  return task;
}

function invalid(message: string): TaskIntakeResult<never> {
  return { ok: false, error: { kind: 'invalid', message } };
}

function notFound(message: string): TaskIntakeResult<never> {
  return { ok: false, error: { kind: 'not_found', message } };
}

function forgejoFailure(message: string): TaskIntakeResult<never> {
  return { ok: false, error: { kind: 'forgejo_failure', message } };
}
