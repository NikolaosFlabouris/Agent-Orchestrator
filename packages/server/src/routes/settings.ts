import type { FastifyInstance } from 'fastify';
import { getAllSettings, updateSetting } from '../db.js';
import type { SettingsKey } from '@orchestrator/shared';

/** Settings keys exposed to the UI (excludes internal keys like schema_version). */
const EDITABLE_KEYS: SettingsKey[] = [
  'max_concurrency',
  'default_max_attempts',
  'agent_timeout_minutes',
  'default_model',
  'default_max_turns',
  'poll_interval_seconds',
  'merge_strategy',
  'model_pricing',
  'workspace_retention_days',
  'disk_threshold_bytes',
  'default_container_memory_mb',
  'default_container_cpu_cores',
];

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/settings
  app.get('/api/settings', async () => {
    const all = getAllSettings();
    const result: Record<string, unknown> = {};

    for (const key of EDITABLE_KEYS) {
      const raw = all[key];
      if (raw === undefined) continue;

      // Parse JSON values and numbers
      if (key === 'model_pricing') {
        try {
          result[key] = JSON.parse(raw);
        } catch {
          result[key] = raw;
        }
      } else if (
        [
          'max_concurrency',
          'default_max_attempts',
          'agent_timeout_minutes',
          'default_max_turns',
          'poll_interval_seconds',
          'workspace_retention_days',
          'default_container_memory_mb',
          'default_container_cpu_cores',
        ].includes(key)
      ) {
        result[key] = parseInt(raw, 10);
      } else if (key === 'disk_threshold_bytes') {
        result[key] = parseInt(raw, 10);
      } else {
        result[key] = raw;
      }
    }

    return result;
  });

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
      updateSetting(key as SettingsKey, strValue);
    }

    // Return updated settings
    return reply.redirect('/api/settings');
  });
}
