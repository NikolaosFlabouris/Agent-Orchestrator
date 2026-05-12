import type { FastifyInstance } from 'fastify';
import {
  getProvider,
  getProviders,
  insertProvider,
  updateProvider,
  deleteProvider,
  countModelsUsingProvider,
  getModel,
  getModelsByProvider,
  getModelByProviderAndId,
  insertModel,
  updateModel,
  deleteModel,
  countProfilesUsingModel,
  getActivePerProviderCounts,
} from '../db.js';
import type { Provider, ProviderKind, Model } from '@orchestrator/shared';
import { PROVIDER_KINDS } from '@orchestrator/shared';
import { getProviderKindSpec, listProviderKinds } from '../providers/kinds.js';
import { broadcastResourceChanged } from '../ws/dashboard.js';
import { isUniqueViolation } from '../db-errors.js';

/** Wire shape for `Provider` responses. Deliberately omits `auth_token`
 *  — the inline credential value is database-internal and must never
 *  ship to clients (see C1). Operators replace via the UI's tri-state
 *  control, which sends `auth_token` only when explicitly edited. The
 *  PATCH merge in this module reads `existing.auth_token` directly from
 *  the DB row, so omitting it from the wire format doesn't break the
 *  preservation-on-PATCH semantics. */
interface ProviderWithStats extends Omit<Provider, 'auth_token'> {
  /** True when the provider row has a non-empty inline auth_token set.
   *  The literal value is never shipped to clients. */
  has_auth_token: boolean;
  /** How many models point at this provider. */
  models_count: number;
  /** How many tasks are currently holding a slot against this provider. */
  active_slots: number;
}

/** Strict allow-list of characters real-world model identifiers use.
 *  Defence-in-depth against shell-metacharacter smuggling via DB rows
 *  that later flow into harness `agent_command` strings.
 *
 *  The leading char must be a letter or digit so values like ':foo' or
 *  '@/bar' don't slip through — those would pass the launch-time shell
 *  quoting fine but the inference endpoint would reject them with a
 *  confusing 'unknown model' error. Letters and digits are the only
 *  starting chars real-world model ids ever use. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/;

/** Same allow-list applied to provider ids (operator-supplied). */
const PROVIDER_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Pre-computed map of provider_id → active slot count, shared across
 *  one batch of `enrich(provider)` calls so we don't walk the task list
 *  N times per dashboard refresh. Pass an empty Map for the single-
 *  provider POST/PATCH paths if you don't want the overhead. */
