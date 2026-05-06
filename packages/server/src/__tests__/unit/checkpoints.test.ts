import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../db.js';
import { recordStep, getStep, listStepsForAttempt, runStep } from '../../checkpoints.js';

// ---------------------------------------------------------------------------
// Set up an isolated in-memory database before each test so tests do not
// share state. initDatabase sets the module-level _db used by getDb().
// ---------------------------------------------------------------------------

beforeEach(() => {
  const db = initDatabase(':memory:');
  // repos must exist before tasks (tasks.repo_id references repos.id).
  db.prepare(
    `INSERT INTO repos (id, owner, name, image_type, agent_tool)
     VALUES (1, 'owner', 'repo', 'default', 'tool')`
  ).run();
  // Insert a fake tasks row so that the task_id foreign-key constraint is met.
  db.prepare(
    `INSERT INTO tasks (id, issue_id, repo_id, status, queue_position, max_attempts, prep_failure_count)
     VALUES (1, 100, 1, 'in-progress', 1, 3, 0)`
  ).run();
});

// ---------------------------------------------------------------------------
// runStep — core behaviour
// ---------------------------------------------------------------------------

describe('runStep', () => {
  it('invokes fn on first call and records a row', async () => {
    let calls = 0;
    const result = await runStep(1, 1, 'step-a', () => {
      calls++;
      return 'hello';
    });

    expect(result).toBe('hello');
    expect(calls).toBe(1);
    expect(getStep(1, 1, 'step-a')).toBe('hello');
  });

  it('returns cached result on second call without invoking fn', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return 42;
    };

    await runStep(1, 1, 'step-b', fn);
    const second = await runStep(1, 1, 'step-b', fn);

    expect(second).toBe(42);
    expect(calls).toBe(1);
  });

  it('different step_name values for the same (task_id, attempt) are independent', async () => {
    await runStep(1, 1, 'step-x', () => 'x-result');
    await runStep(1, 1, 'step-y', () => 'y-result');

    expect(getStep(1, 1, 'step-x')).toBe('x-result');
    expect(getStep(1, 1, 'step-y')).toBe('y-result');
  });

  it('different attempt_number values create separate rows', async () => {
    await runStep(1, 1, 'step-c', () => 'attempt-1');
    await runStep(1, 2, 'step-c', () => 'attempt-2');

    expect(getStep(1, 1, 'step-c')).toBe('attempt-1');
    expect(getStep(1, 2, 'step-c')).toBe('attempt-2');
  });

  it('does not record a row when fn throws; subsequent call retries fn', async () => {
    let calls = 0;
    const throwingFn = () => {
      calls++;
      throw new Error('fn failed');
    };

    await expect(runStep(1, 1, 'step-err', throwingFn)).rejects.toThrow('fn failed');
    expect(getStep(1, 1, 'step-err')).toBeUndefined();
    expect(calls).toBe(1);

    // Second call should retry fn, not replay a cached (non-existent) result.
    await expect(runStep(1, 1, 'step-err', throwingFn)).rejects.toThrow('fn failed');
    expect(calls).toBe(2);
  });

  it('round-trips an object', async () => {
    const obj = { a: 1, b: 'two', c: true };
    const result = await runStep(1, 1, 'step-obj', () => obj);
    expect(result).toEqual(obj);
    expect(getStep(1, 1, 'step-obj')).toEqual(obj);
  });

  it('round-trips an array', async () => {
    const arr = [1, 2, 3];
    const result = await runStep(1, 1, 'step-arr', () => arr);
    expect(result).toEqual(arr);
    expect(getStep(1, 1, 'step-arr')).toEqual(arr);
  });

  it('round-trips a string', async () => {
    const result = await runStep(1, 1, 'step-str', () => 'hello world');
    expect(result).toBe('hello world');
  });

  it('round-trips a number', async () => {
    const result = await runStep(1, 1, 'step-num', () => 123.45);
    expect(result).toBe(123.45);
  });

  it('round-trips null', async () => {
    const result = await runStep(1, 1, 'step-null', () => null);
    expect(result).toBeNull();
    expect(getStep(1, 1, 'step-null')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getStep — missing row
// ---------------------------------------------------------------------------

describe('getStep', () => {
  it('returns undefined for a missing row', () => {
    expect(getStep(1, 1, 'nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listStepsForAttempt — ordering
// ---------------------------------------------------------------------------

describe('listStepsForAttempt', () => {
  it('returns rows in insertion order', async () => {
    await runStep(1, 1, 'first', () => 1);
    await runStep(1, 1, 'second', () => 2);
    await runStep(1, 1, 'third', () => 3);

    const steps = listStepsForAttempt(1, 1);
    expect(steps.map((s) => s.name)).toEqual(['first', 'second', 'third']);
    expect(steps.map((s) => s.result)).toEqual([1, 2, 3]);
  });

  it('returns an empty array when no steps have been recorded', () => {
    expect(listStepsForAttempt(1, 99)).toEqual([]);
  });

  it('includes completed_at for each row', async () => {
    await runStep(1, 1, 'ts-step', () => 'done');
    const steps = listStepsForAttempt(1, 1);
    expect(steps).toHaveLength(1);
    expect(typeof steps[0].completed_at).toBe('string');
    expect(steps[0].completed_at.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// recordStep / getStep — direct helpers
// ---------------------------------------------------------------------------

describe('recordStep / getStep', () => {
  it('recordStep persists and getStep retrieves the value', () => {
    recordStep(1, 1, 'direct-step', { key: 'value' });
    expect(getStep(1, 1, 'direct-step')).toEqual({ key: 'value' });
  });

  it('recordStep overwrites an existing row for the same key', () => {
    recordStep(1, 1, 'overwrite-step', 'original');
    recordStep(1, 1, 'overwrite-step', 'updated');
    expect(getStep(1, 1, 'overwrite-step')).toBe('updated');
  });
});
