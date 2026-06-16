import type { FastifyInstance } from 'fastify';
import {
  getDb,
  getRepo,
  getRepos,
  getTaskByIssue,
  getAgentProfile,
} from '../db.js';
import type { ForgejoClient } from '../forgejo.js';
import { registerWebhook } from '../webhooks.js';
import { validateInstallSteps } from '../install-steps.js';
import type { MergeStrategy } from '@orchestrator/shared';
import { MERGE_STRATEGIES } from '@orchestrator/shared';

/** Normalise + validate a body's agent-profile pointer field
 *  (`agent_profile_id` or `review_agent_profile_id` — pass `fieldName`
 *  so errors name the right body key). Returns
 *  - ok=true, value=null when the field is absent/null/empty string
 *    (all three mean "inherit from the next tier in the resolution
 *    chain" at task-launch time)
 *  - ok=true, value=string when the id references an existing profile
 *  - ok=false, error when the field is the wrong type or points at a
 *    non-existent profile
 *
 *  Matches the semantics of `validateTaskAgentProfile` in routes/tasks.ts
 *  so repos and tasks reject the same invalid inputs at save time
 *  rather than leaving the task to fail at launch. (F5)
 *
 *  Exported so the unit tests can exercise the validator directly
 *  without spinning a Fastify app + ForgejoClient stub (R3). */
export function validateRepoAgentProfile(
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
    return {
      ok: false,
      error: `${fieldName} '${trimmed}' does not reference an existing agent profile`,
    };
  }
  return { ok: true, value: trimmed };
}

/** Validate `merge_strategy` against the operator-selectable allowlist
 *  (R1). When absent / null / empty we coerce to the schema default of
 *  'squash' rather than rejecting — POSTs that omit the field are
 *  treated as "use default" the same way the column DEFAULT does.
 *  Anything present must be one of the three known values. */
export function validateRepoMergeStrategy(
  raw: unknown
):
  | { ok: true; value: MergeStrategy }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: 'squash' };
  }
  if (typeof raw !== 'string' || !MERGE_STRATEGIES.includes(raw as MergeStrategy)) {
    return {
      ok: false,
      error: `merge_strategy must be one of: ${MERGE_STRATEGIES.join(', ')}`,
    };
  }
  return { ok: true, value: raw as MergeStrategy };
}

/** Validate a per-repo container resource override (memory or CPU).
 *  These columns are nullable: null/absent/empty means "use the global
 *  DEFAULT_CONTAINER_* constant from constants.ts". When present, the
 *  value must be a positive integer — zero or negative would either
 *  pause the repo entirely or be rejected by Docker with a confusing
 *  error at container-create time. The label is interpolated into the
 *  error message so a 400 surfaces the offending field. (R2) */
export function validateRepoContainerResource(
  raw: unknown,
  label: string
):
  | { ok: true; value: number | null }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  // Accept stringy numbers (JSON sometimes serialises form values that way).
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      error: `${label} must be a positive integer (got ${JSON.stringify(raw)})`,
    };
  }
  return { ok: true, value: n };
}

