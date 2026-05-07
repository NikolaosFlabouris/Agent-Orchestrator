import type { FastifyInstance } from 'fastify';
import {
  getTask,
  getTasks,
  getRepo,
  getRepos,
  getAttempts,
  getTaskEvents,
  insertTask,
  updateTask,
  getAgentTool,
} from '../db.js';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import type { Task, TaskStatus, Attempt } from '@orchestrator/shared';
import type { ForgejoClient } from '../forgejo.js';
import type { Scheduler } from '../scheduler.js';
import { cancelTask, resetTask, requeueTask, extendTask } from '../actions.js';
import { updateTaskWithSync, notifyTaskCreated, recordTaskEvent } from '../state-sync.js';
import { attemptMerge } from '../agents/review.js';
import { getOutputDir } from '../workspace.js';
import { getSnapshot, warmRepoSnapshots } from '../forgejo-snapshot.js';
import { deriveStatus } from '../status-derivation.js';
import {
  computeTaskHealth,
  getContainerDisplayName,
} from '../orphan-recovery.js';
import { listContainers } from '../docker.js';

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

    // POST /api/tasks — create new issue and queue
    app.post('/api/tasks', async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      if (!body?.repo_id || !body?.title || !body?.description) {
        return reply
          .status(400)
          .send({ error: 'Required: repo_id, title, description' });
      }

      const repoId = body.repo_id as number;
      const repo = getRepo(repoId);
      if (!repo) return reply.status(404).send({ error: 'Repo not found' });

      // Create the Forgejo issue
      let issue;
      try {
        issue = await forgejo.createIssue(repo, {
          title: body.title as string,
          body: body.description as string,
        });
      } catch (err) {
        return reply.status(500).send({
          error: `Failed to create Forgejo issue: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Apply labels
      try {
        const labelNames = ['status/queued'];
        if (body.human_merge) labelNames.push('human-merge');
        if (body.human_review) labelNames.push('human-review');
        await forgejo.replaceLabelByNames(repo, issue.number, labelNames);
      } catch {
        // Best effort
      }

      // Insert task in DB
      const task = insertTask({
        issue_id: issue.number,
        issue_title: issue.title,
        repo_id: repoId,
        status: 'queued',
        max_attempts: (body.max_attempts as number) ?? undefined,
        agent_tool: (body.agent_tool as string) ?? null,
        model: (body.model as string) ?? null,
      });

      notifyTaskCreated(task);
      scheduler.triggerTick();
      return reply.status(201).send(enrichTask(task));
    });

    // POST /api/tasks/queue — queue existing issue
    app.post('/api/tasks/queue', async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      if (!body?.issue_id || !body?.repo_id) {
        return reply
          .status(400)
          .send({ error: 'Required: issue_id, repo_id' });
      }

      const repoId = body.repo_id as number;
      const repo = getRepo(repoId);
      if (!repo) return reply.status(404).send({ error: 'Repo not found' });

      const issueId = body.issue_id as number;

      // Fetch the issue title from Forgejo
      let issueTitle: string | null = null;
      try {
        const issue = await forgejo.getIssue(repo, issueId);
        issueTitle = issue.title;
      } catch {
        // Best effort — will fall back to "Issue #N" in enrichTask
      }

      // Apply labels
      try {
        const labelNames = ['status/queued'];
        if (body.human_merge) labelNames.push('human-merge');
        if (body.human_review) labelNames.push('human-review');
        await forgejo.replaceLabelByNames(repo, issueId, labelNames);
      } catch {
        // Best effort
      }

      const task = insertTask({
        issue_id: issueId,
        issue_title: issueTitle,
        repo_id: repoId,
        status: 'queued',
        max_attempts: (body.max_attempts as number) ?? undefined,
        agent_tool: (body.agent_tool as string) ?? null,
        model: (body.model as string) ?? null,
      });

      notifyTaskCreated(task);
      scheduler.triggerTick();
      return reply.status(201).send(enrichTask(task));
    });

    // PATCH /api/tasks/:id — task actions
    app.patch<{ Params: { id: string } }>(
      '/api/tasks/:id',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const task = getTask(id);
        if (!task) return reply.status(404).send({ error: 'Task not found' });

        const body = request.body as Record<string, unknown>;

        // Direct field update: agent_tool (no action required).
        // null clears the override and reverts to the repo default.
        if ('agent_tool' in body) {
          const rawTool = body.agent_tool;
          if (rawTool !== null && typeof rawTool !== 'string') {
            return reply.status(400).send({ error: 'agent_tool must be a string or null' });
          }
          const newTool = rawTool as string | null;

          const validation = validateAgentTool(newTool, getAgentTool);
          if (!validation.valid) {
            return reply.status(400).send({ error: validation.error });
          }

           const oldTool = task.agent_tool;
           updateTaskWithSync(task.id, { agent_tool: newTool });
 
           const fromLabel = oldTool ?? '(repo default)';
           const toLabel = newTool ?? '(repo default)';
           recordTaskEvent(
             task.id,
             'agent_tool_changed',
             `Agent tool changed from ${fromLabel} to ${toLabel}`
           );
 
           const repo = getRepo(task.repo_id);
           if (repo) {
             try {
               await forgejo.commentOnIssue(
                 repo,
                 task.issue_id,
                 `Agent tool changed to \`${newTool ?? 'repo default'}\` — takes effect on next attempt.`
               );
             } catch {
               // Best effort
             }
           }
 
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
 * Validate an agent_tool value for the PATCH handler.
 * null is always valid (clears the override). A string must exist in the
 * agent_tools table. Exported so the unit tests exercise the same logic as
 * the route handler.
 */
export function validateAgentTool(
  toolId: string | null,
  getAgentToolFn: (id: string) => { id: string } | undefined
): { valid: true } | { valid: false; error: string } {
  if (toolId === null) return { valid: true };
  const tool = getAgentToolFn(toolId);
  if (!tool) return { valid: false, error: `Unknown agent_tool: ${toolId}` };
  return { valid: true };
}

/**
 * Resolve the effective agent tool id and its source.
 * task.agent_tool (per-task override) takes precedence over repo.agent_tool
 * (repository default). Exported for unit tests — the authoritative
 * launch-time resolution lives in scheduler.resolveTool().
 */
export function resolveEffectiveAgentTool(
  taskAgentTool: string | null,
  repoAgentTool: string | null
): { effective_agent_tool_id: string | null; agent_tool_source: 'task' | 'repo' } {
  if (taskAgentTool !== null) {
    return { effective_agent_tool_id: taskAgentTool, agent_tool_source: 'task' };
  }
  return { effective_agent_tool_id: repoAgentTool, agent_tool_source: 'repo' };
}

function enrichTask(task: Task, ctx: EnrichContext = {}) {
  const repo = getRepo(task.repo_id);
  const attempts = getAttempts(task.id);
  const totalCost = attempts.reduce((sum, a) => sum + (a.cost_usd ?? 0), 0);

  const runningAttempt = findRunningAttempt(attempts);
  const health = ctx.managedIds
    ? computeTaskHealth(task, ctx.managedIds, runningAttempt)
    : deriveHealthWithoutDocker(task, runningAttempt);

  // Preferred enrichment: surface effective tool and its source so the UI can
  // display and distinguish task-level overrides from repo defaults without a
  // second round-trip. task.agent_tool wins; falls back to repo.agent_tool.
  // repo_agent_tool is always included separately so the UI can show the repo
  // default name in the "Use repo default" select option even when an override
  // is active (agent_tool_source === 'task').
  const repoAgentTool = repo?.agent_tool ?? null;
  const { effective_agent_tool_id, agent_tool_source } = resolveEffectiveAgentTool(
    task.agent_tool,
    repoAgentTool
  );

  return {
    ...task,
    issue_title: task.issue_title ?? `Issue #${task.issue_id}`,
    repo: repo ? { id: repo.id, owner: repo.owner, name: repo.name } : null,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    blocked_by: [] as number[],
    runtime_status: task.status as TaskStatus,
    health,
    container_name: ctx.containerName ?? null,
    effective_agent_tool_id,
    agent_tool_source,
    repo_agent_tool: repoAgentTool,
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
