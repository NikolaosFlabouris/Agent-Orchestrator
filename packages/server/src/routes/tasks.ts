import type { FastifyInstance } from 'fastify';
import {
  getTask,
  getTasks,
  getRepo,
  getAttempts,
  getTaskEvents,
  getAgentProfile,
  getSetting,
} from '../db.js';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import type { Task, TaskStatus, Attempt } from '@orchestrator/shared';
import type { ForgejoClient } from '../forgejo.js';
import type { Scheduler } from '../scheduler.js';
import { cancelTask, resetTask, requeueTask, extendTask } from '../actions.js';
import { updateTaskWithSync, recordTaskEvent } from '../state-sync.js';
import { attemptMerge } from '../agents/review.js';
import { getOutputDir } from '../workspace.js';
import { getSnapshot, warmRepoSnapshots } from '../forgejo-snapshot.js';
import { deriveStatus } from '../status-derivation.js';
import {
  computeTaskHealth,
  getContainerDisplayName,
} from '../orphan-recovery.js';
import { listContainers } from '../docker.js';
import {
  createTask as createTaskService,
  queueExistingIssue as queueExistingIssueService,
  type TaskIntakeError,
} from '../services/task-intake.js';

const FORGEJO_URL = process.env.FORGEJO_URL ?? 'http://forgejo:3000';

const ACTIVE_STATUSES = new Set([
  'preparing',
  'in-progress',
  'in-review',
  'changes-needed',
]);

const RESETTABLE_STATUSES = new Set([
  'failed',
  'cancelled',
  'awaiting-human-merge',
  'awaiting-human-review',
  'needs-human-review',
]);

const REQUEUEABLE_STATUSES = new Set([
  'reset',
  'cancelled',
]);

const EXTENDABLE_STATUSES = new Set(['failed']);

/** Map a tagged service error onto an HTTP status. Kept here next to the
 *  routes (rather than in the service) because the mapping is a transport
 *  decision — MCP tools, for example, won't surface a 404 but a tool-error
 *  envelope. The service stays transport-agnostic by emitting kinds. */
function statusForIntakeError(error: TaskIntakeError): number {
  switch (error.kind) {
    case 'invalid':
      return 400;
    case 'not_found':
      return 404;
    case 'forgejo_failure':
      return 500;
  }
}

