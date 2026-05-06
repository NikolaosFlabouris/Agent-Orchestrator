import { getDb } from './db.js';

// ---------------------------------------------------------------------------
// Step-checkpoint helpers
//
// These helpers record the result of named, idempotent operations within a
// task attempt so that a restarted orchestrator can skip work that already
// completed rather than re-running it.
// ---------------------------------------------------------------------------

/** Write a completed step result to the database. */
export function recordStep(
  taskId: number,
  attempt: number,
  name: string,
  result: unknown
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO task_steps (task_id, attempt_number, step_name, result_json)
       VALUES (?, ?, ?, ?)`
    )
    .run(taskId, attempt, name, JSON.stringify(result));
}

/** Return the parsed result of a previously recorded step, or undefined if not found. */
export function getStep<T = unknown>(
  taskId: number,
  attempt: number,
  name: string
): T | undefined {
  const row = getDb()
    .prepare(
      'SELECT result_json FROM task_steps WHERE task_id = ? AND attempt_number = ? AND step_name = ?'
    )
    .get(taskId, attempt, name) as { result_json: string } | undefined;

  return row ? (JSON.parse(row.result_json) as T) : undefined;
}

/** Return all recorded steps for a (task_id, attempt_number) pair, in insertion order. */
export function listStepsForAttempt(
  taskId: number,
  attempt: number
): { name: string; result: unknown; completed_at: string }[] {
  const rows = getDb()
    .prepare(
      'SELECT step_name, result_json, completed_at FROM task_steps WHERE task_id = ? AND attempt_number = ? ORDER BY id ASC'
    )
    .all(taskId, attempt) as { step_name: string; result_json: string; completed_at: string }[];

  return rows.map((r) => ({
    name: r.step_name,
    result: JSON.parse(r.result_json),
    completed_at: r.completed_at,
  }));
}

/**
 * Execute fn and persist the result, or return the cached result if the step
 * already completed. The result must be JSON-serialisable.
 *
 * If fn throws, no row is written and the error propagates to the caller.
 */
export async function runStep<T>(
  taskId: number,
  attempt: number,
  name: string,
  fn: () => Promise<T> | T
): Promise<T> {
  const cached = getStep<T>(taskId, attempt, name);
  if (cached !== undefined) {
    return cached;
  }

  const result = await fn();
  recordStep(taskId, attempt, name, result);
  return result;
}
