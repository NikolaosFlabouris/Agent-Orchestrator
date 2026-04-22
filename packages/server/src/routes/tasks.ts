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
} from '../db.js';
import { TERMINAL_STATUSES } from '@orchestrator/shared';
import type { Task, TaskStatus } from '@orchestrator/shared';
import type { ForgejoClient } from '../forgejo.js';
import type { Scheduler } from '../scheduler.js';
import { cancelTask, resetTask } from '../actions.js';
import { updateTaskWithSync, notifyTaskCreated } from '../state-sync.js';
import { attemptMerge } from '../agents/review.js';
import { getOutputDir } from '../workspace.js';
import { getSnapshot } from '../forgejo-snapshot.js';
import { deriveStatus } from '../status-derivation.js';

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

      const enriched = await Promise.all(
        allTasks.map((t) => enrichTaskWithDerivation(t, forgejo))
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

        const enriched = await enrichTaskWithDerivation(task, forgejo);
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

function enrichTask(task: Task) {
  const repo = getRepo(task.repo_id);
  const attempts = getAttempts(task.id);
  const totalCost = attempts.reduce((sum, a) => sum + (a.cost_usd ?? 0), 0);

  return {
    ...task,
    issue_title: `Issue #${task.issue_id}`,
    repo: repo ? { id: repo.id, owner: repo.owner, name: repo.name } : null,
    total_cost_usd: Math.round(totalCost * 100) / 100,
    blocked_by: [] as number[],
    runtime_status: task.status as TaskStatus,
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
  forgejo: ForgejoClient
): Promise<ReturnType<typeof enrichTask>> {
  const base = enrichTask(task);

  let snapshot = null;
  try {
    snapshot = await getSnapshot(task, forgejo);
  } catch {
    // Best effort — derivation falls back to stored status.
  }
  const derived = deriveStatus(task, snapshot);
  return { ...base, status: derived.status };
}
