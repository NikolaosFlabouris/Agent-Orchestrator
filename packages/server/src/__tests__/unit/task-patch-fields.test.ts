import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { initDatabase, getDb, getTask, getTaskEvents } from '../../db.js';
import { createTaskRoutes } from '../../routes/tasks.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

/**
 * Route-level tests for PATCH /api/tasks/:id direct-field updates.
 *
 * Focus: combined-field semantics. The handler used to process one field
 * per request (first match returned early), which silently dropped any
 * additional fields — easy to hit now that the implementation/review
 * profile pair is a natural thing to set together. These tests pin the
 * fixed contract: all recognized fields in one body are validated up
 * front and applied atomically; any validation failure rejects the whole
 * request with nothing applied.
 *
 * Only the Forgejo surface the field-update path touches is stubbed
 * (commentOnIssue, best-effort). The action paths (cancel/reset/…) need
 * the broader ForgejoClient + Scheduler machinery and stay covered
 * elsewhere.
 */

const SDK_PROFILE = 'default-claude-sdk';
const SUB_PROFILE = 'default-claude-code-subscription';

let app: FastifyInstance;
let commentOnIssue: ReturnType<typeof vi.fn>;

async function buildApp(): Promise<void> {
  commentOnIssue = vi.fn().mockResolvedValue(undefined);
  const forgejoStub = { commentOnIssue } as unknown as ForgejoClient;
  const schedulerStub = { triggerTick: vi.fn() } as unknown as Scheduler;
  app = Fastify({ logger: false });
  await app.register(createTaskRoutes(forgejoStub, schedulerStub));
  await app.ready();
}

function seedTask(status = 'queued'): number {
  getDb()
    .prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'acme', 'web')`)
    .run();
  const result = getDb()
    .prepare(
      `INSERT INTO tasks (issue_id, repo_id, status, attempt, max_attempts)
       VALUES (10, 1, ?, 1, 7)`
    )
    .run(status);
  return result.lastInsertRowid as number;
}

beforeEach(async () => {
  initDatabase(':memory:');
  await buildApp();
});

describe('PATCH /api/tasks/:id — combined field updates', () => {
  it('applies both profile overrides from a single request', async () => {
    const taskId = seedTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: {
        agent_profile_id: SDK_PROFILE,
        review_agent_profile_id: SUB_PROFILE,
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.agent_profile_id).toBe(SDK_PROFILE);
    expect(json.review_agent_profile_id).toBe(SUB_PROFILE);
    expect(json.agent_profile_source).toBe('task');
    expect(json.review_agent_profile_source).toBe('task');

    // Persisted, not just echoed.
    const row = getTask(taskId)!;
    expect(row.agent_profile_id).toBe(SDK_PROFILE);
    expect(row.review_agent_profile_id).toBe(SUB_PROFILE);

    // One audit event per field, one comment per field.
    const eventTypes = getTaskEvents(taskId).map((e) => e.event_type);
    expect(eventTypes).toContain('agent_profile_changed');
    expect(eventTypes).toContain('review_agent_profile_changed');
    expect(commentOnIssue).toHaveBeenCalledTimes(2);
  });

  it('applies a profile override and max_attempts together', async () => {
    const taskId = seedTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { review_agent_profile_id: SUB_PROFILE, max_attempts: 3 },
    });

    expect(res.statusCode).toBe(200);
    const row = getTask(taskId)!;
    expect(row.review_agent_profile_id).toBe(SUB_PROFILE);
    expect(row.max_attempts).toBe(3);
    const eventTypes = getTaskEvents(taskId).map((e) => e.event_type);
    expect(eventTypes).toContain('review_agent_profile_changed');
    expect(eventTypes).toContain('max_attempts_changed');
  });

  it('rejects the whole request when any field is invalid — nothing applied', async () => {
    const taskId = seedTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: {
        agent_profile_id: SDK_PROFILE, // valid
        review_agent_profile_id: 'no-such-profile', // invalid
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(
      'Unknown review_agent_profile_id: no-such-profile'
    );
    // The valid field was NOT half-applied.
    const row = getTask(taskId)!;
    expect(row.agent_profile_id).toBeNull();
    expect(row.review_agent_profile_id).toBeNull();
    expect(getTaskEvents(taskId)).toHaveLength(0);
    expect(commentOnIssue).not.toHaveBeenCalled();
  });

  it('terminal-state max_attempts rejection (409) also blocks profile fields in the same request', async () => {
    const taskId = seedTask('failed');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { agent_profile_id: SDK_PROFILE, max_attempts: 9 },
    });

    expect(res.statusCode).toBe(409);
    expect(getTask(taskId)!.agent_profile_id).toBeNull();
  });

  it('single-field requests keep working (review profile only)', async () => {
    const taskId = seedTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { review_agent_profile_id: SUB_PROFILE },
    });

    expect(res.statusCode).toBe(200);
    expect(getTask(taskId)!.review_agent_profile_id).toBe(SUB_PROFILE);
    expect(getTask(taskId)!.agent_profile_id).toBeNull();
  });

  it('null clears an override without touching the other field', async () => {
    const taskId = seedTask();
    getDb()
      .prepare(
        `UPDATE tasks SET agent_profile_id = ?, review_agent_profile_id = ? WHERE id = ?`
      )
      .run(SDK_PROFILE, SUB_PROFILE, taskId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { review_agent_profile_id: null },
    });

    expect(res.statusCode).toBe(200);
    const row = getTask(taskId)!;
    expect(row.review_agent_profile_id).toBeNull();
    expect(row.agent_profile_id).toBe(SDK_PROFILE);
  });

  it('still rejects empty-string profile values with the explicit message', async () => {
    const taskId = seedTask();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { agent_profile_id: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(
      'agent_profile_id cannot be empty. Pass null to clear the per-task override.'
    );
  });

  it('404s for an unknown task id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/9999',
      payload: { agent_profile_id: SDK_PROFILE },
    });
    expect(res.statusCode).toBe(404);
  });
});
