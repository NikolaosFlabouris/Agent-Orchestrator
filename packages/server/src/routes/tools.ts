import type { FastifyInstance } from 'fastify';
import { getDb, getAgentTool, getAgentTools } from '../db.js';
import type { AgentTool } from '@orchestrator/shared';

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/tools
  app.get('/api/tools', async () => {
    const tools = getAgentTools();
    return { tools: tools.map(enrichTool) };
  });

  // POST /api/tools
  app.post('/api/tools', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body?.id || !body?.display_name || !body?.type || !body?.auth_type) {
      return reply
        .status(400)
        .send({ error: 'Required: id, display_name, type, auth_type' });
    }

    getDb()
      .prepare(
        `INSERT INTO agent_tools (id, display_name, type, command_template, env_vars, auth_type, auth_config, timeout_minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.id,
        body.display_name,
        body.type,
        body.command_template ?? null,
        typeof body.env_vars === 'object'
          ? JSON.stringify(body.env_vars)
          : body.env_vars ?? '{}',
        body.auth_type,
        typeof body.auth_config === 'object'
          ? JSON.stringify(body.auth_config)
          : body.auth_config ?? '{}',
        body.timeout_minutes ?? null
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
        'display_name', 'type', 'command_template', 'auth_type', 'timeout_minutes',
      ];
      const sets: string[] = [];
      const params: unknown[] = [];

      for (const key of updatable) {
        if (key in body) {
          sets.push(`${key} = ?`);
          params.push(body[key] ?? null);
        }
      }
      if ('env_vars' in body) {
        sets.push('env_vars = ?');
        params.push(
          typeof body.env_vars === 'object'
            ? JSON.stringify(body.env_vars)
            : String(body.env_vars)
        );
      }
      if ('auth_config' in body) {
        sets.push('auth_config = ?');
        params.push(
          typeof body.auth_config === 'object'
            ? JSON.stringify(body.auth_config)
            : String(body.auth_config)
        );
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
  let authStatus = 'not required';

  if (tool.auth_type === 'api-key') {
    try {
      const config = JSON.parse(tool.auth_config);
      const envVar = config.env_var;
      if (envVar) {
        if (process.env[envVar]) {
          authStatus = 'configured';
        } else if (config.optional) {
          authStatus = 'not required';
        } else {
          authStatus = 'missing';
        }
      }
    } catch {
      authStatus = 'unknown';
    }
  }

  let envVarsParsed: Record<string, string> = {};
  try {
    envVarsParsed = JSON.parse(tool.env_vars);
  } catch { /* keep empty */ }

  let authConfigParsed: Record<string, unknown> = {};
  try {
    authConfigParsed = JSON.parse(tool.auth_config);
  } catch { /* keep empty */ }

  return {
    id: tool.id,
    display_name: tool.display_name,
    type: tool.type,
    command_template: tool.command_template,
    env_vars: envVarsParsed,
    auth_type: tool.auth_type,
    auth_config: authConfigParsed,
    auth_status: authStatus,
    timeout_minutes: tool.timeout_minutes,
  };
}