function enrich(
  provider: Provider,
  activeCounts: Map<string, number>
): ProviderWithStats {
  // Destructure `auth_token` off so it never lands in the response.
  // `has_auth_token` reports presence-only; the value stays in the DB
  // row, reachable from the scheduler via getProvider() which returns
  // the full Provider type, but never via /api/providers.
  const { auth_token, ...safeFields } = provider;
  return {
    ...safeFields,
    has_auth_token: !!(auth_token && auth_token.trim().length > 0),
    models_count: countModelsUsingProvider(provider.id),
    active_slots: activeCounts.get(provider.id) ?? 0,
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
  // auth_token must be a string, explicit null, or absent. Reject other
  // types so a client that round-trips the new `has_auth_token: boolean`
  // response field back as `auth_token` doesn't accidentally store the
  // literal string "true" / "false" as a credential.
  if (
    'auth_token' in body &&
    body.auth_token !== null &&
    body.auth_token !== undefined &&
    typeof body.auth_token !== 'string'
  ) {
    return { error: 'auth_token must be a string or null' };
  }
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

  // Data-driven per-kind validation, sourced from ProviderKindSpec. As
  // new kinds are added (or existing ones flip required/optional flags)
  // they pick up validation here automatically — no string compares.
  const spec = getProviderKindSpec(kindRaw as ProviderKind);
  if (spec.requires_base_url && !baseUrl) {
    return {
      error: `base_url is required for ${spec.display_name} providers`,
    };
  }
  // M6: when present, base_url must parse as a well-formed http(s) URL.
  // Without this check, malformed values (`javascript:...`, `file:///...`,
  // raw hostnames missing a scheme) would save and fail later at task
  // launch with a confusing inference-side error. Restricting to
  // http/https matches every supported self-hosted endpoint (Ollama
  // exposes /v1 over http(s)) and rules out scheme-based misuse.
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return {
        error: `base_url must be a valid URL (got '${baseUrl}')`,
      };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        error:
          `base_url must use http:// or https:// scheme ` +
          `(got '${parsed.protocol}//…')`,
      };
    }
  }
  if (!spec.auth_optional && !authToken && !apiKeyEnvVar) {
    return {
      error:
        `${spec.display_name} providers require a credential. ` +
        `Set either auth_token (inline) or api_key_env_var (orchestrator-side env var).`,
    };
  }
  // M5: enforce mutual exclusion between auth_token and api_key_env_var.
  // Previously the runtime picked auth_token over api_key_env_var when
  // both were set (see providers/kinds.ts resolveProviderCredential),
  // but accepting both at save time was misleading — the operator
  // expects whichever value they entered most recently to win and is
  // likely to be surprised when the "other" field silently overrides.
  // For multi-instancing a kind, the right answer is two provider rows
  // each with exactly one credential type.
  if (authToken && apiKeyEnvVar) {
    return {
      error:
        'Set either auth_token (inline) or api_key_env_var (env-var pointer), ' +
        'not both. To multi-instance a kind with different credentials, ' +
        'create separate provider rows.',
    };
  }
  // api_key_env_var must be a syntactically valid env-var name. Anything
  // else is almost certainly a typo (e.g. accidentally pasting the key
  // value into this field) and would silently fail at task launch.
  if (apiKeyEnvVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnvVar)) {
    return {
      error:
        "api_key_env_var must be a valid environment variable name " +
        "(letters, digits, underscores; cannot start with a digit)",
    };
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
    // One SQL pass for the active-slot counts, shared across every
    // provider in the response. Previously this was an O(providers ×
    // active_tasks × 4 queries) walk per dashboard refresh.
    const activeCounts = getActivePerProviderCounts();
    return { providers: getProviders().map((p) => enrich(p, activeCounts)) };
  });

  // POST /api/providers
  app.post('/api/providers', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const id = String(body.id ?? '').trim();
    if (!id) return reply.status(400).send({ error: 'id is required' });
    if (!PROVIDER_ID_RE.test(id)) {
      return reply.status(400).send({
        error:
          "id may only contain letters, digits, and the characters '.', '-', '_'",
      });
    }
    if (getProvider(id)) {
      return reply
        .status(409)
        .send({ error: `Provider '${id}' already exists` });
    }
    const v = validateProviderShape(body);
    if ('error' in v) return reply.status(400).send({ error: v.error });

    try {
      insertProvider({ id, ...v.value });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply
          .status(409)
          .send({ error: `Provider '${id}' already exists` });
      }
      throw err;
    }
    broadcastResourceChanged('providers');
    return reply
      .status(201)
      .send(enrich(getProvider(id)!, getActivePerProviderCounts()));
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
      broadcastResourceChanged('providers');
      return enrich(getProvider(request.params.id)!, getActivePerProviderCounts());
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
      broadcastResourceChanged('providers');
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
      // model_id flows into shell-built `agent_command` strings (the
      // CLI harnesses single-quote it, but we also enforce a strict
      // character set here so an out-of-band DB edit can't smuggle
      // metacharacters past defence-in-depth). Allow only the chars
      // real-world model ids actually use: letters, digits, and
      // `.-_:/+@`. Reject anything else with a clear message.
      if (!MODEL_ID_RE.test(modelId)) {
        return reply.status(400).send({
          error:
            "model_id may only contain letters, digits, and the characters '.', '-', '_', ':', '/', '+', '@'",
        });
      }
      if (getModelByProviderAndId(provider.id, modelId)) {
        return reply.status(409).send({
          error: `Model '${modelId}' already exists for provider '${provider.id}'`,
        });
      }
      try {
        const inserted = insertModel({
          provider_id: provider.id,
          model_id: modelId,
          display_name: displayName,
        });
        broadcastResourceChanged('models');
        return reply.status(201).send(inserted);
      } catch (err) {
        // Race: a concurrent POST created the same (provider_id,
        // model_id) between our existence check and the insert. The
        // UNIQUE constraint trips; report as 409, not 500.
        if (isUniqueViolation(err)) {
          return reply.status(409).send({
            error: `Model '${modelId}' already exists for provider '${provider.id}'`,
          });
        }
        throw err;
      }
    }
  );

  // PATCH /api/models/:pk — update by surrogate PK.
  //
  // Editable fields are deliberately restricted to `display_name` only.
  //
  // DO NOT add `model_id` (or `provider_id`) to this allowlist without
  // first auditing every consumer that reads model.model_id at launch
  // time. The harness modules build their `agent_command` strings from
  // model.model_id and snapshot the resolved value onto the attempt
  // row at the queued→in-progress transition (H5). Allowing model_id
  // edits while a profile pointing at this model has in-flight
  // attempts would create drift between the on-disk agent_command
  // (built at launch from the OLD value, still running with the OLD
  // value via meta.json) and the row's `model_id` column (which
  // operators would expect to be the source of truth).
  //
  // If editing model_id is genuinely needed, the safer design is:
  // create a new model row, repoint the profile, leave the old row.
  // The H5 audit assumption is that model_id is immutable per row.
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
      // Explicit rejection of model_id / provider_id PATCHes — see the
      // comment above for the H5 reasoning.
      if ('model_id' in body) {
        return reply.status(400).send({
          error:
            'model_id is immutable. Create a new model row and repoint ' +
            'any profile using this one if you need a different inference id.',
        });
      }
      if ('provider_id' in body) {
        return reply.status(400).send({
          error: 'provider_id is immutable on an existing model row.',
        });
      }
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
      // M1: an empty `updates` map would still trigger a broadcast and
      // make every connected client refetch for no reason. The only way
      // to reach this point with no editable fields is an explicit
      // PATCH that includes neither display_name nor an editable field
      // — almost certainly an operator mistake. Reject with a clear
      // message before doing any DB / broadcast work.
      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({
          error:
            'No editable fields supplied. Only display_name is editable on an ' +
            'existing model row.',
        });
      }
      updateModel(pk, updates);
      broadcastResourceChanged('models');
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
      broadcastResourceChanged('models');
      return reply.status(204).send();
    }
  );
}