export function createTaskRoutes(
  forgejo: ForgejoClient,
  scheduler: Scheduler
) {
  return async function taskRoutes(app: FastifyInstance): Promise<void> {
    const log = app.log;

    // GET /api/tasks
    app.get('/api/tasks', async (request) => {
      const query = request.query as { status?: string; limit?: string };
      const limit = parseInt(query.limit ?? '20', 10);

      const allTasks = getTasks(
        query.status ? { status: query.status as any } : undefined
      );

      // One Docker call for the whole list — per-task lookup would scale
      // linearly with task count and N round-trips to the Docker socket on
      // every dashboard refresh. Best-effort: on failure, health degrades
      // gracefully to 'healthy' (we'd rather mislabel than block the UI).
      const managedIds = await loadManagedContainerIds(log);

      // Batch-warm the Forgejo snapshot cache one repo at a time. Without
      // this, enrichTaskWithDerivation below would issue 1–2 Forgejo HTTP
      // calls per task (getIssue + optional getPullRequest). With it, we do
      // at most 2 paginated list calls per repo regardless of task count,
      // and the per-task `getSnapshot` calls hit warm cache.
      const tasksByRepo = new Map<number, typeof allTasks>();
      for (const t of allTasks) {
        const arr = tasksByRepo.get(t.repo_id);
        if (arr) arr.push(t);
        else tasksByRepo.set(t.repo_id, [t]);
      }
      await Promise.all(
        Array.from(tasksByRepo.entries()).map(async ([repoId, tasks]) => {
          const repo = getRepo(repoId);
          if (repo) await warmRepoSnapshots(repo, tasks, forgejo, log);
        })
      );

      const enriched = await Promise.all(
        allTasks.map((t) =>
          enrichTaskWithDerivation(t, forgejo, { managedIds })
        )
      );

      if (!query.status) {
        const active: typeof enriched = [];
        const queued: typeof enriched = [];
        const completed: typeof enriched = [];

        for (const t of enriched) {
          if (ACTIVE_STATUSES.has(t.status)) active.push(t);
          else if (t.status === 'queued') queued.push(t);
          else completed.push(t);
        }

        return { tasks: [...active, ...queued, ...completed.slice(0, limit)] };
      }

      return { tasks: enriched };
    });

    // GET /api/tasks/:id
    app.get<{ Params: { id: string } }>(
      '/api/tasks/:id',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const task = getTask(id);
        if (!task) return reply.status(404).send({ error: 'Task not found' });

        const managedIds = await loadManagedContainerIds(log);
        const containerName = await getContainerDisplayName(
          task.container_id,
          log
        );
        const enriched = await enrichTaskWithDerivation(task, forgejo, {
          managedIds,
          containerName,
        });
        const attempts = getAttempts(task.id);
        const repo = getRepo(task.repo_id);

        const forgejoLinks: Record<string, string> = {};
        if (repo) {
          forgejoLinks.issue = `${FORGEJO_URL}/${repo.owner}/${repo.name}/issues/${task.issue_id}`;
          if (task.pr_number) {
            forgejoLinks.pr = `${FORGEJO_URL}/${repo.owner}/${repo.name}/pulls/${task.pr_number}`;
          }
        }

        const events = getTaskEvents(task.id);
        return { ...enriched, attempts, events, forgejo_links: forgejoLinks };
      }
    );

    // GET /api/tasks/:id/events
    app.get<{ Params: { id: string } }>(
      '/api/tasks/:id/events',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const task = getTask(id);
        if (!task) return reply.status(404).send({ error: 'Task not found' });
        return { events: getTaskEvents(task.id) };
      }
    );

    // GET /api/tasks/:id/log
    app.get<{ Params: { id: string } }>(
      '/api/tasks/:id/log',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const task = getTask(id);
        if (!task) return reply.status(404).send({ error: 'Task not found' });

        const path = await import('node:path');
        const fs = await import('node:fs');

        const logPath = path.join(getOutputDir(task), 'progress.log');
        if (!fs.existsSync(logPath)) {
          return reply.status(404).send({ error: 'Log not found' });
        }

        reply.type('text/plain');
        return fs.createReadStream(logPath);
      }
    );

    // POST /api/tasks — create new issue and queue.
    // Thin adapter: hand the raw body to the task-intake service, which
    // owns validation, Forgejo issue creation, label application, the row
    // insert with overrides, the dashboard broadcast, and the scheduler
    // tick. The route only knows how to turn a tagged-union result into
    // an HTTP response. (The MCP `create_task` tool calls the same
    // service — they cannot diverge on rules or side effects.)
    app.post('/api/tasks', async (request, reply) => {
      const result = await createTaskService(
        request.body as Record<string, unknown>,
        { forgejo, scheduler, log }
      );
      if (!result.ok) {
        return reply
          .status(statusForIntakeError(result.error))
          .send({ error: result.error.message });
      }
      return reply.status(201).send(enrichTask(result.value.task));
    });

    // POST /api/tasks/queue — queue an issue that already exists in
    // Forgejo. Same service, sibling entry point.
    app.post('/api/tasks/queue', async (request, reply) => {
      const result = await queueExistingIssueService(
        request.body as Record<string, unknown>,
        { forgejo, scheduler, log }
      );
      if (!result.ok) {
        return reply
          .status(statusForIntakeError(result.error))
          .send({ error: result.error.message });
      }
      return reply.status(201).send(enrichTask(result.value.task));
    });

    // PATCH /api/tasks/:id — task actions
    app.patch<{ Params: { id: string } }>(
      '/api/tasks/:id',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const task = getTask(id);
        if (!task) return reply.status(404).send({ error: 'Task not found' });

        const body = request.body as Record<string, unknown>;

        // Direct field update: agent_profile_id (no action required).
        // null clears the override and reverts to the repo default
        // (or, transitively, the global default).
        if ('agent_profile_id' in body) {
          const raw = body.agent_profile_id;
          if (raw !== null && typeof raw !== 'string') {
            return reply.status(400).send({
              error: 'agent_profile_id must be a string or null',
            });
          }
          // PATCH semantics: null = clear override (inherit). Empty
          // string is rejected explicitly rather than silently
          // normalized to null — the caller is editing in-place and
          // should be clear about intent. This also avoids the
          // "Unknown agent_profile_id: " dangling-colon error shape
          // that the underlying helper produces for empty strings
          // (H5). Use null to clear instead.
          if (typeof raw === 'string' && raw.trim() === '') {
            return reply.status(400).send({
              error:
                'agent_profile_id cannot be empty. Pass null to clear the per-task override.',
            });
          }
          const newProfile = (raw === null ? null : (raw as string).trim());

          const validation = validateAgentProfile(newProfile, getAgentProfile);
          if (!validation.valid) {
            return reply.status(400).send({ error: validation.error });
          }

          const oldProfile = task.agent_profile_id;
          updateTaskWithSync(task.id, { agent_profile_id: newProfile });

          const fromLabel = oldProfile ?? '(inherit)';
          const toLabel = newProfile ?? '(inherit)';
          recordTaskEvent(
            task.id,
            'agent_profile_changed',
            `Agent profile changed from ${fromLabel} to ${toLabel}`
          );

          const repo = getRepo(task.repo_id);
          if (repo) {
            try {
              await forgejo.commentOnIssue(
                repo,
                task.issue_id,
                `Agent profile changed to \`${newProfile ?? 'inherit'}\` — takes effect on next attempt.`
              );
            } catch {
              // Best effort
            }
          }

          const updated = getTask(id)!;
          return enrichTask(updated);
        }

        // Direct field update: max_attempts (no action required).
        // Forbidden in terminal states — use the `extend` action for `failed`,
        // or `requeue` for `cancelled`/`reset`. Cannot drop below the current
        // attempt count (use `force_fail` if you want to terminate early).
        if ('max_attempts' in body) {
          if (TERMINAL_STATUSES.has(task.status)) {
            return reply.status(409).send({
              error: `Cannot edit max_attempts on a task in terminal state '${task.status}'. Use 'extend' on failed tasks or 'requeue' on cancelled/reset tasks.`,
            });
          }
          const raw = body.max_attempts;
          if (
            typeof raw !== 'number' ||
            !Number.isInteger(raw) ||
            raw < 1
          ) {
            return reply
              .status(400)
              .send({ error: 'max_attempts must be a positive integer' });
          }
          if (raw < task.attempt) {
            return reply.status(400).send({
              error: `Cannot set max_attempts below current attempt count of ${task.attempt}`,
            });
          }
          const oldMax = task.max_attempts;
          updateTaskWithSync(task.id, { max_attempts: raw });
          recordTaskEvent(
            task.id,
            'max_attempts_changed',
            `Max attempts changed from ${oldMax} to ${raw}`
          );
          const updated = getTask(id)!;
          return enrichTask(updated);
        }

        const action = body?.action as string;

        switch (action) {
          case 'reorder': {
            if (task.status !== 'queued') {
              return reply
                .status(400)
                .send({ error: 'Can only reorder queued tasks' });
            }
            const targetPos = body.queue_position as number;
            if (typeof targetPos !== 'number') {
              return reply
                .status(400)
                .send({ error: 'queue_position required' });
            }
            // Swap positions: find the task currently at the target position
            // and give it the dragged task's old position
            const { getDb: db } = await import('../db.js');
            const targetTask = db()
              .prepare(
                "SELECT id FROM tasks WHERE queue_position = ? AND status = 'queued' AND id != ?"
              )
              .get(targetPos, task.id) as { id: number } | undefined;

            if (targetTask) {
              // Swap: target gets dragged task's old position
              updateTaskWithSync(targetTask.id, {
                queue_position: task.queue_position,
              });
            }
            updateTaskWithSync(task.id, { queue_position: targetPos });
            break;
          }
 
          case 'requeue': {
            if (!REQUEUEABLE_STATUSES.has(task.status)) {
              return reply.status(400).send({
                error: `Cannot requeue task in state '${task.status}'. Valid states: ${[...REQUEUEABLE_STATUSES].join(', ')}`,
              });
            }
            await requeueTask(task, forgejo, scheduler, log);
            break;
          }

          case 'extend': {
            if (!EXTENDABLE_STATUSES.has(task.status)) {
              return reply.status(400).send({
                error: `Cannot extend task in state '${task.status}'. Valid states: ${[...EXTENDABLE_STATUSES].join(', ')}`,
              });
            }
            const additional = body.additional_attempts;
            if (
              typeof additional !== 'number' ||
              !Number.isInteger(additional) ||
              additional < 1 ||
              additional > 10
            ) {
              return reply.status(400).send({
                error: 'additional_attempts must be an integer between 1 and 10',
              });
            }
            await extendTask(task, forgejo, scheduler, log, additional);
            break;
          }

          case 'cancel': {
            if (TERMINAL_STATUSES.has(task.status)) {

              return reply
                .status(400)
                .send({ error: 'Cannot cancel a task in terminal state' });
            }
            await cancelTask(
              task,
              forgejo,
              scheduler,
              log,
              (body.reason as string) ?? 'Cancelled by user'
            );
            break;
          }

          case 'force_approve': {
            if (task.status !== 'in-review') {
              return reply
                .status(400)
                .send({ error: 'Can only force-approve tasks in review' });
            }
            await attemptMerge(task, forgejo, log, (t, fb) =>
              scheduler.launchDevContainer(t, fb)
            );
            break;
          }

          case 'force_fail': {
            if (TERMINAL_STATUSES.has(task.status)) {
              return reply
                .status(400)
                .send({ error: 'Cannot force-fail a task in terminal state' });
            }
            // Stop container if running
            if (task.container_id) {
              try {
                const { getContainer, stopContainer, removeContainer } =
                  await import('../docker.js');
                const container = getContainer(task.container_id);
                await stopContainer(container);
                await removeContainer(container);
              } catch {
                // Best effort
              }
            }
            updateTaskWithSync(task.id, {
              status: 'failed',
              container_id: null,
              completed_at: new Date().toISOString(),
            });
            const reason =
              (body.reason as string) ?? 'Manually failed by user';
            const repo = getRepo(task.repo_id);
            if (repo) {
              try {
                await forgejo.commentOnIssue(
                  repo,
                  task.issue_id,
                  `Task manually failed: ${reason}`
                );
              } catch {
                // Best effort
              }
            }
            scheduler.triggerTick();
            break;
          }

          case 'reset': {
            if (!RESETTABLE_STATUSES.has(task.status)) {
              return reply.status(400).send({
                error: `Cannot reset task in state '${task.status}'. Valid states: ${[...RESETTABLE_STATUSES].join(', ')}`,
              });
            }
            await resetTask(task, forgejo, scheduler, log);
            break;
          }

          default:
            return reply
              .status(400)
              .send({ error: `Unknown action: ${action}` });
        }

        const updated = getTask(id)!;
        return enrichTask(updated);
      }
    );
  };
}

