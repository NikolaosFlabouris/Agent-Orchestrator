import type { FastifyInstance } from 'fastify';
import {
  getProvider,
  getProviders,
  insertProvider,
  updateProvider,
  deleteProvider,
  countModelsUsingProvider,
  getTasks,
  getRepo,
  getAgentProfile,
  getModel,
  getModelsByProvider,
  getModelByProviderAndId,
  insertModel,
  updateModel,
  deleteModel,
  countProfilesUsingModel,
  getSetting,
} from '../db.js';
import { resolveProviderKey } from '../scheduler-pools.js';
import type { Provider, ProviderKind, Model } from '@orchestrator/shared';
import { PROVIDER_KINDS } from '@orchestrator/shared';
import { listProviderKinds } from '../providers/kinds.js';

interface ProviderWithStats extends Provider {
  /** How many models point at this provider. */
  models_count: number;
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
    const profileId =
      task.agent_profile_id ??
      repo?.agent_profile_id ??
      getSetting('default_agent_profile_id');
    const profile = profileId ? getAgentProfile(profileId) : undefined;
    const model = profile ? getModel(profile.model_pk) : undefined;
    const key = resolveProviderKey(task, model?.provider_id);
    if (key === provider.id) activeSlots++;
  }

  return {
    ...provider,
    models_count: countModelsUsingProvider(provider.id),
    active_slots: activeSlots,
  };
}

