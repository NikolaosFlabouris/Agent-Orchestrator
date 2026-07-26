import { describe, it, expect } from 'vitest';
import type { Task, TaskStatus } from '@orchestrator/shared';
import { deriveStatus } from '../../status-derivation.js';
import type { Snapshot } from '../../forgejo-snapshot.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 6,
    issue_title: 'Test issue title',
    repo_id: 1,
    branch_name: null,
    pr_number: null,
    status: 'queued' as TaskStatus,
    queue_position: null,
    attempt: 1,
    max_attempts: 3,
    prep_failure_count: 0,
    prep_backoff_level: 0,
    prep_next_attempt_at: null,
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface SnapOverrides {
  issue?: Partial<Snapshot['issue']>;
  pr?: Partial<NonNullable<Snapshot['pr']>> | null;
}

function snap(overrides: SnapOverrides): Snapshot {
  const base: Snapshot = {
    issue: { state: 'open', labels: [] },
    pr: null,
    fetched_at: Date.now(),
  };
  if (overrides.issue) base.issue = { ...base.issue, ...overrides.issue };
  if (overrides.pr === null) base.pr = null;
  else if (overrides.pr) {
    base.pr = {
      number: 10,
      state: 'open',
      merged: false,
      mergeable: true,
      draft: false,
      ...overrides.pr,
    };
  }
  return base;
}