interface EnrichContext {
  /** Ids of all orchestrator-managed containers, for health derivation.
   *  If undefined, health computation skips the Docker cross-check and
   *  returns 'healthy' for active tasks with a non-null container_id. */
  managedIds?: Set<string>;
  /** Pre-resolved container display name. Only set for single-task lookups
   *  that warrant a targeted inspect call. */
  containerName?: string | null;
}

/**
 * Validate an agent_profile_id value for the PATCH handler.
 * null is always valid (clears the override). A string must exist in the
 * agent_profiles table. Exported so the unit tests exercise the same logic
 * as the route handler.
 */
export function validateAgentProfile(
  profileId: string | null,
  getAgentProfileFn: (id: string) => { id: string } | undefined
): { valid: true } | { valid: false; error: string } {
  if (profileId === null) return { valid: true };
  const profile = getAgentProfileFn(profileId);
  if (!profile) {
    return { valid: false, error: `Unknown agent_profile_id: ${profileId}` };
  }
  return { valid: true };
}

/**
 * Resolve the effective agent profile id and its source for a task.
 * Three-tier chain: task.agent_profile_id → repo.agent_profile_id →
 * settings.default_agent_profile_id. Exported for unit tests; the
 * authoritative launch-time resolution lives in scheduler.resolveProfile().
 */