function validateProviderShape(
  body: Record<string, unknown>
): { error: string } | { value: Omit<Provider, 'id'> } {
  const displayName = String(body.display_name ?? '').trim();
  const kindRaw = String(body.kind ?? '').trim();
  const limit = Number(body.concurrency_limit ?? 1);
  if (!displayName) return { error: 'display_name is required' };
  if (!PROVIDER_KINDS.includes(kindRaw as ProviderKind)) {
    return {
      error: `kind must be one of: ${PROVIDER_KINDS.join(', ')}`,
    };
  }
  if (!Number.isInteger(limit) || limit < 0) {
    return { error: 'concurrency_limit must be a non-negative integer' };
  }

  const baseUrl =
    body.base_url === undefined || body.base_url === null || body.base_url === ''
      ? null
      : String(body.base_url).trim();
  const authToken =
    body.auth_token === undefined || body.auth_token === null || body.auth_token === ''
      ? null
      : String(body.auth_token);
  const apiKeyEnvVar =
    body.api_key_env_var === undefined ||
    body.api_key_env_var === null ||
    body.api_key_env_var === ''
      ? null
      : String(body.api_key_env_var).trim();
  const notes =
    body.notes === undefined || body.notes === null ? null : String(body.notes);

  // Ollama (the only self-hosted kind today) requires base_url.
  if (kindRaw === 'ollama' && !baseUrl) {
    return { error: 'base_url is required for ollama providers' };
  }

  return {
    value: {
      display_name: displayName,
      kind: kindRaw as ProviderKind,
      concurrency_limit: limit,
      base_url: baseUrl,
      auth_token: authToken,
      api_key_env_var: apiKeyEnvVar,
      notes,
    },
  };
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/provider-kinds — metadata for the per-kind UI form.
  app.get('/api/provider-kinds', async () => {
    return { kinds: listProviderKinds() };
  });

  // GET /api/providers
  app.get('/api/providers', async () => {
    return { providers: getProviders().map(enrich) };
  });

  // POST /api/providers
  app.post('/api/providers', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    if (!id) return reply.status(400).send({ error: 'id is required' });
    if (getProvider(id)) {
      return reply
        .status(409)
        .send({ error: `Provider '${id}' already exists` });
    }
    const v = validateProviderShape(body);
    if ('error' in v) return reply.status(400).send({ error: v.error });

    insertProvider({ id, ...v.value });
    return reply.status(201).send(enrich(getProvider(id)!));
  });

  // PATCH /api/providers/:id
  app.patch<{ Params: { id: string } }>(
    '/api/providers/:id',
    async (request, reply) => {
      const existing = getProvider(request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'Provider not found' });
      }
      const body = request.body as Record<string, unknown>;
      // Merge incoming fields with existing values so the validator sees
      // a complete provider shape (lets the operator PATCH a single
      // field without re-supplying all the others).
      const merged: Record<string, unknown> = {
        display_name: existing.display_name,
        kind: existing.kind,
        concurrency_limit: existing.concurrency_limit,
        base_url: existing.base_url,
        auth_token: existing.auth_token,
        api_key_env_var: existing.api_key_env_var,
        notes: existing.notes,
        ...body,
      };
      const v = validateProviderShape(merged);
      if ('error' in v) return reply.status(400).send({ error: v.error });

      updateProvider(request.params.id, v.value);
      return enrich(getProvider(request.params.id)!);
    }
  );

  // DELETE /api/providers/:id
  app.delete<{ Params: { id: string } }>(
    '/api/providers/:id',
    async (request, reply) => {
      const provider = getProvider(request.params.id);
      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }
      const usingCount = countModelsUsingProvider(request.params.id);
      if (usingCount > 0) {
        return reply.status(409).send({
          error: `Provider is referenced by ${usingCount} model(s). Delete or reassign those models first.`,
        });
      }
      deleteProvider(request.params.id);
      return reply.status(204).send();
    }
  );

  // GET /api/providers/:id/models — nested model list per provider.
  app.get<{ Params: { id: string } }>(
    '/api/providers/:id/models',
    async (request, reply) => {
      const provider = getProvider(request.params.id);
      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }
      return { models: getModelsByProvider(request.params.id) };
    }
  );

  // POST /api/providers/:id/models
  app.post<{ Params: { id: string } }>(
    '/api/providers/:id/models',
    async (request, reply) => {
      const provider = getProvider(request.params.id);
      if (!provider) {
        return reply.status(404).send({ error: 'Provider not found' });
      }
      const body = request.body as Record<string, unknown>;
      const modelId = String(body.model_id ?? '').trim();
      const displayName = String(body.display_name ?? '').trim();
      if (!modelId || !displayName) {
        return reply
          .status(400)
          .send({ error: 'model_id and display_name are required' });
      }
      if (getModelByProviderAndId(provider.id, modelId)) {
        return reply.status(409).send({
          error: `Model '${modelId}' already exists for provider '${provider.id}'`,
        });
      }
      const inserted = insertModel({
        provider_id: provider.id,
        model_id: modelId,
        display_name: displayName,
      });
      return reply.status(201).send(inserted);
    }
  );

  // PATCH /api/models/:pk — update by surrogate PK.
  app.patch<{ Params: { pk: string } }>(
    '/api/models/:pk',
    async (request, reply) => {
      const pk = parseInt(request.params.pk, 10);
      if (!Number.isFinite(pk)) {
        return reply.status(400).send({ error: 'invalid model id' });
      }
      const existing = getModel(pk);
      if (!existing) return reply.status(404).send({ error: 'Model not found' });
      const body = request.body as Record<string, unknown>;
      const updates: Partial<Pick<Model, 'display_name'>> = {};
      if ('display_name' in body) {
        const v = String(body.display_name ?? '').trim();
        if (!v) {
          return reply
            .status(400)
            .send({ error: 'display_name must be non-empty' });
        }
        updates.display_name = v;
      }
      updateModel(pk, updates);
      return getModel(pk);
    }
  );

  // DELETE /api/models/:pk
  app.delete<{ Params: { pk: string } }>(
    '/api/models/:pk',
    async (request, reply) => {
      const pk = parseInt(request.params.pk, 10);
      if (!Number.isFinite(pk)) {
        return reply.status(400).send({ error: 'invalid model id' });
      }
      const existing = getModel(pk);
      if (!existing) return reply.status(404).send({ error: 'Model not found' });
      const usingCount = countProfilesUsingModel(pk);
      if (usingCount > 0) {
        return reply.status(409).send({
          error: `Model is used by ${usingCount} agent profile(s). Reassign those profiles first.`,
        });
      }
      deleteModel(pk);
      return reply.status(204).send();
    }
  );
}