export function createRepoRoutes(forgejo: ForgejoClient) {
  return async function repoRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/repos
    app.get('/api/repos', async () => {
      return { repos: getRepos() };
    });

    // GET /api/repos/available — list repos from Forgejo not yet registered
    app.get('/api/repos/available', async (_request, reply) => {
      try {
        const forgejoRepos = await forgejo.listUserRepos();
        const registered = getRepos();
        const registeredSet = new Set(
          registered.map((r) => `${r.owner}/${r.name}`)
        );
        const available = forgejoRepos
          .filter((r) => !registeredSet.has(r.full_name))
          .map((r) => ({
            owner: r.owner.login,
            name: r.name,
            full_name: r.full_name,
            default_branch: r.default_branch,
          }));
        return { repos: available };
      } catch (err) {
        return reply.status(500).send({
          error: `Failed to fetch Forgejo repos: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    // POST /api/repos
    app.post('/api/repos', async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      if (!body?.owner || !body?.name) {
        return reply
          .status(400)
          .send({ error: 'Required: owner, name' });
      }

      const allowScriptSteps = body.allow_script_steps === true || body.allow_script_steps === 1;
      let installSteps: ReturnType<typeof validateInstallSteps>;
      try {
        installSteps = validateInstallSteps(body.install_steps, allowScriptSteps);
      } catch (err) {
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }

      // agent_profile_id is nullable: null/absent/empty → inherit from
      // settings.default_agent_profile_id at task-launch time. When set
      // to a non-empty string we require it to reference an existing
      // profile (F5) — matches the symmetric check in routes/tasks.ts.
      const profileCheck = validateRepoAgentProfile(body.agent_profile_id);
      if (!profileCheck.ok) {
        return reply.status(400).send({ error: profileCheck.error });
      }
      const agentProfileId = profileCheck.value;

      // review_agent_profile_id: same shape; null/absent/empty → inherit
      // (global review default, then the implementation profile).
      const reviewProfileCheck = validateRepoAgentProfile(
        body.review_agent_profile_id,
        getAgentProfile,
        'review_agent_profile_id'
      );
      if (!reviewProfileCheck.ok) {
        return reply.status(400).send({ error: reviewProfileCheck.error });
      }
      const reviewAgentProfileId = reviewProfileCheck.value;

      // Strategy + per-repo container resource overrides (R1, R2). All
      // three accept null/absent for "use the default", but a present
      // value must parse as the right shape — otherwise we'd persist
      // something the runtime resolver can't honour or that Docker
      // refuses with a confusing error at container-create time.
      const strategyCheck = validateRepoMergeStrategy(body.merge_strategy);
      if (!strategyCheck.ok) {
        return reply.status(400).send({ error: strategyCheck.error });
      }
      const memoryCheck = validateRepoContainerResource(
        body.container_memory_mb,
        'container_memory_mb'
      );
      if (!memoryCheck.ok) {
        return reply.status(400).send({ error: memoryCheck.error });
      }
      const cpuCheck = validateRepoContainerResource(
        body.container_cpu_cores,
        'container_cpu_cores'
      );
      if (!cpuCheck.ok) {
        return reply.status(400).send({ error: cpuCheck.error });
      }

      const result = getDb()
        .prepare(
          `INSERT INTO repos (owner, name, base_branch, agent_profile_id, review_agent_profile_id, install_steps, allow_script_steps, container_memory_mb, container_cpu_cores, merge_strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          body.owner,
          body.name,
          body.base_branch ?? 'main',
          agentProfileId,
          reviewAgentProfileId,
          JSON.stringify(installSteps),
          allowScriptSteps ? 1 : 0,
          memoryCheck.value,
          cpuCheck.value,
          strategyCheck.value
        );

      const repo = getRepo(result.lastInsertRowid as number);

      // Auto-register webhook for the new repo
      if (repo) {
        registerWebhook(repo, forgejo, app.log).catch(() => {
          // Best effort — logged inside registerWebhook
        });
      }

      return reply.status(201).send(repo);
    });

    // PATCH /api/repos/:id
    app.patch<{ Params: { id: string } }>(
      '/api/repos/:id',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const repo = getRepo(id);
        if (!repo) {
          return reply.status(404).send({ error: 'Repo not found' });
        }

        const body = request.body as Record<string, unknown>;

        // Validate the structured fields up-front so a single dangling /
        // malformed value short-circuits the whole UPDATE with a clear
        // 400 — rather than half-applying the change before tripping
        // somewhere downstream.
        let agentProfileUpdate: string | null | undefined = undefined;
        if ('agent_profile_id' in body) {
          const profileCheck = validateRepoAgentProfile(body.agent_profile_id);
          if (!profileCheck.ok) {
            return reply.status(400).send({ error: profileCheck.error });
          }
          agentProfileUpdate = profileCheck.value;
        }
        let reviewProfileUpdate: string | null | undefined = undefined;
        if ('review_agent_profile_id' in body) {
          const reviewProfileCheck = validateRepoAgentProfile(
            body.review_agent_profile_id,
            getAgentProfile,
            'review_agent_profile_id'
          );
          if (!reviewProfileCheck.ok) {
            return reply.status(400).send({ error: reviewProfileCheck.error });
          }
          reviewProfileUpdate = reviewProfileCheck.value;
        }
        let strategyUpdate: string | undefined = undefined;
        if ('merge_strategy' in body) {
          // PATCH null/empty for merge_strategy is rejected: the column
          // is NOT NULL with a 'squash' default. Operator who wants the
          // default behaviour shouldn't touch the field at all.
          if (body.merge_strategy === null || body.merge_strategy === '') {
            return reply.status(400).send({
              error: `merge_strategy cannot be null. Omit the field to leave it unchanged.`,
            });
          }
          const strategyCheck = validateRepoMergeStrategy(body.merge_strategy);
          if (!strategyCheck.ok) {
            return reply.status(400).send({ error: strategyCheck.error });
          }
          strategyUpdate = strategyCheck.value;
        }
        let memoryUpdate: number | null | undefined = undefined;
        if ('container_memory_mb' in body) {
          const memoryCheck = validateRepoContainerResource(
            body.container_memory_mb,
            'container_memory_mb'
          );
          if (!memoryCheck.ok) {
            return reply.status(400).send({ error: memoryCheck.error });
          }
          memoryUpdate = memoryCheck.value;
        }
        let cpuUpdate: number | null | undefined = undefined;
        if ('container_cpu_cores' in body) {
          const cpuCheck = validateRepoContainerResource(
            body.container_cpu_cores,
            'container_cpu_cores'
          );
          if (!cpuCheck.ok) {
            return reply.status(400).send({ error: cpuCheck.error });
          }
          cpuUpdate = cpuCheck.value;
        }

        const sets: string[] = [];
        const params: unknown[] = [];

        if (agentProfileUpdate !== undefined) {
          sets.push('agent_profile_id = ?');
          params.push(agentProfileUpdate);
        }
        if (reviewProfileUpdate !== undefined) {
          sets.push('review_agent_profile_id = ?');
          params.push(reviewProfileUpdate);
        }
        if (strategyUpdate !== undefined) {
          sets.push('merge_strategy = ?');
          params.push(strategyUpdate);
        }
        if (memoryUpdate !== undefined) {
          sets.push('container_memory_mb = ?');
          params.push(memoryUpdate);
        }
        if (cpuUpdate !== undefined) {
          sets.push('container_cpu_cores = ?');
          params.push(cpuUpdate);
        }
        // Remaining unstructured field. base_branch keeps the generic
        // empty-string-to-null coercion: the column is nullable and a
        // blank value means "no preference, use Forgejo's default
        // branch".
        if ('base_branch' in body) {
          sets.push('base_branch = ?');
          const v = body.base_branch;
          params.push(v === '' || v === undefined ? null : v ?? null);
        }

        // install_steps + allow_script_steps validate together because the
        // script-step opt-in gates the kind: 'script' validation. If only
        // one is in the patch body, fall back to the existing repo's value
        // for the other so the validator sees a consistent view.
        if ('install_steps' in body || 'allow_script_steps' in body) {
          const allow =
            'allow_script_steps' in body
              ? body.allow_script_steps === true || body.allow_script_steps === 1
              : repo.allow_script_steps;
          const stepsRaw = 'install_steps' in body ? body.install_steps : repo.install_steps;
          let installSteps: ReturnType<typeof validateInstallSteps>;
          try {
            installSteps = validateInstallSteps(stepsRaw, allow);
          } catch (err) {
            return reply
              .status(400)
              .send({ error: err instanceof Error ? err.message : String(err) });
          }
          sets.push('install_steps = ?');
          params.push(JSON.stringify(installSteps));
          sets.push('allow_script_steps = ?');
          params.push(allow ? 1 : 0);
        }

        if (sets.length === 0) {
          return reply.status(400).send({ error: 'No valid fields to update' });
        }

        params.push(id);
        getDb()
          .prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?`)
          .run(...params);

        return getRepo(id);
      }
    );

    // GET /api/repos/:id/issues — open Forgejo issues available for queuing.
    // With ?all=true, returns EVERY open issue (tracked or status-labelled
    // ones included) — used by the dependency picker, where depending on
    // an issue that is already a task is the typical case.
    app.get<{ Params: { id: string }; Querystring: { all?: string } }>(
      '/api/repos/:id/issues',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const repo = getRepo(id);
        if (!repo) {
          return reply.status(404).send({ error: 'Repo not found' });
        }
        const includeAll = request.query.all === 'true';

        try {
          // Fetch open issues from Forgejo
          const forgejoIssues = await forgejo.listIssues(repo, { state: 'open' });

          // Filter out issues that already have a status/* label
          // and issues already tracked as tasks
          const available = forgejoIssues
            .filter((issue) => {
              if (includeAll) return true;
              const hasStatusLabel = issue.labels.some((l) =>
                l.name.startsWith('status/')
              );
              if (hasStatusLabel) return false;

              const tracked = getTaskByIssue(repo.id, issue.number);
              if (tracked) return false;

              return true;
            })
            .map((issue) => ({
              id: issue.number,
              title: issue.title,
              created_at: issue.created_at,
            }));

          return { issues: available };
        } catch (err) {
          return reply.status(500).send({
            error: `Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    );
  };
}
