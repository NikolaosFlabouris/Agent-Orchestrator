/**
 * Task-detail assembly — the single producer of the "one task, fully
 * expanded" object.
 *
 * `GET /api/tasks/:id` used to build this inline. It now has two consumers
 * (the REST route and the MCP `get_task` tool), so the assembly lives here
 * and both go through it: an agent asking the orchestrator over MCP sees
 * byte-identical data to what the dashboard sees, and a new field added for
 * one surface can never be missing from the other.
 *
 * What "fully expanded" means, in the order the pieces are resolved:
 *   - the enriched `TaskView` (repo tuple, dependency projection, health,
 *     the resolved per-stage profile chains) with the Forgejo-derived
 *     status overlaid — see `task-view.ts`,
 *   - the container display name (one targeted Docker inspect; single-task
 *     lookups are the only place that's worth it),
 *   - the full attempt history,
 *   - the task's event log,
 *   - deep links into Forgejo for the issue and (when opened) the PR.
 */

import type { Attempt, Task, TaskEvent, TaskView } from '@orchestrator/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getAttempts, getRepo, getTaskEvents } from '../db.js';
import type { ForgejoClient } from '../forgejo.js';
import { loadManagedContainerIds } from '../container-list.js';
import { getContainerDisplayName } from '../orphan-recovery.js';
import { enrichTaskWithDerivation } from '../task-view.js';

const FORGEJO_URL = process.env.FORGEJO_URL ?? 'http://forgejo:3000';

/** The wire shape of `GET /api/tasks/:id`: the enriched task with its
 *  attempt history, event log, and Forgejo deep links. */
export interface TaskDetail extends TaskView {
  attempts: Attempt[];
  events: TaskEvent[];
  /** `issue` always; `pr` only once a pull request has been opened. */
  forgejo_links: Record<string, string>;
}

export interface TaskDetailDeps {
  forgejo: ForgejoClient;
  log: FastifyBaseLogger;
}

/**
 * Assemble the full detail view for one task. Best-effort on the external
 * lookups: a Docker or Forgejo hiccup degrades health / status derivation
 * (see `enrichTaskWithDerivation`) rather than failing the read.
 */
export async function buildTaskDetail(
  task: Task,
  deps: TaskDetailDeps
): Promise<TaskDetail> {
  const { forgejo, log } = deps;

  const managedIds = await loadManagedContainerIds(log);
  const containerName = await getContainerDisplayName(task.container_id, log);
  const enriched = await enrichTaskWithDerivation(task, forgejo, {
    managedIds,
    containerName,
  });

  const attempts = getAttempts(task.id);
  const events = getTaskEvents(task.id);

  const repo = getRepo(task.repo_id);
  const forgejoLinks: Record<string, string> = {};
  if (repo) {
    forgejoLinks.issue = `${FORGEJO_URL}/${repo.owner}/${repo.name}/issues/${task.issue_id}`;
    if (task.pr_number) {
      forgejoLinks.pr = `${FORGEJO_URL}/${repo.owner}/${repo.name}/pulls/${task.pr_number}`;
    }
  }

  return { ...enriched, attempts, events, forgejo_links: forgejoLinks };
}
