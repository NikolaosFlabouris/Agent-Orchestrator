import type { FastifyInstance } from 'fastify';
import { getAllSettings, updateSetting, getAgentProfile } from '../db.js';
import type { SettingsKey } from '@orchestrator/shared';

/** Settings keys exposed to the UI (excludes internal keys like schema_version). */
const EDITABLE_KEYS: SettingsKey[] = [
  'max_agent_memory_mb',
  'max_agent_cpu_cores',
  'default_agent_profile_id',
];

const INT_KEYS = new Set<SettingsKey>([
  'max_agent_memory_mb',
  'max_agent_cpu_cores',
]);

/** Build the GET response payload from current DB state. Shared between
 *  GET and PATCH so PATCH can return the post-update view directly. */
function buildSettingsPayload(): Record<string, unknown> {
  const all = getAllSettings();
  const result: Record<string, unknown> = {};
  for (const key of EDITABLE_KEYS) {
    const raw = all[key];
    if (raw === undefined) continue;
    result[key] = INT_KEYS.has(key) ? parseInt(raw, 10) : raw;
  }
  return result;
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/settings
  app.get('/api/settings', async () => buildSettingsPayload());

  // PATCH /api/settings — partial update
  app.patch('/api/settings', async (request, reply) => {
    const updates = request.body as Record<string, unknown>;
    if (!updates || typeof updates !== 'object') {
      return reply.status(400).send({ error: 'Request body must be an object' });
    }

    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_KEYS.includes(key as SettingsKey)) {
        return reply.status(400).send({ error: `Unknown setting: ${key}` });
      }

      const strValue =
        typeof value === 'object' ? JSON.stringify(value) : String(value);

      // Per-key validation, before persisting any update in the batch.
      // Numeric keys must parse as positive integers — a 0 or non-
      // numeric here is almost always a typo and would silently zero
      // out the host resource pool, pausing all task launches.
      if (INT_KEYS.has(key as SettingsKey)) {
        const n = Number(strValue);
        if (!Number.isInteger(n) || n < 1) {
          return reply.status(400).send({
            error: `${key} must be a positive integer`,
          });
        }
      }

      // Validate default_agent_profile_id points at an existing profile.
      // Empty string is rejected — the orchestrator can't launch tasks
      // without a fallback profile, so refusing the unset state is safer
      // than allowing it to be cleared.
      if (key === 'default_agent_profile_id') {
        if (!strValue) {
          return reply
            .status(400)
            .send({ error: 'default_agent_profile_id cannot be empty' });
        }
        if (!getAgentProfile(strValue)) {
          return reply
            .status(400)
            .send({ error: `Agent profile '${strValue}' not found` });
        }
      }

      updateSetting(key as SettingsKey, strValue);
    }

    // Inline the updated payload rather than 302-redirecting to GET.
    // Clients that follow redirects still see the right body; clients
    // that don't (fetch with redirect:'manual', some test harnesses)
    // get the data straight away.
    return buildSettingsPayload();
  });
}
