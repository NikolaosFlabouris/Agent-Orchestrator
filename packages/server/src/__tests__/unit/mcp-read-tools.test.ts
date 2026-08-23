/**
 * The read-only MCP tool surface (issue #191).
 *
 * These five tools are wrappers, so the tests are mostly about the wrapper
 * NOT drifting from what it wraps:
 *
 *   - `get_task` must return the same data as `GET /api/tasks/:id`,
 *   - `query_attempts` the same rows as `GET /api/export/attempts`,
 *   - `get_report` the same aggregate as `GET /api/reports/*`,
 *
 * each asserted by running both sides against the same in-memory database
 * and comparing. The rest pins the contract a client codes against: the
 * server-side output bounds, and that a bad argument comes back as an
 * `Invalid input:` / `Not found:` tool error rather than a thrown schema
 * violation.
 *
 * ARCHIVE_ROOT and WORKSPACES_ROOT are redirected into a temp dir so the
 * `get_task_log` cases can build (and delete) a real workspace; the rest of
 * `constants.js` is the real thing. Docker's `listContainers` is stubbed —
 * task-health derivation calls it and there is no daemon here.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ExportAttemptRow, Task } from '@orchestrator/shared';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-mcp-read-'));
const WORKSPACES = path.join(tmpRoot, 'workspaces');
const ARCHIVE = path.join(tmpRoot, 'archive');

vi.mock('../../constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../constants.js')>();
  return { ...actual, WORKSPACES_ROOT: WORKSPACES, ARCHIVE_ROOT: ARCHIVE };
});

vi.mock('../../docker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../docker.js')>();
  return { ...actual, listContainers: vi.fn(async () => []) };
});

const { initDatabase, getDb } = await import('../../db.js');
const { createMcpServer } = await import('../../mcp/server.js');
const { createTaskRoutes } = await import('../../routes/tasks.js');
const { createReportsRoutes } = await import('../../routes/reports.js');
const { exportRoutes } = await import('../../routes/export.js');
const { archiveTaskArtifacts, LOG_FILENAME } = await import('../../archive.js');
const { getWorkdir, getOutputDir } = await import('../../workspace.js');
const { _clearManagedContainerCache } = await import('../../container-list.js');
const { _clearSnapshotCache } = await import('../../forgejo-snapshot.js');

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as FastifyBaseLogger;

/** Deterministic Forgejo double: every issue open, no PR, so the derived
 *  status always equals the stored one on both the REST and the MCP side. */
const fakeForgejo = {
  getIssue: vi.fn(async () => ({ number: 1, state: 'open', labels: [] })),
  getPullRequest: vi.fn(async () => ({
    number: 1,
    state: 'open',
    merged: false,
    mergeable: true,
  })),
  listIssues: vi.fn(async () => []),
  listPullRequests: vi.fn(async () => []),
} as unknown as ForgejoClient;

