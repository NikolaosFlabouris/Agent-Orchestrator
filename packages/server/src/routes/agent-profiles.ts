import type { FastifyInstance } from 'fastify';
import {
  getAgentProfile,
  getAgentProfilesWithStats,
  getAgentProfileWithStats,
  insertAgentProfile,
  updateAgentProfile,
  deleteAgentProfileIfUnreferenced,
  getModel,
  getProvider,
} from '../db.js';
import {
  listHarnesses,
  getHarness,
  checkHarnessProviderCompatibility,
} from '../harnesses/index.js';
import type { AgentProfile, HarnessId } from '@orchestrator/shared';
import { HARNESS_IDS } from '@orchestrator/shared';
import { broadcastResourceChanged } from '../ws/dashboard.js';
import { isUniqueViolation } from '../db-errors.js';

interface ProfileBody {
  display_name?: string;
  harness_id?: string;
  model_pk?: number;
  config_json?: Record<string, unknown>;
  timeout_minutes?: number;
}

function validateBody(
  body: ProfileBody
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
  const provider = getProvider(model.provider_id);
  if (!provider) {
    return { error: `model's provider '${model.provider_id}' no longer exists` };
  }
  if (!Number.isInteger(timeout_minutes) || timeout_minutes < 1) {
    return { error: 'timeout_minutes must be a positive integer' };
  }
  if (typeof config_json !== 'object' || config_json === null || Array.isArray(config_json)) {
    return { error: 'config_json must be an object' };
  }

  // Resolve the harness module. Unknown harness ids surface as a
  // dedicated error (typo / stale client / forgotten registry entry)
  // ahead of the more expensive checks below.
  let spec;
  try {
    spec = getHarness(harness_id as HarnessId);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Harness↔provider compatibility is the categorical check: this
  // (harness, provider.kind) pair is fundamentally incompatible. Run
  // it BEFORE validateConfig because that's the higher-signal error —
  // fixing config_json doesn't help if the harness can't talk to this
  // provider kind at all. The launch-time check in `buildInvocation`
  // stays as the authoritative gate; this save-time check is the
  // friendlier earlier surface (the docs cover this as the documented
  // save-time validation contract). (H7)
  const compat = checkHarnessProviderCompatibility(spec, provider.kind);
  if (!compat.ok) {
    return { error: compat.error };
  }

  // Per-harness config validation. The harness module owns its config
  // schema; we just call its validateConfig hook (if present) and let
  // it throw with a human-readable message.
  try {
    spec.validateConfig?.(config_json);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }

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
    return { profiles: getAgentProfilesWithStats() };
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
    const v = validateBody(body as ProfileBody);
    if ('error' in v) return reply.status(400).send({ error: v.error });

    try {
      insertAgentProfile({ id, ...v.value });
    } catch (err) {
      // Race: a concurrent POST inserted the same id between our
      // existence check and this INSERT. `agent_profiles.id` is a
      // TEXT PRIMARY KEY, so SQLite raises SQLITE_CONSTRAINT_PRIMARYKEY
      // (not _UNIQUE). The shared helper widens to any constraint
      // prefix to catch both. Report as 409, not 500.
      if (isUniqueViolation(err)) {
        return reply
          .status(409)
          .send({ error: `Agent profile '${id}' already exists` });
      }
      throw err;
    }
    broadcastResourceChanged('profiles');
    return reply.status(201).send(getAgentProfileWithStats(id)!);
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
      const v = validateBody(merged);
      if ('error' in v) return reply.status(400).send({ error: v.error });

      updateAgentProfile(request.params.id, v.value);
      broadcastResourceChanged('profiles');
      return getAgentProfileWithStats(request.params.id)!;
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
      // global default, or while any repo/task references it. Done
      // atomically inside one DB transaction (M4) so a concurrent
      // PATCH /api/settings can't repoint default_agent_profile_id at
      // this profile between the safety check and the delete.
      const refusal = deleteAgentProfileIfUnreferenced(profile.id);
      if (refusal) {
        return reply.status(409).send({ error: refusal });
      }
      broadcastResourceChanged('profiles');
      return reply.status(204).send();
    }
  );
}
