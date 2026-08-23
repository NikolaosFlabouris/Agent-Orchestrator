import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { initDatabase, getDb } from '../../db.js';
import { exportRoutes } from '../../routes/export.js';
import { createReportsRoutes } from '../../routes/reports.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { ExportAttemptRow } from '@orchestrator/shared';

/** `GET /api/export/attempts` end-to-end over the HTTP boundary.
 *
 *  Exercises the real route + the real SQL against an in-memory DB via
 *  Fastify's in-process injector: both response formats, every filter as it
 *  arrives on the query string, the streamed NDJSON body, and the 401 the
 *  global /api/* auth hook produces. No Docker, no Forgejo, no socket — the
 *  export is read-only and depends on nothing outside the database.
 */

const OLD = '2023-06-01T08:00:00.000Z'; // outside any default report window

async function buildApp(): Promise<FastifyInstance> {
  initDatabase(':memory:');
  seed();
  const app = Fastify({ logger: false });
  await app.register(exportRoutes);
  await app.ready();
  return app;
}

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r1')`).run();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'o', 'r2')`).run();
  const task = db.prepare(
    `INSERT INTO tasks (id, issue_id, issue_title, repo_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const attempt = db.prepare(
    `INSERT INTO attempts
       (task_id, attempt_number, role, status, verdict, started_at, completed_at,
        feedback, model_id, harness_id, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  task.run(1, 101, 'First task', 1, 'merged', '2025-01-05 00:00:00');
  // #1 develop, #2 review (with a feedback blob).
  attempt.run(1, 1, 'develop', 'completed', null,
    '2025-01-05T10:00:00.000Z', '2025-01-05T11:00:00.000Z',
    null, 'claude-sonnet-4-6', 'claude-sdk', 1000, 500);
  attempt.run(1, 1, 'review', 'completed', 'approved',
    '2025-01-05T12:00:00.000Z', '2025-01-05T12:30:00.000Z',
    '{"verdict":"approved"}', 'claude-sonnet-4-6', 'claude-sdk', null, null);

  // #3 — repo 2, two years old: only reachable because the export has no
  // default window.
  task.run(2, 202, 'Old task', 2, 'failed', '2023-06-01 07:00:00');
  attempt.run(2, 1, 'develop', 'failed', null, OLD, '2023-06-01T09:00:00.000Z',
    null, 'gpt-4o', 'opencode', null, null);
}

/** Parse an NDJSON body into rows, asserting the trailing-newline shape. */
function parseNdjson(body: string): ExportAttemptRow[] {
  expect(body.endsWith('\n')).toBe(true);
  return body
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as ExportAttemptRow);
}

