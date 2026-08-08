import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabase,
  insertAttempt,
  getLatestAttempt,
  getDb,
} from '../../db.js';
import { Scheduler } from '../../scheduler.js';
import type { Task, AgentResult } from '@orchestrator/shared';

/** completeAttempt (#174) persists the failure reason the harness reports in
 *  result.json — `error_message` and `exit_code` — onto the attempt row, so
 *  Task Detail can answer "why did this attempt fail" instead of showing a
 *  bare `failed` badge. Successful runs record neither: there is no reason,
 *  and their exit code (0) carries no information.
 *
 *  Same driving pattern as complete-attempt-usage.test.ts: the method is
 *  private, so it's invoked via a cast; with no in-memory activeState it
 *  takes the recovery branch, finds the pre-inserted running attempt, and
 *  finalises it. The Scheduler's forgejo/log deps are unused here. */

function makeScheduler(): Scheduler {
  return new Scheduler({} as never, { info() {}, warn() {}, error() {} } as never);
}

function seedRunningAttempt(): Task {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r')`).run();
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, attempt, max_attempts, prep_failure_count)
     VALUES (1, 100, 1, 'in-progress', 1, 3, 0)`
  ).run();
  insertAttempt({
    task_id: 1,
    attempt_number: 1,
    role: 'develop',
    status: 'running',
    model_id: 'claude-sonnet-4-6',
    harness_id: 'claude-sdk',
  });
  return db.prepare('SELECT * FROM tasks WHERE id = 1').get() as Task;
}

async function complete(result: AgentResult): Promise<void> {
  const task = seedRunningAttempt();
  await (
    makeScheduler() as unknown as {
      completeAttempt(t: Task, r: AgentResult): Promise<void>;
    }
  ).completeAttempt(task, result);
}

beforeEach(() => {
  initDatabase(':memory:');
});

describe('completeAttempt — failure reason persistence', () => {
  it('stores the message and exit code of a failed run', async () => {
    await complete({
      status: 'failure',
      exit_code: 137,
      error_message: 'Agent process was killed (OOM)',
    });

    const a = getLatestAttempt(1)!;
    expect(a.status).toBe('failed');
    expect(a.error_message).toBe('Agent process was killed (OOM)');
    expect(a.exit_code).toBe(137);
  });

  it('stores the reason for a timed-out run too', async () => {
    await complete({
      status: 'timeout',
      exit_code: 124,
      error_message: 'Run exceeded 30m',
    });

    const a = getLatestAttempt(1)!;
    expect(a.status).toBe('timeout');
    expect(a.error_message).toBe('Run exceeded 30m');
    expect(a.exit_code).toBe(124);
  });

  it('leaves unreported fields NULL rather than inventing a reason', async () => {
    // A harness that writes only `status` gives us nothing to show; the UI
    // must render no failure line at all, so the columns stay unknown.
    await complete({ status: 'failure' });

    const a = getLatestAttempt(1)!;
    expect(a.status).toBe('failed');
    expect(a.error_message).toBeNull();
    expect(a.exit_code).toBeNull();
  });

  it('records nothing on a successful run', async () => {
    await complete({ status: 'success', exit_code: 0 });

    const a = getLatestAttempt(1)!;
    expect(a.status).toBe('completed');
    expect(a.error_message).toBeNull();
    // Not 0: a success has no failure exit code worth surfacing.
    expect(a.exit_code).toBeNull();
  });
});
