/**
 * Run-artifact archiving (issue #190).
 *
 * Workspaces are swept after WORKSPACE_RETENTION_DAYS; the four small text
 * artifacts an attempt produces have to outlive them or historical log
 * analysis becomes impossible. These tests pin the four properties that
 * matter:
 *
 *   - what gets copied (exactly four names, log gzipped, nothing else),
 *   - that a missing optional file is normal, not an error,
 *   - that a failed archive VETOES the workspace delete for that cycle,
 *   - that the log keeps being servable after the workspace is gone.
 *
 * Both roots are temp dirs: `constants.js` is mocked so ARCHIVE_ROOT and
 * WORKSPACES_ROOT point inside `os.tmpdir()`, and `workspace.js` path helpers
 * are re-implemented against the temp workspaces root. Nothing touches
 * /workspaces or /data.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { Task } from '@orchestrator/shared';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-archive-'));
const WORKSPACES = path.join(tmpRoot, 'workspaces');
const ARCHIVE = path.join(tmpRoot, 'archive');

vi.mock('../../constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../constants.js')>();
  return { ...actual, WORKSPACES_ROOT: WORKSPACES, ARCHIVE_ROOT: ARCHIVE };
});

// Mirror the real helpers (repo-scoped workspace name, `.output` / `.task`
// subdirs) against the temp root — the production ones close over the real
// WORKSPACES_ROOT at import time.
vi.mock('../../workspace.js', () => ({
  getWorkdir: (task: Task) =>
    path.join(WORKSPACES, `${task.repo_id}-issue-${task.issue_id}`),
  getOutputDir: (task: Task) =>
    path.join(WORKSPACES, `${task.repo_id}-issue-${task.issue_id}`, '.output'),
  getTaskDir: (task: Task) =>
    path.join(WORKSPACES, `${task.repo_id}-issue-${task.issue_id}`, '.task'),
}));

const {
  archiveTaskArtifacts,
  readTaskLog,
  getArchiveDir,
  getArchivedLogPath,
} = await import('../../archive.js');
const { cleanupOldWorkspaces } = await import('../../cleanup.js');
const { initDatabase, insertTask, insertAttempt, getAttempts, updateTaskRaw, getDb } =
  await import('../../db.js');
const { getWorkdir, getOutputDir, getTaskDir } = await import('../../workspace.js');
const { createTaskRoutes } = await import('../../routes/tasks.js');

const warnings: Array<Record<string, unknown>> = [];
const testLog = {
  info: () => {},
  warn: (obj: Record<string, unknown>) => {
    warnings.push(obj);
  },
  error: () => {},
  debug: () => {},
} as unknown as FastifyBaseLogger;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Seed a task plus a populated workspace. `files` overrides which artifacts
 *  exist; `undefined` means "not produced by this attempt". */
async function seedTask(
  issueId: number,
  files: {
    progress?: string;
    result?: string;
    review?: string;
    meta?: string;
    extra?: string;
  } = {}
): Promise<Task> {
  const task = insertTask({ issue_id: issueId, repo_id: 1, status: 'merged' });
  const outputDir = getOutputDir(task);
  const taskDir = getTaskDir(task);
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.mkdir(taskDir, { recursive: true });

  if (files.progress !== undefined)
    await fsp.writeFile(path.join(outputDir, 'progress.log'), files.progress);
  if (files.result !== undefined)
    await fsp.writeFile(path.join(outputDir, 'result.json'), files.result);
  if (files.review !== undefined)
    await fsp.writeFile(path.join(outputDir, 'review.json'), files.review);
  // meta.json is written into `.task/`, not `.output/` (see writeTaskFiles).
  if (files.meta !== undefined)
    await fsp.writeFile(path.join(taskDir, 'meta.json'), files.meta);
  if (files.extra !== undefined)
    await fsp.writeFile(path.join(outputDir, 'huge-artifact.bin'), files.extra);

  return task;
}

/** Backdate a task past the retention window so pass 1 picks it up. */
function makeSweepable(taskId: number): void {
  updateTaskRaw(taskId, {
    completed_at: new Date(Date.now() - 30 * MS_PER_DAY).toISOString(),
  });
}

