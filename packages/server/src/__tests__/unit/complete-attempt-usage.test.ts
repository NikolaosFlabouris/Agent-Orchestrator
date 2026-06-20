import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabase,
  insertAttempt,
  getLatestAttempt,
  getDb,
} from '../../db.js';
import { Scheduler } from '../../scheduler.js';
import type { Task, AgentResult } from '@orchestrator/shared';

/** completeAttempt (#115) reads result.json's optional `usage` block and
 *  writes num_turns / input_tokens / output_tokens / tool_calls onto the
 *  attempt row. Usage is an immutable per-run fact — stored, not snapshotted.
 *  When usage is absent the columns stay NULL (unknown, never 0) and the run
 *  finalises exactly as before.
 *
 *  completeAttempt is a private method; we drive it via `as any`. With no
 *  in-memory activeState (fresh process), it takes the recovery branch and
 *  finds the pre-inserted running attempt via getRunningAttempt, then
 *  finalises it. The Scheduler's forgejo/log deps are unused by this method,
 *  so bare stubs suffice. */

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

beforeEach(() => {
  initDatabase(':memory:');
});

describe('completeAttempt — per-run usage persistence', () => {
  it('writes all four usage columns when result.usage is present', async () => {
    const task = seedRunningAttempt();
    const scheduler = makeScheduler();
    const result: AgentResult = {
      status: 'success',
      exit_code: 0,
      usage: {
        num_turns: 12,
        input_tokens: 34_000,
        output_tokens: 5_600,
        tool_calls: 7,
      },
    };

    await (scheduler as unknown as {
      completeAttempt(t: Task, r: AgentResult): Promise<void>;
    }).completeAttempt(task, result);

    const a = getLatestAttempt(1)!;
    expect(a.status).toBe('completed');
    expect(a.num_turns).toBe(12);
    expect(a.input_tokens).toBe(34_000);
    expect(a.output_tokens).toBe(5_600);
    expect(a.tool_calls).toBe(7);
  });

  it('leaves usage columns NULL when result.usage is absent', async () => {
    const task = seedRunningAttempt();
    const scheduler = makeScheduler();
    const result: AgentResult = { status: 'success', exit_code: 0 };

    await (scheduler as unknown as {
      completeAttempt(t: Task, r: AgentResult): Promise<void>;
    }).completeAttempt(task, result);

    const a = getLatestAttempt(1)!;
    expect(a.status).toBe('completed'); // finalises exactly as before
    expect(a.num_turns).toBeNull();
    expect(a.input_tokens).toBeNull();
    expect(a.output_tokens).toBeNull();
    expect(a.tool_calls).toBeNull();
  });

  it('persists only the metrics the harness reported (partial usage)', async () => {
    const task = seedRunningAttempt();
    const scheduler = makeScheduler();
    const result: AgentResult = {
      status: 'success',
      // CLI harness reported turns + tokens but no tool-call count.
      usage: { num_turns: 4, input_tokens: 100, output_tokens: 50 },
    };

    await (scheduler as unknown as {
      completeAttempt(t: Task, r: AgentResult): Promise<void>;
    }).completeAttempt(task, result);

    const a = getLatestAttempt(1)!;
    expect(a.num_turns).toBe(4);
    expect(a.input_tokens).toBe(100);
    expect(a.output_tokens).toBe(50);
    expect(a.tool_calls).toBeNull(); // not reported → stays unknown
  });
});
