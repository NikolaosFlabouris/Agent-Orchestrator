import type { FastifyInstance } from 'fastify';
import { getDb, getRepo, getRepos, getTaskByIssue } from '../db.js';
import type { ForgejoClient } from '../forgejo.js';
import { registerWebhook } from '../webhooks.js';

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
      if (!body?.owner || !body?.name || !body?.image_type || !body?.agent_tool) {
        return reply
          .status(400)
          .send({ error: 'Required: owner, name, image_type, agent_tool' });
      }

      const result = getDb()
        .prepare(
          `INSERT INTO repos (owner, name, base_branch, image_type, agent_tool, pre_agent_script, model, max_turns, timeout_minutes, container_memory_mb, container_cpu_cores)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          body.owner,
          body.name,
          body.base_branch ?? 'main',
          body.image_type,
          body.agent_tool,
          body.pre_agent_script ?? null,
          body.model ?? null,
          body.max_turns ?? null,
          body.timeout_minutes ?? null,
          body.container_memory_mb ?? null,
          body.container_cpu_cores ?? null
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
          'base_branch', 'image_type', 'agent_tool', 'pre_agent_script',
          'model', 'max_turns', 'timeout_minutes', 'container_memory_mb',
          'container_cpu_cores',
        ];
        const sets: string[] = [];
        const params: unknown[] = [];

        for (const key of updatable) {
          if (key in body) {
            sets.push(`${key} = ?`);
            params.push(body[key] ?? null);
          }
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

    // POST /api/repos/:id/rebuild — trigger dev image rebuild
    app.post<{ Params: { id: string } }>(
      '/api/repos/:id/rebuild',
      async (request, reply) => {
        const id = parseInt(request.params.id, 10);
        const repo = getRepo(id);
        if (!repo) {
          return reply.status(404).send({ error: 'Repo not found' });
        }

        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const imageType = repo.image_type; // node, python, go
        const projectRoot = process.env.PROJECT_ROOT ?? '/app';

        app.log.info(
          { event: 'image_rebuild_started', repo_id: id, image_type: imageType },
          'Image rebuild started'
        );

        try {
          // Build base image first (all runtime images depend on it)
          await execFileAsync('docker', [
            'build',
            '-t', 'orchestrator-agent-base:latest',
            '-f', `${projectRoot}/images/base/Dockerfile`,
            projectRoot,
          ], { timeout: 600_000 }); // 10 minute timeout

          // Build the runtime image for this repo's image type
          await execFileAsync('docker', [
            'build',
            '-t', `orchestrator-agent-${imageType}:latest`,
            '-f', `${projectRoot}/images/${imageType}/Dockerfile`,
            projectRoot,
          ], { timeout: 600_000 });

          // Record completion
          getDb()
            .prepare('UPDATE repos SET last_image_build = ? WHERE id = ?')
            .run(new Date().toISOString(), id);

          app.log.info(
            { event: 'image_rebuild_complete', repo_id: id, image_type: imageType },
            'Image rebuild completed'
          );

          return {
            status: 'rebuild_complete',
            repo_id: id,
            image: `orchestrator-agent-${imageType}:latest`,
          };
        } catch (err) {
          app.log.error(
            { event: 'image_rebuild_failed', repo_id: id, err },
            'Image rebuild failed'
          );
          return reply.status(500).send({
            error: `Image rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    );
  };
}