const WINDOW = { from: '2025-01-01T00:00:00.000Z', to: '2025-02-01T00:00:00.000Z' };
const OLD = '2023-06-01T08:00:00.000Z'; // outside any default report window

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'acme', 'frontend')`).run();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'acme', 'backend')`).run();

  const task = db.prepare(
    `INSERT INTO tasks
       (id, issue_id, issue_title, repo_id, status, attempt, max_attempts, pr_number,
        agent_profile_id, review_agent_profile_id, created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const attempt = db.prepare(
    `INSERT INTO attempts
       (task_id, attempt_number, role, status, verdict, started_at, completed_at,
        feedback, model_id, harness_id, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  task.run(1, 101, 'First task', 1, 'merged', 1, 7, 11, null, null,
    '2025-01-05T00:00:00.000Z', '2025-01-05T10:00:00.000Z', '2025-01-05T12:30:00.000Z');
  attempt.run(1, 1, 'develop', 'completed', null,
    '2025-01-05T10:00:00.000Z', '2025-01-05T11:00:00.000Z',
    null, 'claude-sonnet-4-6', 'claude-sdk', 1000, 500);
  attempt.run(1, 1, 'review', 'completed', 'approved',
    '2025-01-05T12:00:00.000Z', '2025-01-05T12:30:00.000Z',
    '{"verdict":"approved"}', 'claude-sonnet-4-6', 'claude-sdk', null, null);

  task.run(2, 202, 'Second task', 2, 'failed', 3, 3, null,
    'default-claude-sdk', 'default-claude-code-subscription',
    '2025-01-10T00:00:00.000Z', '2025-01-10T09:00:00.000Z', '2025-01-10T09:30:00.000Z');
  attempt.run(2, 1, 'develop', 'failed', null,
    '2025-01-10T09:00:00.000Z', '2025-01-10T09:30:00.000Z',
    null, 'gpt-4o', 'opencode', 20, 5);

  task.run(3, 303, 'Queued task', 1, 'queued', 0, 7, null, null, null,
    '2025-01-20T00:00:00.000Z', null, null);

  // Old history: only `query_attempts` (no default window) reaches this.
  task.run(4, 404, 'Ancient task', 2, 'merged', 1, 7, null, null, null,
    '2023-06-01T07:00:00.000Z', OLD, '2023-06-01T09:00:00.000Z');
  attempt.run(4, 1, 'develop', 'completed', null, OLD, '2023-06-01T09:00:00.000Z',
    null, 'gpt-4o', 'opencode', null, null);
}

function taskRow(id: number): Task {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
}

interface Harness {
  client: Client;
  app: FastifyInstance;
  close: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const server = createMcpServer({
    forgejo: fakeForgejo,
    scheduler: { triggerTick: () => {} } as Pick<Scheduler, 'triggerTick'>,
    log: silentLog,
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const app = Fastify({ logger: false });
  app.log.warn = () => app.log as never;
  await app.register(
    createTaskRoutes(fakeForgejo, { triggerTick: () => {} } as unknown as Scheduler)
  );
  await app.register(createReportsRoutes(fakeForgejo));
  await app.register(exportRoutes);
  await app.ready();

  return {
    client,
    app,
    close: async () => {
      await client.close();
      await server.close();
      await app.close();
    },
  };
}

/** Call a tool and assert it succeeded, returning the structured content. */
async function call<T = Record<string, unknown>>(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await h.client.callTool({ name, arguments: args });
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as T;
}

/** Call a tool expecting a tool error, returning its text. */
async function callErr(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const result = await h.client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return textOf(result);
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

let harness: Harness;

beforeEach(async () => {
  initDatabase(':memory:');
  _clearSnapshotCache();
  _clearManagedContainerCache();
  vi.clearAllMocks();
  seed();
  harness = await boot();
  return async () => {
    await harness.close();
  };
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

interface ListTasksResult {
  tasks: Array<{
    id: number;
    issue_id: number;
    issue_title: string | null;
    repo: { id: number; owner: string; name: string } | null;
    status: string;
    attempt: number;
    max_attempts: number;
    pr_number: number | null;
    agent_profile_id: string | null;
    review_agent_profile_id: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
  count: number;
  total: number;
  limit: number;
  offset: number;
}

describe('MCP tool list_tasks', () => {
  it('returns every task newest first with its repo and profile overrides', async () => {
    const sc = await call<ListTasksResult>(harness, 'list_tasks');
    expect(sc.tasks.map((t) => t.id)).toEqual([4, 3, 2, 1]);
    expect(sc.total).toBe(4);
    expect(sc.count).toBe(4);
    expect(sc.limit).toBe(50);
    expect(sc.offset).toBe(0);
    expect(sc.tasks[2]).toMatchObject({
      id: 2,
      issue_id: 202,
      issue_title: 'Second task',
      repo: { id: 2, owner: 'acme', name: 'backend' },
      status: 'failed',
      attempt: 3,
      max_attempts: 3,
      pr_number: null,
      agent_profile_id: 'default-claude-sdk',
      review_agent_profile_id: 'default-claude-code-subscription',
      completed_at: '2025-01-10T09:30:00.000Z',
    });
    // No date window: the 2023 task is present.
    expect(sc.tasks.map((t) => t.id)).toContain(4);
  });

  it('filters by repo_id and by status', async () => {
    const byRepo = await call<ListTasksResult>(harness, 'list_tasks', { repo_id: 1 });
    expect(byRepo.tasks.map((t) => t.id)).toEqual([3, 1]);

    const byStatus = await call<ListTasksResult>(harness, 'list_tasks', {
      status: 'merged',
    });
    expect(byStatus.tasks.map((t) => t.id)).toEqual([4, 1]);

    const both = await call<ListTasksResult>(harness, 'list_tasks', {
      repo_id: 2,
      status: 'merged',
    });
    expect(both.tasks.map((t) => t.id)).toEqual([4]);
  });

  it('pages with limit/offset and reports the unpaged total', async () => {
    const page1 = await call<ListTasksResult>(harness, 'list_tasks', { limit: 2 });
    expect(page1.tasks.map((t) => t.id)).toEqual([4, 3]);
    expect(page1.total).toBe(4);
    expect(page1.count).toBe(2);

    const page2 = await call<ListTasksResult>(harness, 'list_tasks', {
      limit: 2,
      offset: 2,
    });
    expect(page2.tasks.map((t) => t.id)).toEqual([2, 1]);
    expect(page2.offset).toBe(2);
    expect(page2.total).toBe(4);
  });

  it('rejects a limit over the server-side maximum', async () => {
    const text = await callErr(harness, 'list_tasks', { limit: 201 });
    expect(text).toMatch(/^Invalid input:/);
    expect(text).toMatch(/limit must be an integer between 1 and 200/);
  });

  it('rejects an unknown status and an unknown repo_id', async () => {
    expect(await callErr(harness, 'list_tasks', { status: 'nope' })).toMatch(
      /^Invalid input: status must be one of: queued, /
    );
    expect(await callErr(harness, 'list_tasks', { repo_id: 999 })).toMatch(
      /^Not found: No repo with id 999/
    );
  });
});

// ---------------------------------------------------------------------------
// get_task
// ---------------------------------------------------------------------------

describe('MCP tool get_task', () => {
  it('returns exactly what GET /api/tasks/:id returns', async () => {
    const rest = await harness.app.inject({ method: 'GET', url: '/api/tasks/1' });
    expect(rest.statusCode).toBe(200);
    const expected = rest.json() as Record<string, unknown>;

    const sc = await call<{
      task: Record<string, unknown>;
      attempts: unknown[];
      events: unknown[];
      forgejo_links: Record<string, string>;
    }>(harness, 'get_task', { task_id: 1 });

    // Same code path (services/task-detail.ts); the MCP tool only nests the
    // three collections under their own keys.
    expect({
      ...sc.task,
      attempts: sc.attempts,
      events: sc.events,
      forgejo_links: sc.forgejo_links,
    }).toEqual(expected);
  });

  it('includes the attempt history and the Forgejo links', async () => {
    const sc = await call<{
      task: { status: string; runtime_status: string };
      attempts: Array<{ role: string; verdict: string | null; input_tokens: number | null }>;
      forgejo_links: Record<string, string>;
    }>(harness, 'get_task', { task_id: 1 });

    expect(sc.task.status).toBe('merged');
    expect(sc.task.runtime_status).toBe('merged');
    expect(sc.attempts).toHaveLength(2);
    expect(sc.attempts[1]).toMatchObject({ role: 'review', verdict: 'approved' });
    // Unknown usage stays null, never 0.
    expect(sc.attempts[1].input_tokens).toBeNull();
    expect(sc.forgejo_links.issue).toMatch(/acme\/frontend\/issues\/101$/);
    expect(sc.forgejo_links.pr).toMatch(/acme\/frontend\/pulls\/11$/);
  });

  it('reports an unknown task id as Not found', async () => {
    expect(await callErr(harness, 'get_task', { task_id: 9999 })).toMatch(
      /^Not found: No task with id 9999/
    );
  });
});

// ---------------------------------------------------------------------------
// get_task_log
// ---------------------------------------------------------------------------

interface LogResult {
  task_id: number;
  log: string;
  total_lines: number;
  returned_lines: number;
  truncated: boolean;
}

/** Write a progress log into task `id`'s live workspace. */
async function writeWorkspaceLog(id: number, lines: string[]): Promise<Task> {
  const task = taskRow(id);
  const outputDir = getOutputDir(task);
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(path.join(outputDir, LOG_FILENAME), lines.join('\n') + '\n');
  return task;
}

describe('MCP tool get_task_log', () => {
  it('reads the live workspace log and honours tail_lines', async () => {
    await writeWorkspaceLog(1, Array.from({ length: 120 }, (_, i) => `line ${i + 1}`));

    const all = await call<LogResult>(harness, 'get_task_log', { task_id: 1 });
    expect(all.total_lines).toBe(120);
    expect(all.returned_lines).toBe(120);
    expect(all.truncated).toBe(false);
    expect(all.log.split('\n')[0]).toBe('line 1');

    const tail = await call<LogResult>(harness, 'get_task_log', {
      task_id: 1,
      tail_lines: 10,
    });
    expect(tail.total_lines).toBe(120);
    expect(tail.returned_lines).toBe(10);
    expect(tail.truncated).toBe(true);
    expect(tail.log.split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${111 + i}`)
    );
  });

  it('still serves the log after the workspace is gone, from the archive', async () => {
    const task = await writeWorkspaceLog(
      1,
      Array.from({ length: 30 }, (_, i) => `archived ${i + 1}`)
    );
    await archiveTaskArtifacts(task, silentLog);
    await fsp.rm(getWorkdir(task), { recursive: true, force: true });
    expect(fs.existsSync(getWorkdir(task))).toBe(false);

    const sc = await call<LogResult>(harness, 'get_task_log', {
      task_id: 1,
      tail_lines: 5,
    });
    expect(sc.total_lines).toBe(30);
    expect(sc.returned_lines).toBe(5);
    expect(sc.truncated).toBe(true);
    expect(sc.log.split('\n')).toEqual([
      'archived 26',
      'archived 27',
      'archived 28',
      'archived 29',
      'archived 30',
    ]);
  });

  it('reports Not found when neither the workspace nor the archive holds a log', async () => {
    expect(await callErr(harness, 'get_task_log', { task_id: 3 })).toMatch(
      /^Not found: No log for task 3/
    );
    expect(await callErr(harness, 'get_task_log', { task_id: 9999 })).toMatch(
      /^Not found: No task with id 9999/
    );
  });

  it('counts a final line that has no trailing newline', async () => {
    const task = taskRow(1);
    const outputDir = getOutputDir(task);
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, LOG_FILENAME), 'a\nb\nc');

    const sc = await call<LogResult>(harness, 'get_task_log', { task_id: 1 });
    expect(sc.total_lines).toBe(3);
    expect(sc.returned_lines).toBe(3);
    expect(sc.log).toBe('a\nb\nc');
  });

  it('rejects a tail_lines over the server-side maximum', async () => {
    await writeWorkspaceLog(1, ['x']);
    const text = await callErr(harness, 'get_task_log', {
      task_id: 1,
      tail_lines: 5001,
    });
    expect(text).toMatch(/^Invalid input:/);
    expect(text).toMatch(/tail_lines must be an integer between 1 and 5000/);
  });
});

// ---------------------------------------------------------------------------
// query_attempts
// ---------------------------------------------------------------------------

interface AttemptsResult {
  rows: ExportAttemptRow[];
  count: number;
  limit: number;
  offset: number;
}

/** The REST export's rows for the same query string. */
async function restExport(query: string): Promise<ExportAttemptRow[]> {
  const res = await harness.app.inject({
    method: 'GET',
    url: `/api/export/attempts?format=json${query}`,
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { rows: ExportAttemptRow[] }).rows;
}

describe('MCP tool query_attempts', () => {
  it('returns the same rows as GET /api/export/attempts for the same filter', async () => {
    const sc = await call<AttemptsResult>(harness, 'query_attempts');
    expect(sc.rows).toEqual(await restExport(''));
    expect(sc.count).toBe(4);
    expect(sc.limit).toBe(200);
    expect(sc.offset).toBe(0);
    // No default window — the 2023 attempt is included.
    expect(sc.rows.map((r) => r.attempt_id)).toEqual([1, 2, 3, 4]);
  });

  it('matches the REST export for every filter it forwards', async () => {
    expect(
      (await call<AttemptsResult>(harness, 'query_attempts', { role: 'review' })).rows
    ).toEqual(await restExport('&role=review'));

    expect(
      (await call<AttemptsResult>(harness, 'query_attempts', { model: 'gpt-4o' })).rows
    ).toEqual(await restExport('&model=gpt-4o'));

    expect(
      (await call<AttemptsResult>(harness, 'query_attempts', {
        harness: 'claude-sdk',
        status: 'completed',
      })).rows
    ).toEqual(await restExport('&harness=claude-sdk&status=completed'));

    expect(
      (await call<AttemptsResult>(harness, 'query_attempts', { repos: [2] })).rows
    ).toEqual(await restExport('&repos=2'));

    expect(
      (await call<AttemptsResult>(harness, 'query_attempts', {
        from: WINDOW.from,
        to: WINDOW.to,
      })).rows
    ).toEqual(await restExport(`&from=${WINDOW.from}&to=${WINDOW.to}`));
  });

  it('includes the feedback blob only when asked', async () => {
    const without = await call<AttemptsResult>(harness, 'query_attempts', {
      role: 'review',
    });
    expect('feedback' in without.rows[0]).toBe(false);

    const withFeedback = await call<AttemptsResult>(harness, 'query_attempts', {
      role: 'review',
      include_feedback: true,
    });
    expect(withFeedback.rows[0].feedback).toBe('{"verdict":"approved"}');
  });

  it('pages with limit/offset', async () => {
    const page1 = await call<AttemptsResult>(harness, 'query_attempts', { limit: 2 });
    expect(page1.rows.map((r) => r.attempt_id)).toEqual([1, 2]);
    expect(page1.count).toBe(2);

    const page2 = await call<AttemptsResult>(harness, 'query_attempts', {
      limit: 2,
      offset: 2,
    });
    expect(page2.rows.map((r) => r.attempt_id)).toEqual([3, 4]);
    expect(page2.offset).toBe(2);
  });

  it('rejects an over-max limit, an unknown role, and an unparseable date', async () => {
    expect(await callErr(harness, 'query_attempts', { limit: 2001 })).toMatch(
      /^Invalid input: limit must be an integer between 1 and 2000/
    );
    expect(await callErr(harness, 'query_attempts', { role: 'reviewer' })).toMatch(
      /^Invalid input: role must be one of: develop, review/
    );
    expect(await callErr(harness, 'query_attempts', { from: 'last tuesday' })).toMatch(
      /^Invalid input: from must be an ISO-8601 date/
    );
  });

  it('tells the caller to use the REST export for bulk pulls', async () => {
    const { tools } = await harness.client.listTools();
    const tool = tools.find((t) => t.name === 'query_attempts')!;
    expect(tool.description).toMatch(/\/api\/export\/attempts\?format=jsonl/);
    // Consumer guidance: units, null semantics, no default window.
    expect(tool.description).toMatch(/no default window/i);
    expect(tool.description).toMatch(/NEVER 0/);
    expect(tool.description).toMatch(/get_task_log/);
  });
});

// ---------------------------------------------------------------------------
// get_report
// ---------------------------------------------------------------------------

interface ReportResult {
  kind: string;
  report: Record<string, unknown>;
}

async function restReport(pathAndQuery: string): Promise<unknown> {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const res = await harness.app.inject({
    method: 'GET',
    url: `/api/reports/${pathAndQuery}${sep}from=${WINDOW.from}&to=${WINDOW.to}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('MCP tool get_report', () => {
  it('matches the REST report for every kind', async () => {
    const cases: Array<{ args: Record<string, unknown>; rest: string }> = [
      { args: { kind: 'overview' }, rest: 'overview' },
      { args: { kind: 'timeseries', bucket: 'week' }, rest: 'timeseries?bucket=week' },
      {
        args: { kind: 'leaderboard', group_by: 'model' },
        rest: 'leaderboard?groupBy=model',
      },
      {
        args: { kind: 'durations', group_by: 'harness', metric: 'review' },
        rest: 'durations?groupBy=harness&metric=review',
      },
      { args: { kind: 'funnel' }, rest: 'funnel' },
      { args: { kind: 'reliability' }, rest: 'reliability' },
      { args: { kind: 'heatmap', metric: 'merged' }, rest: 'heatmap?metric=merged' },
    ];

    for (const { args, rest } of cases) {
      const sc = await call<ReportResult>(harness, 'get_report', { ...args, ...WINDOW });
      expect(sc.kind).toBe(args.kind);
      expect(sc.report, `kind=${args.kind}`).toEqual(await restReport(rest));
    }
  });

  it('scopes to the requested repos, like the REST filter', async () => {
    const sc = await call<ReportResult>(harness, 'get_report', {
      kind: 'overview',
      repos: [1],
      ...WINDOW,
    });
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/reports/overview?repos=1&from=${WINDOW.from}&to=${WINDOW.to}`,
    });
    expect(sc.report).toEqual(res.json());
  });

  it('defaults the window to the last DEFAULT_REPORT_WINDOW_DAYS', async () => {
    const { DEFAULT_REPORT_WINDOW_DAYS } = await import('../../constants.js');
    const sc = await call<ReportResult>(harness, 'get_report', { kind: 'timeseries' });
    const range = (sc.report as { range: { from: string; to: string } }).range;
    const spanDays =
      (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
    expect(Math.round(spanDays)).toBe(DEFAULT_REPORT_WINDOW_DAYS);
  });

  it('rejects an unknown kind', async () => {
    const text = await callErr(harness, 'get_report', { kind: 'sparklines' });
    expect(text).toMatch(/^Invalid input: kind must be one of: overview, /);
  });

  it('rejects per-kind options that do not apply', async () => {
    expect(
      await callErr(harness, 'get_report', { kind: 'durations', group_by: 'repo', metric: 'review' })
    ).toMatch(/^Invalid input: group_by must be one of: model, harness for kind=durations/);

    expect(await callErr(harness, 'get_report', { kind: 'leaderboard' })).toMatch(
      /^Invalid input: group_by is required for kind=leaderboard/
    );

    expect(
      await callErr(harness, 'get_report', { kind: 'overview', group_by: 'model' })
    ).toMatch(/^Invalid input: group_by is not accepted for kind=overview/);

    expect(
      await callErr(harness, 'get_report', { kind: 'leaderboard', group_by: 'model', bucket: 'day' })
    ).toMatch(/^Invalid input: bucket is not accepted for kind=leaderboard/);

    expect(
      await callErr(harness, 'get_report', { kind: 'durations', group_by: 'model' })
    ).toMatch(/^Invalid input: metric is required for kind=durations/);

    expect(
      await callErr(harness, 'get_report', { kind: 'timeseries', bucket: 'fortnight' })
    ).toMatch(/^Invalid input: bucket must be one of: day, week/);
  });

  it('documents the analysis workflow for an AI consumer', async () => {
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const report = byName.get('get_report')!.description ?? '';
    expect(report).toMatch(/kind=leaderboard/);
    expect(report).toMatch(/group_by=model/);
    expect(report).toMatch(/query_attempts/);
    expect(report).toMatch(/get_task_log/);
    // Units + null semantics + the default window.
    expect(report).toMatch(/SECONDS/);
    expect(report).toMatch(/NEVER 0/);
    expect(report).toMatch(/90 days/);
    expect(byName.get('get_task_log')!.description ?? '').toMatch(/archive/);
  });
});
