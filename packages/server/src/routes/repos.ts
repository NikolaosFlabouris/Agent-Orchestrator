import type { FastifyInstance } from 'fastify';
import { getDb, getRepo, getRepos, getTaskByIssue } from '../db.js';
import type { ForgejoClient } from '../forgejo.js';
import { registerWebhook } from '../webhooks.js';
import { validateInstallSteps } from '../install-steps.js';

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
      if (!body?.owner || !body?.name || !body?.agent_tool) {
        return reply
          .status(400)
          .send({ error: 'Required: owner, name, agent_tool' });
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

      const result = getDb()
        .prepare(
          `INSERT INTO repos (owner, name, base_branch, agent_tool, install_steps, allow_script_steps, container_memory_mb, container_cpu_cores, merge_strategy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          body.owner,
          body.name,
          body.base_branch ?? 'main',
          body.agent_tool,
          JSON.stringify(installSteps),
          allowScriptSteps ? 1 : 0,
          body.container_memory_mb ?? null,
          body.container_cpu_cores ?? null,
          body.merge_strategy ?? 'squash'
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
        const updatable = [
          'base_branch', 'agent_tool',
          'container_memory_mb', 'container_cpu_cores',
          'merge_strategy',
        ];
        const sets: string[] = [];
        const params: unknown[] = [];

        for (const key of updatable) {
          if (key in body) {
            sets.push(`${key} = ?`);
            params.push(body[key] ?? null);
          }
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

    // GET /api/repos/:id/issues — open Forgejo issues available for queuing
    app.get<{ Params: { id: string } }>(
      '/api/repos/:id/issues',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const repo = getRepo(id);
        if (!repo) {
          return reply.status(404).send({ error: 'Repo not found' });
        }

        try {
          // Fetch open issues from Forgejo
          const forgejoIssues = await forgejo.listIssues(repo, { state: 'open' });

          // Filter out issues that already have a status/* label
          // and issues already tracked as tasks
          const available = forgejoIssues
            .filter((issue) => {
              const hasStatusLabel = issue.labels.some((l) =>
                l.name.startsWith('status/')
              );
              if (hasStatusLabel) return false;

              const tracked = getTaskByIssue(issue.number);
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
