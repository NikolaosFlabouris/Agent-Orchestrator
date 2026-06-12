import type { FastifyInstance } from 'fastify';
import { getAllSettings, updateSetting, getAgentProfile } from '../db.js';
import type { SettingsKey } from '@orchestrator/shared';

/** Settings keys exposed to the UI (excludes internal keys like schema_version). */
const EDITABLE_KEYS: SettingsKey[] = [
  'max_agent_memory_mb',
  'max_agent_cpu_cores',
  'default_agent_profile_id',
  'default_review_agent_profile_id',
];

/** Keys holding an agent-profile pointer. Same validation contract:
 *  null clears, empty string is rejected, a non-empty value must
 *  reference an existing profile. Clearing the review default is a
 *  benign state (review falls back to the implementation profile);
 *  clearing the implementation default is the documented "unset
 *  default" state the UI warns about. */
const PROFILE_KEYS = new Set<SettingsKey>([
  'default_agent_profile_id',
  'default_review_agent_profile_id',
]);

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

      // Special handling for the profile-pointer keys — `null` clears
      // the stored value. For default_agent_profile_id that puts the
      // orchestrator into an "unset default" state: tasks without a
      // per-task or repo override will refuse to launch with a clear
      // error; the UI (M2) surfaces this state explicitly, so operators
      // who land in it via the picker have asked for it. For
      // default_review_agent_profile_id the cleared state is benign —
      // review falls back to the implementation profile.
      if (PROFILE_KEYS.has(key as SettingsKey) && value === null) {
        updateSetting(key as SettingsKey, null);
        continue;
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

      // Validate profile-pointer keys point at an existing profile when
      // set to a non-null value. Empty string is rejected — the unset
      // state is reachable only via explicit null above, not via
      // accidentally-blanked string input.
      if (PROFILE_KEYS.has(key as SettingsKey)) {
        if (!strValue) {
          return reply.status(400).send({
            error: `${key} cannot be empty string. Pass null to clear.`,
          });
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
