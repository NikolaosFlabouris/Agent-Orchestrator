import type { FastifyInstance } from 'fastify';
import {
  getAgentProfile,
  getAgentProfiles,
  insertAgentProfile,
  updateAgentProfile,
  deleteAgentProfile,
  countReposUsingProfile,
  countTasksUsingProfile,
  getModel,
  getProvider,
  getSetting,
} from '../db.js';
import { listHarnesses, getHarness } from '../harnesses/index.js';
import type { AgentProfile, HarnessId } from '@orchestrator/shared';
import { HARNESS_IDS } from '@orchestrator/shared';

interface AgentProfileWithStats extends AgentProfile {
  /** How many repos point at this profile as their default. */
  repos_using: number;
  /** How many tasks have this profile as a per-task override. */
  tasks_using: number;
  /** Convenience: surface the model + provider ids so the UI doesn't
   *  need a second round trip per profile. */
  provider_id: string | null;
  model_id: string | null;
}

function enrich(profile: AgentProfile): AgentProfileWithStats {
  const model = getModel(profile.model_pk);
  return {
    ...profile,
    repos_using: countReposUsingProfile(profile.id),
    tasks_using: countTasksUsingProfile(profile.id),
    provider_id: model?.provider_id ?? null,
    model_id: model?.model_id ?? null,
  };
}

interface ProfileBody {
  display_name?: string;
  harness_id?: string;
  model_pk?: number;
  config_json?: Record<string, unknown>;
  timeout_minutes?: number;
}

function validateBody(
  body: ProfileBody,
  isCreate: boolean
):
  | { error: string }
  | { value: Omit<AgentProfile, 'id'> } {
  const display_name = String(body.display_name ?? '').trim();
  const harness_id = String(body.harness_id ?? '').trim();
  const model_pk = Number(body.model_pk);
  const timeout_minutes = Number(body.timeout_minutes ?? 2880);
  const config_json = body.config_json ?? {};

  if (!display_name) return { error: 'display_name is required' };
  if (!HARNESS_IDS.includes(harness_id as HarnessId)) {
    return {
      error: `harness_id must be one of: ${HARNESS_IDS.join(', ')}`,
    };
  }
  if (!Number.isFinite(model_pk)) {
    return { error: 'model_pk must be a number' };
  }
  const model = getModel(model_pk);
  if (!model) {
    return { error: `model_pk ${model_pk} does not reference an existing model` };
  }
  // Verify the model's provider still exists too — defensive against a
  // race where the provider was deleted between client load and submit.
  if (!getProvider(model.provider_id)) {
    return { error: `model's provider '${model.provider_id}' no longer exists` };
  }
  if (!Number.isInteger(timeout_minutes) || timeout_minutes < 1) {
    return { error: 'timeout_minutes must be a positive integer' };
  }
  if (typeof config_json !== 'object' || config_json === null || Array.isArray(config_json)) {
    return { error: 'config_json must be an object' };
  }

  // Per-harness config validation. The harness module owns its config
  // schema; we just call its validateConfig hook (if present) and let it
  // throw with a human-readable message.
  try {
    const spec = getHarness(harness_id as HarnessId);
    spec.validateConfig?.(config_json);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Note: harness↔provider compatibility is intentionally NOT validated
  // here (E3 design decision). If the operator pairs a harness with an
  // unsupported provider kind, the failure surfaces at task launch with
  // a clear "harness X doesn't support kind Y" message from
  // harness.buildInvocation.

  void isCreate; // currently unused; signature kept for future divergence.
  return {
    value: {
      display_name,
      harness_id: harness_id as HarnessId,
      model_pk,
      config_json,
      timeout_minutes,
    },
  };
}

export async function agentProfileRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/harnesses — registry metadata for the agent-profile creation
  // form. Read-only, code-defined.
  app.get('/api/harnesses', async () => {
    return {
      harnesses: listHarnesses().map((h) => ({
        id: h.id,
        display_name: h.display_name,
        runtime: h.runtime,
        supported_provider_kinds: h.supported_provider_kinds,
      })),
    };
  });

  // GET /api/agent-profiles
  app.get('/api/agent-profiles', async () => {
    return { profiles: getAgentProfiles().map(enrich) };
  });

  // POST /api/agent-profiles
  app.post('/api/agent-profiles', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    if (!id) return reply.status(400).send({ error: 'id is required' });
    if (getAgentProfile(id)) {
      return reply
        .status(409)
        .send({ error: `Agent profile '${id}' already exists` });
    }
    const v = validateBody(body as ProfileBody, true);
    if ('error' in v) return reply.status(400).send({ error: v.error });

    insertAgentProfile({ id, ...v.value });
    return reply.status(201).send(enrich(getAgentProfile(id)!));
  });

  // PATCH /api/agent-profiles/:id
  app.patch<{ Params: { id: string } }>(
    '/api/agent-profiles/:id',
    async (request, reply) => {
      const existing = getAgentProfile(request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'Agent profile not found' });
      }
      const body = request.body as Record<string, unknown>;
      const merged: ProfileBody = {
        display_name: existing.display_name,
        harness_id: existing.harness_id,
        model_pk: existing.model_pk,
        config_json: existing.config_json,
        timeout_minutes: existing.timeout_minutes,
        ...(body as ProfileBody),
      };
      const v = validateBody(merged, false);
      if ('error' in v) return reply.status(400).send({ error: v.error });

      updateAgentProfile(request.params.id, v.value);
      return enrich(getAgentProfile(request.params.id)!);
    }
  );

  // DELETE /api/agent-profiles/:id
  app.delete<{ Params: { id: string } }>(
    '/api/agent-profiles/:id',
    async (request, reply) => {
      const profile = getAgentProfile(request.params.id);
      if (!profile) {
        return reply.status(404).send({ error: 'Agent profile not found' });
      }
      // Application-layer RESTRICT: can't delete a profile while it's the
      // global default, or while any repo/task references it. Keeps the
      // FK ON DELETE RESTRICT from being the operator's first surprise.
      const defaultId = getSetting('default_agent_profile_id');
      if (defaultId === profile.id) {
        return reply.status(409).send({
          error: `'${profile.id}' is the global default profile. Set a different default before deleting.`,
        });
      }
      const reposUsing = countReposUsingProfile(profile.id);
      const tasksUsing = countTasksUsingProfile(profile.id);
      if (reposUsing > 0 || tasksUsing > 0) {
        return reply.status(409).send({
          error: `Profile is referenced by ${reposUsing} repo(s) and ${tasksUsing} task(s). Reassign those before deleting.`,
        });
      }
      deleteAgentProfile(profile.id);
      return reply.status(204).send();
    }
  );
}
