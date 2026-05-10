import type { FastifyInstance } from 'fastify';
import { getAllSettings, updateSetting } from '../db.js';
import type { SettingsKey } from '@orchestrator/shared';

/** Settings keys exposed to the UI (excludes internal keys like schema_version). */
const EDITABLE_KEYS: SettingsKey[] = [
  'max_agent_memory_mb',
  'max_agent_cpu_cores',
  'default_model',
];

const INT_KEYS = new Set<SettingsKey>([
  'max_agent_memory_mb',
  'max_agent_cpu_cores',
]);

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/settings
  app.get('/api/settings', async () => {
    const all = getAllSettings();
    const result: Record<string, unknown> = {};

    for (const key of EDITABLE_KEYS) {
      const raw = all[key];
      if (raw === undefined) continue;
      result[key] = INT_KEYS.has(key) ? parseInt(raw, 10) : raw;
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