export function resolveEffectiveAgentProfile(
  taskAgentProfile: string | null,
  repoAgentProfile: string | null,
  globalDefaultProfile: string | null
): {
  effective_agent_profile_id: string | null;
  agent_profile_source: 'task' | 'repo' | 'global' | 'none';
} {
  if (taskAgentProfile !== null) {
    return {
      effective_agent_profile_id: taskAgentProfile,
      agent_profile_source: 'task',
    };
  }
  if (repoAgentProfile !== null) {
    return {
      effective_agent_profile_id: repoAgentProfile,
      agent_profile_source: 'repo',
    };
  }
  if (globalDefaultProfile !== null) {
    return {
      effective_agent_profile_id: globalDefaultProfile,
      agent_profile_source: 'global',
    };
  }
  return { effective_agent_profile_id: null, agent_profile_source: 'none' };
}

function enrichTask(task: Task, ctx: EnrichContext = {}) {
  const repo = getRepo(task.repo_id);
  const attempts = getAttempts(task.id);

  const runningAttempt = findRunningAttempt(attempts);
  const health = ctx.managedIds
    ? computeTaskHealth(task, ctx.managedIds, runningAttempt)
    : deriveHealthWithoutDocker(task, runningAttempt);

  // Surface the effective profile id and which tier it came from so the UI
  // can render the override / inherit chain without a second round-trip.
  // Task-level override wins, then repo default, then the global default.
  const repoProfileId = repo?.agent_profile_id ?? null;
  const globalDefault = getSetting('default_agent_profile_id') ?? null;
  const { effective_agent_profile_id, agent_profile_source } =
    resolveEffectiveAgentProfile(
      task.agent_profile_id,
      repoProfileId,
      globalDefault
    );

  return {
    ...task,
    issue_title: task.issue_title ?? `Issue #${task.issue_id}`,
    repo: repo ? { id: repo.id, owner: repo.owner, name: repo.name } : null,
    blocked_by: [] as number[],
    runtime_status: task.status as TaskStatus,
    health,
    container_name: ctx.containerName ?? null,
    effective_agent_profile_id,
    agent_profile_source,
    repo_agent_profile_id: repoProfileId,
    global_agent_profile_id: globalDefault,
  };
}

