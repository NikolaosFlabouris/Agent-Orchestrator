import type { FastifyInstance } from 'fastify';
import {
  getProvider,
  getProviders,
  insertProvider,
  updateProvider,
  deleteProvider,
  countToolsUsingProvider,
  getTasks,
  getRepo,
  getAgentTool,
} from '../db.js';
import { resolveProviderKey } from '../scheduler-pools.js';
import type { Provider } from '@orchestrator/shared';

interface ProviderWithStats extends Provider {
  /** How many tools have this provider_id set. */
  tools_using: number;
  /** How many tasks are currently holding a slot against this provider. */
  active_slots: number;
}

function enrich(provider: Provider): ProviderWithStats {
  const active = [
    ...getTasks({ status: 'preparing' }),
    ...getTasks({ status: 'in-progress' }),
    ...getTasks({ status: 'in-review' }),
  ].filter((t) => t.container_id !== null);

  let activeSlots = 0;
  for (const task of active) {
    const repo = getRepo(task.repo_id);
    const toolId = task.agent_tool ?? repo?.agent_tool;
    const tool = toolId ? getAgentTool(toolId) : undefined;
    const key = resolveProviderKey(task, tool, repo);
    if (key === provider.id) activeSlots++;
  }

  return {
    ...provider,
    tools_using: countToolsUsingProvider(provider.id),
    active_slots: activeSlots,
  };
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/providers', async () => {
    return { providers: getProviders().map(enrich) };
  });

  app.post('/api/providers', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    const displayName = String(body.display_name ?? '').trim();
    const limit = Number(body.concurrency_limit ?? 1);
    const notes =
      body.notes === undefined || body.notes === null
        ? null
        : String(body.notes);

    if (!id || !displayName) {
      return reply
        .status(400)
        .send({ error: 'id and display_name are required' });
    }
    if (!Number.isInteger(limit) || limit < 0) {
      return reply
        .status(400)
        .send({ error: 'concurrency_limit must be a non-negative integer' });
    }
    if (getProvider(id)) {
      return reply
        .status(409)
        .send({ error: `Provider '${id}' already exists` });
    }

    insertProvider({
      id,
      display_name: displayName,
      concurrency_limit: limit,
      notes,
    });
    return reply.status(201).send(enrich(getProvider(id)!));
  });

  app.patch<{ Params: { id: string } }>(
    '/api/providers/:id',
    async (request, reply) => {
      const provider = getProvider(request.params.id);
      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }
      const body = request.body as Record<string, unknown>;
      const updates: Partial<Omit<Provider, 'id'>> = {};

      if ('display_name' in body) {
        const v = String(body.display_name ?? '').trim();
        if (!v) {
          return reply
            .status(400)
            .send({ error: 'display_name must be non-empty' });
        }
        updates.display_name = v;
      }
      if ('concurrency_limit' in body) {
        const v = Number(body.concurrency_limit);
        if (!Number.isInteger(v) || v < 0) {
          return reply.status(400).send({
            error: 'concurrency_limit must be a non-negative integer',
          });
        }
        updates.concurrency_limit = v;
      }
      if ('notes' in body) {
        updates.notes = body.notes === null ? null : String(body.notes ?? '');
      }

      updateProvider(request.params.id, updates);
      return enrich(getProvider(request.params.id)!);
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/providers/:id',
    async (request, reply) => {
      const provider = getProvider(request.params.id);
      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }
      // ON DELETE SET NULL would auto-clear tool.provider_id, but refusing up
      // front gives the operator a clearer signal that they're about to
      // un-pool their tools.
      const usingCount = countToolsUsingProvider(request.params.id);
      if (usingCount > 0) {
        return reply.status(409).send({
          error: `Provider is in use by ${usingCount} tool(s). Reassign those tools first.`,
        });
      }
      deleteProvider(request.params.id);
      return reply.status(204).send();
    }
  );
}