describe('GET /api/export/attempts', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('streams all history as NDJSON by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export/attempts' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');

    const rows = parseNdjson(res.body);
    expect(rows.map((r) => r.attempt_id)).toEqual([1, 2, 3]);
    // The 2023 attempt is present — no DEFAULT_REPORT_WINDOW_DAYS fallback.
    expect(rows[2].started_at).toBe(OLD);
    expect(rows[0]).toMatchObject({
      task_id: 1,
      role: 'develop',
      duration_seconds: 3600,
      issue_id: 101,
      issue_title: 'First task',
      task_status: 'merged',
      repo_owner: 'o',
      repo_name: 'r1',
      provider_id: 'anthropic',
      model_display_name: 'Claude Sonnet 4.6',
    });
    // Unknown usage stays null on the wire, never 0.
    expect(rows[1].input_tokens).toBeNull();
    expect('feedback' in rows[0]).toBe(false);
  });

  it('returns the wrapped object form for format=json', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/export/attempts?format=json',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const body = res.json() as {
      rows: ExportAttemptRow[];
      count: number;
      filter: Record<string, unknown>;
    };
    expect(body.count).toBe(3);
    expect(body.rows.map((r) => r.attempt_id)).toEqual([1, 2, 3]);
    // The echoed filter reports the open-ended window it actually used.
    expect(body.filter).toEqual({
      repos: null,
      from: null,
      to: null,
      model: null,
      harness: null,
      role: null,
      status: null,
    });
  });

  it('applies every filter from the query string', async () => {
    const cases: Array<[string, number[]]> = [
      ['repos=1', [1, 2]],
      ['repos=2', [3]],
      ['from=2025-01-01T00:00:00.000Z', [1, 2]],
      ['to=2025-01-01T00:00:00.000Z', [3]],
      ['from=2025-01-05T12:00:00.000Z&to=2025-01-05T13:00:00.000Z', [2]],
      ['model=gpt-4o', [3]],
      ['harness=claude-sdk', [1, 2]],
      ['role=review', [2]],
      ['status=failed', [3]],
      ['repos=1&role=develop&status=completed', [1]],
    ];
    for (const [qs, expected] of cases) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/export/attempts?format=json&${qs}`,
      });
      expect(res.statusCode, qs).toBe(200);
      const body = res.json() as { rows: ExportAttemptRow[]; count: number };
      expect(body.rows.map((r) => r.attempt_id), qs).toEqual(expected);
      expect(body.count, qs).toBe(expected.length);
    }
  });

  it('adds feedback only with include_feedback=1', async () => {
    const off = await app.inject({
      method: 'GET',
      url: '/api/export/attempts?format=json',
    });
    expect('feedback' in (off.json().rows[1] as object)).toBe(false);

    const on = await app.inject({
      method: 'GET',
      url: '/api/export/attempts?format=json&include_feedback=1',
    });
    const rows = on.json().rows as ExportAttemptRow[];
    expect(rows[1].feedback).toBe('{"verdict":"approved"}');
    expect(rows[0].feedback).toBeNull();
  });

  it('rejects unknown format / role / status with 400', async () => {
    for (const qs of ['format=csv', 'role=refactor', 'status=pending']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/export/attempts?${qs}`,
      });
      expect(res.statusCode, qs).toBe(400);
      expect(res.json().error, qs).toContain('must be one of');
    }
  });

  it('streams NDJSON identically when the batch size is crossed', async () => {
    // 3 rows is more than one batch only if the batch size is small; the
    // route uses the production default, so this pins the end-to-end shape
    // rather than the batching itself — every row, once, in id order.
    const res = await app.inject({ method: 'GET', url: '/api/export/attempts' });
    const streamed = parseNdjson(res.body);
    const json = (
      await app.inject({ method: 'GET', url: '/api/export/attempts?format=json' })
    ).json().rows as ExportAttemptRow[];
    expect(streamed).toEqual(json);
  });
});

describe('GET /api/export/attempts authentication', () => {
  /** The production auth gate (auth.ts) is a URL-prefix hook over `/api/*`.
   *  Registering the same shape alongside BOTH route modules pins that the
   *  export is rejected exactly like the reports endpoints it sits beside —
   *  it is not exempt, and nothing about it is registered outside `/api/`. */
  it('rejects an unauthenticated request exactly like /api/reports/*', async () => {
    initDatabase(':memory:');
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/') && !request.url.startsWith('/ws/')) {
        return;
      }
      return reply.status(401).send({ error: 'Not authenticated' });
    });
    await app.register(exportRoutes);
    await app.register(createReportsRoutes({} as unknown as ForgejoClient));
    await app.ready();
    try {
      const exported = await app.inject({
        method: 'GET',
        url: '/api/export/attempts',
      });
      const report = await app.inject({
        method: 'GET',
        url: '/api/reports/overview',
      });
      expect(exported.statusCode).toBe(401);
      expect(exported.json()).toEqual({ error: 'Not authenticated' });
      expect(exported.statusCode).toBe(report.statusCode);
      expect(exported.json()).toEqual(report.json());
    } finally {
      await app.close();
    }
  });
});
