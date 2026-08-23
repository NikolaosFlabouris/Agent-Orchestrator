import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb, getAttemptsExport } from '../../db.js';
import type { ExportAttemptRow, ExportAttemptsFilter } from '@orchestrator/shared';

/** getAttemptsExport() — the raw attempt-history export behind
 *  `GET /api/export/attempts`.
 *
 *  The fixture deliberately covers the awkward cases the aggregate report
 *  queries never have to face:
 *    - an attempt from 2023, i.e. far outside the reports' default window
 *      (the export must return it when no from/to is given)
 *    - both stored timestamp shapes (datetime('now') space form and
 *      toISOString()), so duration derivation is exercised across them
 *    - a still-running attempt (no completed_at → null duration)
 *    - unknown usage (NULL) alongside a real 0 exit code, which must NOT
 *      be conflated
 *    - a model_id snapshot that matches NO model row (harness-prefixed),
 *      and one that matches TWO (same model_id under two providers) —
 *      the latter must resolve to one row, never duplicate the attempt.
 */

// All-history filter: both bounds open, exactly what the route passes when
// the caller supplies neither `from` nor `to`.
const ALL: ExportAttemptsFilter = { repos: null, from: null, to: null };

/** Surrogate PK of the 'shared-model' row under a given provider. */
function modelPk(provider: string): number {
  return (
    getDb()
      .prepare(
        `SELECT id FROM models WHERE provider_id = ? AND model_id = 'shared-model'`
      )
      .get(provider) as { id: number }
  ).id;
}

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (1, 'o', 'r1')`).run();
  db.prepare(`INSERT INTO repos (id, owner, name) VALUES (2, 'o', 'r2')`).run();

  // Same model_id under two providers — only the agent_profile's harness
  // can disambiguate them. OpenAI inserted first, so it is the fallback
  // (lowest models.id) when the harness matches no profile.
  const insertModel = db.prepare(
    `INSERT INTO models (provider_id, model_id, display_name) VALUES (?, ?, ?)`
  );
  insertModel.run('openai', 'shared-model', 'OpenAI Shared');
  insertModel.run('anthropic', 'shared-model', 'Anthropic Shared');
  db.prepare(
    `INSERT INTO agent_profiles (id, display_name, harness_id, model_pk)
     VALUES ('oc-shared', 'OC Shared', 'opencode', ?)`
  ).run(modelPk('anthropic'));

  const task = db.prepare(
    `INSERT INTO tasks
       (id, issue_id, issue_title, repo_id, branch_name, pr_number, status,
        attempt, max_attempts, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const attempt = db.prepare(
    `INSERT INTO attempts
       (task_id, attempt_number, role, status, verdict, started_at, completed_at,
        feedback, model_id, harness_id, timeout_minutes_snapshot,
        num_turns, input_tokens, output_tokens, tool_calls,
        changed_files, additions, deletions, error_message, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // T1 — merged, repo 1, January 2025. created_at in the space form.
  task.run(1, 101, 'First task', 1, 'agent/issue-101', 11, 'merged', 2, 7,
    '2025-01-05T00:10:00.000Z', '2025-01-06T00:00:00.000Z', '2025-01-05 00:00:00');
  // A1 — develop, 3600s, full usage, exit_code 0 (a REAL zero).
  attempt.run(1, 1, 'develop', 'completed', null,
    '2025-01-05T10:00:00.000Z', '2025-01-05T11:00:00.000Z',
    null, 'claude-sonnet-4-6', 'claude-sdk', 120,
    12, 1000, 500, 7, null, null, null, null, 0);
  // A2 — review, 1800s, mixed timestamp formats, PR churn, feedback blob.
  attempt.run(1, 1, 'review', 'completed', 'approved',
    '2025-01-05 12:00:00', '2025-01-05T12:30:00.000Z',
    '{"verdict":"approved"}', 'claude-sonnet-4-6', 'claude-sdk', 120,
    4, 200, 100, 2, 3, 40, 5, null, 0);

  // T2 — repo 2, mid-2023: far outside the reports default window.
  task.run(2, 202, 'Old task', 2, null, null, 'failed', 1, 7,
    '2023-06-01T08:00:00.000Z', '2023-06-01T09:30:00.000Z', '2023-06-01 07:00:00');
  // A3 — failed, harness-prefixed model_id that matches no model row, all
  // usage unknown (NULL), non-zero exit code + error message.
  attempt.run(2, 1, 'develop', 'failed', null,
    '2023-06-01T08:00:00.000Z', '2023-06-01T09:00:00.000Z',
    null, 'openrouter/qwen-3-coder', 'opencode', 60,
    null, null, null, null, null, null, null, 'agent exited non-zero', 137);

  // T3 — repo 1, February 2025, still running.
  task.run(3, 303, 'Live task', 1, 'agent/issue-303', null, 'in-progress', 1, 7,
    '2025-02-01T00:00:00.000Z', null, '2025-02-01 00:00:00');
  // A4 — running: no completed_at → null duration. Harness matches the
  // 'oc-shared' profile, so the ambiguous model_id resolves to Anthropic.
  attempt.run(3, 1, 'develop', 'running', null,
    '2025-02-01T00:00:00.000Z', null,
    null, 'shared-model', 'opencode', 90,
    null, null, null, null, null, null, null, null, null);
  // A5 — same ambiguous model_id but a harness no profile uses: falls back
  // to the lowest-id model row (OpenAI).
  attempt.run(3, 1, 'review', 'failed', null,
    '2025-02-01T01:00:00.000Z', '2025-02-01T01:15:00.000Z',
    null, 'shared-model', 'claude-code', 90,
    null, null, null, null, null, null, null, null, null);
}

/** attempt_ids in returned order. */
function ids(rows: ExportAttemptRow[]): number[] {
  return rows.map((r) => r.attempt_id);
}

describe('getAttemptsExport', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    seed();
  });

  it('returns ALL history when no from/to is given, ordered by attempt_id', () => {
    const rows = getAttemptsExport(ALL);
    // Includes the 2023 attempt — no DEFAULT_REPORT_WINDOW_DAYS fallback.
    expect(ids(rows)).toEqual([1, 2, 3, 4, 5]);
  });

  it('emits the documented flat field contract', () => {
    const [a1] = getAttemptsExport(ALL);
    expect(a1).toEqual({
      attempt_id: 1,
      task_id: 1,
      attempt_number: 1,
      role: 'develop',
      status: 'completed',
      started_at: '2025-01-05T10:00:00.000Z',
      completed_at: '2025-01-05T11:00:00.000Z',
      duration_seconds: 3600,
      model_id: 'claude-sonnet-4-6',
      harness_id: 'claude-sdk',
      timeout_minutes_snapshot: 120,
      verdict: null,
      num_turns: 12,
      input_tokens: 1000,
      output_tokens: 500,
      tool_calls: 7,
      changed_files: null,
      additions: null,
      deletions: null,
      exit_code: 0,
      error_message: null,
      issue_id: 101,
      issue_title: 'First task',
      task_status: 'merged',
      task_attempt: 2,
      max_attempts: 7,
      pr_number: 11,
      branch_name: 'agent/issue-101',
      task_created_at: '2025-01-05T00:00:00.000Z',
      task_started_at: '2025-01-05T00:10:00.000Z',
      task_completed_at: '2025-01-06T00:00:00.000Z',
      repo_id: 1,
      repo_owner: 'o',
      repo_name: 'r1',
      provider_id: 'anthropic',
      model_display_name: 'Claude Sonnet 4.6',
    });
  });

  it('derives duration across both stored timestamp formats, null when open-ended', () => {
    const byId = new Map(getAttemptsExport(ALL).map((r) => [r.attempt_id, r]));
    expect(byId.get(2)!.duration_seconds).toBe(1800); // space form → ISO form
    expect(byId.get(3)!.duration_seconds).toBe(3600);
    expect(byId.get(4)!.duration_seconds).toBeNull(); // still running
    expect(byId.get(5)!.duration_seconds).toBe(900);
  });

  it('keeps NULL as null and never coerces it to 0', () => {
    const a3 = getAttemptsExport(ALL).find((r) => r.attempt_id === 3)!;
    expect(a3.num_turns).toBeNull();
    expect(a3.input_tokens).toBeNull();
    expect(a3.output_tokens).toBeNull();
    expect(a3.tool_calls).toBeNull();
    expect(a3.changed_files).toBeNull();
    expect(a3.additions).toBeNull();
    expect(a3.deletions).toBeNull();
    expect(a3.pr_number).toBeNull();
    // …while a genuine 0 survives as 0 (A1's clean exit).
    expect(a3.exit_code).toBe(137);
    expect(getAttemptsExport(ALL)[0].exit_code).toBe(0);
  });

  it('joins the repo onto every row', () => {
    const a3 = getAttemptsExport(ALL).find((r) => r.attempt_id === 3)!;
    expect(a3.repo_id).toBe(2);
    expect(a3.repo_owner).toBe('o');
    expect(a3.repo_name).toBe('r2');
  });

  it('resolves model/provider where it can and nulls them where it cannot', () => {
    const byId = new Map(getAttemptsExport(ALL).map((r) => [r.attempt_id, r]));
    // Harness-prefixed snapshot matches no model row.
    expect(byId.get(3)!.provider_id).toBeNull();
    expect(byId.get(3)!.model_display_name).toBeNull();
    // Ambiguous model_id disambiguated by the attempt's harness…
    expect(byId.get(4)!.provider_id).toBe('anthropic');
    expect(byId.get(4)!.model_display_name).toBe('Anthropic Shared');
    // …and falling back to the first matching model row otherwise.
    expect(byId.get(5)!.provider_id).toBe('openai');
    expect(byId.get(5)!.model_display_name).toBe('OpenAI Shared');
  });

  it('never multiplies rows when a model_id matches several model rows', () => {
    const rows = getAttemptsExport({ ...ALL, model: 'shared-model' });
    expect(ids(rows)).toEqual([4, 5]);
  });

  it('omits feedback by default and includes it on request', () => {
    const withoutFeedback = getAttemptsExport(ALL)[1];
    expect('feedback' in withoutFeedback).toBe(false);

    const rows = getAttemptsExport(ALL, { includeFeedback: true });
    expect(rows[1].feedback).toBe('{"verdict":"approved"}');
    // Attempts with no feedback report null, not undefined.
    expect(rows[0].feedback).toBeNull();
  });

  describe('filters', () => {
    it('narrows by repo', () => {
      expect(ids(getAttemptsExport({ ...ALL, repos: [1] }))).toEqual([1, 2, 4, 5]);
      expect(ids(getAttemptsExport({ ...ALL, repos: [2] }))).toEqual([3]);
      expect(ids(getAttemptsExport({ ...ALL, repos: [1, 2] }))).toEqual([
        1, 2, 3, 4, 5,
      ]);
    });

    it('narrows by from (inclusive) / to (exclusive) on the attempt start', () => {
      expect(
        ids(
          getAttemptsExport({
            ...ALL,
            from: '2025-01-01T00:00:00.000Z',
            to: '2025-02-01T00:00:00.000Z',
          })
        )
      ).toEqual([1, 2]);
      // Open lower bound: everything before February.
      expect(
        ids(getAttemptsExport({ ...ALL, from: null, to: '2025-02-01T00:00:00.000Z' }))
      ).toEqual([1, 2, 3]);
      // Open upper bound: everything from 2025 on.
      expect(
        ids(getAttemptsExport({ ...ALL, from: '2025-01-01T00:00:00.000Z', to: null }))
      ).toEqual([1, 2, 4, 5]);
    });

    it('narrows by model, harness, role and status', () => {
      expect(ids(getAttemptsExport({ ...ALL, model: 'claude-sonnet-4-6' }))).toEqual([1, 2]);
      expect(ids(getAttemptsExport({ ...ALL, harness: 'opencode' }))).toEqual([3, 4]);
      expect(ids(getAttemptsExport({ ...ALL, role: 'review' }))).toEqual([2, 5]);
      expect(ids(getAttemptsExport({ ...ALL, status: 'running' }))).toEqual([4]);
      expect(ids(getAttemptsExport({ ...ALL, status: 'failed' }))).toEqual([3, 5]);
    });

    it('combines filters conjunctively', () => {
      expect(
        ids(getAttemptsExport({ ...ALL, repos: [1], role: 'review', status: 'failed' }))
      ).toEqual([5]);
      expect(
        ids(getAttemptsExport({ ...ALL, harness: 'opencode', role: 'review' }))
      ).toEqual([]);
    });
  });

  it('streams every row exactly once across batch boundaries', () => {
    // batchSize 2 over 5 rows: three round-trips, last one short.
    expect(ids(getAttemptsExport(ALL, { batchSize: 2 }))).toEqual([1, 2, 3, 4, 5]);
    // An exact multiple of the batch size must not loop forever or repeat.
    expect(ids(getAttemptsExport({ ...ALL, repos: [1] }, { batchSize: 2 }))).toEqual([
      1, 2, 4, 5,
    ]);
    expect(ids(getAttemptsExport(ALL, { batchSize: 1 }))).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(getAttemptsExport({ ...ALL, model: 'no-such-model' })).toEqual([]);
  });
});