/**
 * Enrich a task and overlay the Forgejo-derived status.
 *
 * The response's `status` field is the derived value (what the UI should
 * show); `runtime_status` preserves the stored orchestrator state for
 * debugging. Snapshot fetch failures fall back to the stored status — the
 * API stays responsive if Forgejo is briefly unreachable.
 */
async function enrichTaskWithDerivation(
  task: Task,
  forgejo: ForgejoClient,
  ctx: EnrichContext = {}
): Promise<ReturnType<typeof enrichTask>> {
  const base = enrichTask(task, ctx);

  let snapshot = null;
  try {
    snapshot = await getSnapshot(task, forgejo);
  } catch {
    // Best effort — derivation falls back to stored status.
  }
  const derived = deriveStatus(task, snapshot);
  return { ...base, status: derived.status };
}

function findRunningAttempt(attempts: Attempt[]): Attempt | undefined {
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].status === 'running') return attempts[i];
  }
  return undefined;
}

function deriveHealthWithoutDocker(
  task: Task,
  runningAttempt: Attempt | undefined
): 'healthy' | 'orphaned' | 'idle' {
  // Fallback used when the caller didn't pass managedIds (e.g. POST
  // handlers where fetching the Docker list is overkill). Only catches
  // the "container_id is null with a running attempt" orphan shape —
  // missing_container requires Docker state we don't have here.
  const active = new Set(['in-progress', 'in-review', 'changes-needed']);
  if (!active.has(task.status)) return 'idle';
  if (!runningAttempt) return 'healthy';
  if (task.container_id === null) return 'orphaned';
  return 'healthy';
}

async function loadManagedContainerIds(
  log: Parameters<typeof getContainerDisplayName>[1]
): Promise<Set<string> | undefined> {
  // Returns undefined on Docker failure so callers propagate the "unknown"
  // signal down to enrichTask, which will fall back to the Docker-less
  // health derivation. Returning an empty Set here would incorrectly
  // flag every containerised task as orphaned.
  try {
    const containers = await listContainers();
    return new Set(containers.map((c) => c.Id));
  } catch (err) {
    log.warn(
      { event: 'tasks_route_docker_unavailable', err },
      'Could not list containers — task health will degrade to partial'
    );
    return undefined;
  }
}
