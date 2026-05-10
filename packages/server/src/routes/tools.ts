import type { FastifyInstance } from 'fastify';
import { getDb, getAgentTool, getAgentTools, getProvider } from '../db.js';
import type { AgentTool } from '@orchestrator/shared';

function validateProviderId(
  providerId: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (providerId === undefined || providerId === null || providerId === '') {
    return { ok: true, value: null };
  }
  if (typeof providerId !== 'string') {
    return { ok: false, error: 'provider_id must be a string or null' };
  }
  if (!getProvider(providerId)) {
    return { ok: false, error: `Unknown provider_id: ${providerId}` };
  }
  return { ok: true, value: providerId };
}

/** Reject absolute paths and parent-traversal — the file must land inside
 *  /repo (anchored relative to the workspace root). Empty string is treated
 *  the same as null (no config file). */
function validateConfigFilePath(
  raw: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'config_file_path must be a string' };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.startsWith('/')) {
    return {
      ok: false,
      error: 'config_file_path must be relative (anchored under /repo)',
    };
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    return {
      ok: false,
      error: 'config_file_path must not contain "..".',
    };
  }
  return { ok: true, value: trimmed };
}

function normaliseConfigFileContent(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return typeof raw === 'string' ? raw : String(raw);
}

/** timeout_minutes is required (NOT NULL since schema v17) and must be a
 *  positive integer. Returns the validated value or an error. */
function validateTimeoutMinutes(
  raw: unknown
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return {
      ok: false,
      error: 'timeout_minutes must be a positive integer (minutes)',
    };
  }
  return { ok: true, value: raw };
}

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/tools
  app.get('/api/tools', async () => {
    const tools = getAgentTools();
    return { tools: tools.map(enrichTool) };
  });

  // POST /api/tools
  app.post('/api/tools', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (
      !body?.id ||
      !body?.display_name ||
      !body?.type ||
      body?.timeout_minutes === undefined ||
      body?.timeout_minutes === null
    ) {
      return reply
        .status(400)
        .send({ error: 'Required: id, display_name, type, timeout_minutes' });
    }

    const timeoutCheck = validateTimeoutMinutes(body.timeout_minutes);
    if (!timeoutCheck.ok) {
      return reply.status(400).send({ error: timeoutCheck.error });
    }

    const providerCheck = validateProviderId(body.provider_id);
    if (!providerCheck.ok) {
      return reply.status(400).send({ error: providerCheck.error });
    }

    const pathCheck = validateConfigFilePath(body.config_file_path);
    if (!pathCheck.ok) {
      return reply.status(400).send({ error: pathCheck.error });
    }
    const configContent = normaliseConfigFileContent(body.config_file_content);
    // Both columns are set together or both are null.
    const configPath = configContent === null ? null : pathCheck.value;
    if (pathCheck.value && configContent === null) {
      return reply
        .status(400)
        .send({ error: 'config_file_path requires config_file_content' });
    }

    getDb()
      .prepare(
        `INSERT INTO agent_tools (id, display_name, type, command_template, env_vars, config_file_path, config_file_content, timeout_minutes, provider_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.id,
        body.display_name,
        body.type,
        body.command_template ?? null,
        typeof body.env_vars === 'object'
          ? JSON.stringify(body.env_vars)
          : body.env_vars ?? '{}',
        configPath,
        configContent,
        timeoutCheck.value,
        providerCheck.value
      );

    const tool = getAgentTool(body.id as string);
    return reply.status(201).send(tool ? enrichTool(tool) : null);
  });

  // PATCH /api/tools/:id
  app.patch<{ Params: { id: string } }>(
    '/api/tools/:id',
    async (request, reply) => {
      const tool = getAgentTool(request.params.id);
      if (!tool) {
        return reply.status(404).send({ error: 'Tool not found' });
      }

      const body = request.body as Record<string, unknown>;
      const updatable = [
        'display_name', 'type', 'command_template',
      ];
      const sets: string[] = [];
      const params: unknown[] = [];

      for (const key of updatable) {
        if (key in body) {
          sets.push(`${key} = ?`);
          params.push(body[key] ?? null);
        }
      }
      // timeout_minutes is NOT NULL — validate as positive integer when set.
      if ('timeout_minutes' in body) {
        const check = validateTimeoutMinutes(body.timeout_minutes);
        if (!check.ok) {
          return reply.status(400).send({ error: check.error });
        }
        sets.push('timeout_minutes = ?');
        params.push(check.value);
      }
      if ('env_vars' in body) {
        sets.push('env_vars = ?');
        params.push(
          typeof body.env_vars === 'object'
            ? JSON.stringify(body.env_vars)
            : String(body.env_vars)
        );
      }
      // config_file_{path,content} update together so the columns stay in
      // sync (both set or both null). If only one of the two keys appears in
      // the body, fall back to the existing row value for the other.
      if ('config_file_path' in body || 'config_file_content' in body) {
        const pathCheck = validateConfigFilePath(
          'config_file_path' in body ? body.config_file_path : tool.config_file_path
        );
        if (!pathCheck.ok) {
          return reply.status(400).send({ error: pathCheck.error });
        }
        const newContent = normaliseConfigFileContent(
          'config_file_content' in body
            ? body.config_file_content
            : tool.config_file_content
        );
        if (pathCheck.value && newContent === null) {
          return reply
            .status(400)
            .send({ error: 'config_file_path requires config_file_content' });
        }
        const newPath = newContent === null ? null : pathCheck.value;
        sets.push('config_file_path = ?');
        params.push(newPath);
        sets.push('config_file_content = ?');
        params.push(newContent);
      }
      if ('provider_id' in body) {
        const check = validateProviderId(body.provider_id);
        if (!check.ok) {
          return reply.status(400).send({ error: check.error });
        }
        sets.push('provider_id = ?');
        params.push(check.value);
      }

      if (sets.length === 0) {
        return reply.status(400).send({ error: 'No valid fields to update' });
      }

      params.push(request.params.id);
      getDb()
        .prepare(`UPDATE agent_tools SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params);

      const updated = getAgentTool(request.params.id);
      return updated ? enrichTool(updated) : null;
    }
  );
}

function enrichTool(tool: AgentTool) {
  let envVarsParsed: Record<string, string> = {};
  try {
    envVarsParsed = JSON.parse(tool.env_vars);
  } catch { /* keep empty */ }

  return {
    id: tool.id,
    display_name: tool.display_name,
    type: tool.type,
    command_template: tool.command_template,
    env_vars: envVarsParsed,
    config_file_path: tool.config_file_path,
    config_file_content: tool.config_file_content,
    timeout_minutes: tool.timeout_minutes,
    provider_id: tool.provider_id,
  };
}