beforeEach(async () => {
  initDatabase(':memory:');
  getDb()
    .prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'owner', 'repo1')`)
    .run();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  await fsp.mkdir(WORKSPACES, { recursive: true });
  warnings.length = 0;
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('archiveTaskArtifacts', () => {
  it('copies the four artifacts, gzipping only the log, and nothing else', async () => {
    const task = await seedTask(7, {
      progress: 'line one\nline two\n',
      result: '{"status":"success"}',
      review: '{"verdict":"approved"}',
      meta: '{"role":"develop"}',
      extra: 'x'.repeat(1024),
    });

    await archiveTaskArtifacts(task, testLog);

    const dir = getArchiveDir(task);
    expect(dir).toBe(path.join(ARCHIVE, '1', 'issue-7'));
    const entries = (await fsp.readdir(dir)).sort();
    expect(entries).toEqual([
      'meta.json',
      'progress.log.gz',
      'result.json',
      'review.json',
    ]);

    // The log round-trips through gzip; the JSON files stay plain text.
    expect(gunzipSync(await fsp.readFile(path.join(dir, 'progress.log.gz'))).toString()).toBe(
      'line one\nline two\n'
    );
    expect(await fsp.readFile(path.join(dir, 'result.json'), 'utf-8')).toBe(
      '{"status":"success"}'
    );
    expect(await fsp.readFile(path.join(dir, 'meta.json'), 'utf-8')).toBe(
      '{"role":"develop"}'
    );
  });

  it('tolerates missing optional files', async () => {
    // No review.json (a dev-only attempt) and no meta.json.
    const task = await seedTask(8, { progress: 'log', result: '{}' });

    await expect(archiveTaskArtifacts(task, testLog)).resolves.toBeDefined();

    const entries = (await fsp.readdir(getArchiveDir(task))).sort();
    expect(entries).toEqual(['progress.log.gz', 'result.json']);
  });

  it('creates no archive directory when the workspace holds nothing', async () => {
    const task = await seedTask(9);

    const archived = await archiveTaskArtifacts(task, testLog);

    expect(archived).toEqual([]);
    expect(fs.existsSync(getArchiveDir(task))).toBe(false);
  });

  it('is idempotent — re-archiving overwrites with the current files', async () => {
    const task = await seedTask(10, { progress: 'first', result: '{"n":1}' });
    await archiveTaskArtifacts(task, testLog);

    await fsp.writeFile(path.join(getOutputDir(task), 'progress.log'), 'second');
    await fsp.writeFile(path.join(getOutputDir(task), 'result.json'), '{"n":2}');
    await archiveTaskArtifacts(task, testLog);

    const dir = getArchiveDir(task);
    expect(gunzipSync(await fsp.readFile(path.join(dir, 'progress.log.gz'))).toString()).toBe(
      'second'
    );
    expect(await fsp.readFile(path.join(dir, 'result.json'), 'utf-8')).toBe('{"n":2}');
    // No `.partial` scratch files left behind.
    expect((await fsp.readdir(dir)).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('re-points every attempt of the task at the archived log', async () => {
    const task = await seedTask(11, { progress: 'log' });
    const live = path.join(getOutputDir(task), 'progress.log');
    insertAttempt({ task_id: task.id, attempt_number: 1, role: 'develop', status: 'completed' });
    insertAttempt({ task_id: task.id, attempt_number: 1, role: 'review', status: 'completed' });
    for (const attempt of getAttempts(task.id)) {
      expect(attempt.log_path).toBeNull();
    }

    await archiveTaskArtifacts(task, testLog);

    for (const attempt of getAttempts(task.id)) {
      expect(attempt.log_path).toBe(getArchivedLogPath(task));
      expect(attempt.log_path).not.toBe(live);
    }
  });

  it('throws when the archive destination is unusable', async () => {
    const task = await seedTask(12, { progress: 'log' });
    // A plain file where the per-repo archive directory belongs — mkdir -p
    // fails with ENOTDIR, the same shape as a full or read-only volume.
    await fsp.mkdir(ARCHIVE, { recursive: true });
    await fsp.writeFile(path.join(ARCHIVE, '1'), 'not a directory');

    await expect(archiveTaskArtifacts(task, testLog)).rejects.toThrow();
  });
});

describe('cleanupOldWorkspaces archiving', () => {
  it('archives before deleting a swept workspace', async () => {
    const task = await seedTask(20, {
      progress: 'swept log',
      result: '{"status":"success"}',
      meta: '{"role":"review"}',
    });
    makeSweepable(task.id);

    await cleanupOldWorkspaces(testLog);

    expect(fs.existsSync(getWorkdir(task))).toBe(false);
    const dir = getArchiveDir(task);
    expect((await fsp.readdir(dir)).sort()).toEqual([
      'meta.json',
      'progress.log.gz',
      'result.json',
    ]);
    expect(gunzipSync(await fsp.readFile(path.join(dir, 'progress.log.gz'))).toString()).toBe(
      'swept log'
    );
  });

  it('keeps the workspace and warns when archiving fails', async () => {
    const task = await seedTask(21, { progress: 'must not be lost' });
    makeSweepable(task.id);
    await fsp.mkdir(ARCHIVE, { recursive: true });
    await fsp.writeFile(path.join(ARCHIVE, '1'), 'not a directory');

    await cleanupOldWorkspaces(testLog);

    expect(fs.existsSync(getWorkdir(task))).toBe(true);
    expect(fs.existsSync(path.join(getOutputDir(task), 'progress.log'))).toBe(true);
    expect(warnings.some((w) => w.event === 'artifacts_archive_failed')).toBe(true);

    // Next cycle, with the destination usable again, completes the sweep.
    await fsp.rm(path.join(ARCHIVE, '1'));
    await cleanupOldWorkspaces(testLog);
    expect(fs.existsSync(getWorkdir(task))).toBe(false);
    expect(fs.existsSync(getArchivedLogPath(task))).toBe(true);
  });

  it('leaves tasks inside the retention window alone', async () => {
    const task = await seedTask(22, { progress: 'fresh' });
    updateTaskRaw(task.id, { completed_at: new Date().toISOString() });

    await cleanupOldWorkspaces(testLog);

    expect(fs.existsSync(getWorkdir(task))).toBe(true);
    expect(fs.existsSync(getArchiveDir(task))).toBe(false);
  });
});

describe('readTaskLog', () => {
  async function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
    if (!stream) throw new Error('expected a stream');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  }

  it('prefers the live workspace copy', async () => {
    const task = await seedTask(30, { progress: 'live copy' });
    await archiveTaskArtifacts(task, testLog);
    // Archive holds a stale copy; the workspace is authoritative while it exists.
    await fsp.writeFile(path.join(getOutputDir(task), 'progress.log'), 'newer live copy');

    expect(await collect(await readTaskLog(task))).toBe('newer live copy');
  });

  it('falls back to the gunzipped archive once the workspace is gone', async () => {
    const task = await seedTask(31, { progress: 'archived copy\n'.repeat(500) });
    await archiveTaskArtifacts(task, testLog);
    await fsp.rm(getWorkdir(task), { recursive: true, force: true });

    expect(await collect(await readTaskLog(task))).toBe('archived copy\n'.repeat(500));
  });

  it('returns null when the log exists in neither place', async () => {
    const task = await seedTask(32);

    expect(await readTaskLog(task)).toBeNull();
  });
});

describe('GET /api/tasks/:id/log', () => {
  const fakeForgejo = {} as unknown as ForgejoClient;
  const fakeScheduler = { triggerTick: () => {} } as unknown as Scheduler;

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(createTaskRoutes(fakeForgejo, fakeScheduler));
    await app.ready();
    return app;
  }

  it('serves the workspace log, then the archive, then 404s', async () => {
    const task = await seedTask(40, { progress: 'hello from the workspace' });
    const app = await buildApp();

    const live = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/log` });
    expect(live.statusCode).toBe(200);
    expect(live.headers['content-type']).toContain('text/plain');
    expect(live.body).toBe('hello from the workspace');

    await archiveTaskArtifacts(task, testLog);
    await fsp.rm(getWorkdir(task), { recursive: true, force: true });

    const archived = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/log` });
    expect(archived.statusCode).toBe(200);
    expect(archived.headers['content-type']).toContain('text/plain');
    expect(archived.body).toBe('hello from the workspace');

    await fsp.rm(getArchiveDir(task), { recursive: true, force: true });
    const gone = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/log` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('Log not found');

    const missingTask = await app.inject({ method: 'GET', url: '/api/tasks/9999/log' });
    expect(missingTask.statusCode).toBe(404);
    expect(missingTask.json().error).toBe('Task not found');

    await app.close();
  });
});

describe('ARCHIVE_ROOT', () => {
  it('defaults under /data and is env-overridable like DB_PATH', async () => {
    const original = process.env.ARCHIVE_ROOT;
    try {
      vi.resetModules();
      delete process.env.ARCHIVE_ROOT;
      const plain = await vi.importActual<typeof import('../../constants.js')>(
        '../../constants.js'
      );
      expect(plain.ARCHIVE_ROOT).toBe('/data/archive');

      vi.resetModules();
      process.env.ARCHIVE_ROOT = '/tmp/custom-archive-root';
      const overridden = await vi.importActual<typeof import('../../constants.js')>(
        '../../constants.js'
      );
      expect(overridden.ARCHIVE_ROOT).toBe('/tmp/custom-archive-root');
    } finally {
      if (original === undefined) delete process.env.ARCHIVE_ROOT;
      else process.env.ARCHIVE_ROOT = original;
      vi.resetModules();
    }
  });
});