describe('deriveStatus', () => {
  describe('no snapshot', () => {
    it('falls back to stored status verbatim', () => {
      const task = makeTask({ status: 'failed' });
      const result = deriveStatus(task, null);
      expect(result.status).toBe('failed');
      expect(result.overridden).toBe(false);
    });
  });

  describe('PR merged', () => {
    it('overrides any stored status to merged', () => {
      const task = makeTask({ status: 'in-review', pr_number: 10 });
      const snapshot = snap({ pr: { merged: true, state: 'closed' } });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('merged');
    });

    it('keeps merged if stored matches (not overridden)', () => {
      const task = makeTask({ status: 'merged', pr_number: 10 });
      const snapshot = snap({ pr: { merged: true, state: 'closed' } });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('merged');
      expect(result.overridden).toBe(false);
    });
  });

  describe('issue closed out-of-band (the #6 case)', () => {
    it('overrides failed → cancelled when issue is closed', () => {
      const task = makeTask({ status: 'failed' });
      const snapshot = snap({ issue: { state: 'closed' } });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('cancelled');
      expect(result.overridden).toBe(true);
      expect(result.reason).toMatch(/issue closed/);
    });

    it('overrides in-progress → cancelled when issue is closed', () => {
      const task = makeTask({ status: 'in-progress' });
      const snapshot = snap({ issue: { state: 'closed' } });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('cancelled');
    });

    it('does not override when the issue is still open', () => {
      const task = makeTask({ status: 'failed' });
      const snapshot = snap({ issue: { state: 'open' } });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('failed');
      expect(result.overridden).toBe(false);
    });

    it('prefers "merged" over "cancelled" when PR is also merged', () => {
      const task = makeTask({ status: 'failed', pr_number: 10 });
      const snapshot = snap({
        issue: { state: 'closed' },
        pr: { merged: true, state: 'closed' },
      });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('merged');
    });
  });

  describe('driver labels', () => {
    it('overrides to awaiting-human-merge when human-merge label is set and PR exists', () => {
      const task = makeTask({ status: 'in-review', pr_number: 10 });
      const snapshot = snap({
        issue: { labels: ['human-merge'] },
        pr: { state: 'open' },
      });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('awaiting-human-merge');
    });

    it('overrides to awaiting-human-review when human-review label is set and PR exists', () => {
      const task = makeTask({ status: 'in-review', pr_number: 10 });
      const snapshot = snap({
        issue: { labels: ['human-review'] },
        pr: { state: 'open' },
      });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('awaiting-human-review');
    });

    it('ignores driver labels when no PR exists yet', () => {
      const task = makeTask({ status: 'in-progress' });
      const snapshot = snap({ issue: { labels: ['human-merge'] } });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('in-progress');
    });

    it('ignores unknown labels (arbitrary user tags do not steer derivation)', () => {
      const task = makeTask({ status: 'in-review', pr_number: 10 });
      const snapshot = snap({
        issue: { labels: ['priority/high', 'needs-triage', 'frontend'] },
        pr: { state: 'open' },
      });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('in-review');
    });
  });

  describe('unmergeable PR is not a display signal', () => {
    // The orchestrator owns conflict resolution (attemptMerge + the
    // conflict-detector route an unmergeable PR back through rebase/rework,
    // and a stuck conflict ends up `failed`). A momentary `mergeable: false`
    // — common right after a push while Forgejo recomputes — must not flip an
    // actively-driven task to a human-handoff chip.
    it('keeps in-review when the PR reports unmergeable', () => {
      const task = makeTask({ status: 'in-review', pr_number: 10 });
      const snapshot = snap({ pr: { state: 'open', mergeable: false } });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('in-review');
      expect(result.overridden).toBe(false);
    });

    it('keeps changes-needed when the PR reports unmergeable (mid-rebase)', () => {
      const task = makeTask({ status: 'changes-needed', pr_number: 10 });
      const snapshot = snap({ pr: { state: 'open', mergeable: false } });
      expect(deriveStatus(task, snapshot).status).toBe('changes-needed');
    });

    it('treats unknown mergeability (null) the same — no override', () => {
      const task = makeTask({ status: 'in-review', pr_number: 10 });
      const snapshot = snap({ pr: { state: 'open', mergeable: null } });
      expect(deriveStatus(task, snapshot).status).toBe('in-review');
    });

    it('leaves awaiting-human-merge as-is rather than re-deriving it', () => {
      const task = makeTask({ status: 'awaiting-human-merge', pr_number: 10 });
      const snapshot = snap({ pr: { state: 'open', mergeable: false } });
      expect(deriveStatus(task, snapshot).status).toBe('awaiting-human-merge');
    });

    it('does not hide a human-review handoff behind an unmergeable PR', () => {
      // human-review label present + unmergeable PR: the human still needs to
      // review, so the chip must stay awaiting-human-review (the old rule
      // wrongly rewrote this to awaiting-human-merge).
      const task = makeTask({ status: 'awaiting-human-review', pr_number: 10 });
      const snapshot = snap({
        issue: { labels: ['human-review'] },
        pr: { state: 'open', mergeable: false },
      });
      expect(deriveStatus(task, snapshot).status).toBe('awaiting-human-review');
    });

    it('does not escalate queued — the orchestrator has not started yet', () => {
      const task = makeTask({ status: 'queued', pr_number: 10 });
      const snapshot = snap({ pr: { state: 'open', mergeable: false } });
      expect(deriveStatus(task, snapshot).status).toBe('queued');
    });
  });

  describe('PR closed without merge', () => {
    it('surfaces as failed so the UI prompts a reset', () => {
      const task = makeTask({ status: 'in-review', pr_number: 10 });
      const snapshot = snap({
        pr: { state: 'closed', merged: false },
      });
      const result = deriveStatus(task, snapshot);
      expect(result.status).toBe('failed');
    });
  });

  describe('positive runtime states pass through', () => {
    const passthroughStates: TaskStatus[] = [
      'queued',
      'preparing',
      'in-progress',
      'in-review',
      'changes-needed',
    ];

    for (const state of passthroughStates) {
      it(`keeps ${state} when Forgejo state is benign`, () => {
        const task = makeTask({ status: state, pr_number: 10 });
        const snapshot = snap({ pr: { state: 'open' } });
        const result = deriveStatus(task, snapshot);
        expect(result.status).toBe(state);
      });
    }
  });

  describe('reason field', () => {
    it('mentions the PR number when available', () => {
      const task = makeTask({ status: 'in-review', pr_number: 42 });
      const snapshot = snap({ pr: { number: 42, merged: true, state: 'closed' } });
      const result = deriveStatus(task, snapshot);
      expect(result.reason).toContain('42');
    });
  });
});
