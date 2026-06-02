/**
 * Pure derivation of a task's external-facing status from:
 *   1. The orchestrator's stored `task.status` (runtime execution state)
 *   2. A Forgejo `Snapshot` (issue open/closed, labels, PR state)
 *
 * Design: the stored `task.status` is what the orchestrator *did*; the
 * snapshot is what the human and the remote repo *see right now*. When they
 * disagree, human intent (issue closed, PR merged by hand, `human-*` label
 * applied) wins. This fixes the historical case where a task stays `failed`
 * forever even after the human manually closes the issue.
 *
 * Falling back: when no snapshot is available (Forgejo unreachable, or a
 * snapshot fetch hasn't happened yet), the stored `task.status` is
 * returned verbatim — so the system degrades to pre-derivation behaviour.
 */

import type { Task, TaskStatus } from '@orchestrator/shared';
import { DRIVER_LABELS } from '@orchestrator/shared';
import type { Snapshot } from './forgejo-snapshot.js';

export interface DerivedStatusResult {
  status: TaskStatus;
  /** Why this value was chosen — useful for debugging and task events. */
  reason: string;
  /** True when the derived status overrides the stored `task.status`. */
  overridden: boolean;
}

/**
 * Compute the external-facing status for a task.
 *
 * @param task      The task row as persisted in SQLite.
 * @param snapshot  Fresh-enough Forgejo view, or null if unavailable.
 */
export function deriveStatus(
  task: Task,
  snapshot: Snapshot | null
): DerivedStatusResult {
  const stored = task.status;

  // No snapshot — return stored status verbatim.
  if (!snapshot) {
    return {
      status: stored,
      reason: 'no snapshot available — using stored runtime status',
      overridden: false,
    };
  }

  const { issue, pr } = snapshot;
  const labels = new Set(issue.labels);

  // 1. PR merged is terminal and authoritative — the work landed.
  if (pr?.merged) {
    return decide(
      stored,
      'merged',
      pr.number !== undefined
        ? `PR #${pr.number} merged on Forgejo`
        : 'PR merged on Forgejo'
    );
  }

  // 2. Issue closed (without a merged PR) means the human resolved the task
  //    out of band. Treat as cancelled — this is the #6 case: closing the
  //    issue on Forgejo supersedes a prior local `failed`.
  if (issue.state === 'closed') {
    // If the orchestrator already recorded the outcome as a final state
    // that matches the Forgejo view, prefer that label ('merged' handled
    // above; 'cancelled' stays 'cancelled'). Otherwise treat as cancelled.
    if (stored === 'cancelled') {
      return decide(stored, 'cancelled', 'issue closed on Forgejo');
    }
    return decide(stored, 'cancelled', 'issue closed on Forgejo');
  }

  // 3. Driver labels take effect only while the PR exists — before that the
  //    orchestrator needs to run through its normal queued/preparing path.
  if (pr) {
    if (labels.has(DRIVER_LABELS.HUMAN_MERGE)) {
      return decide(
        stored,
        'awaiting-human-merge',
        `'human-merge' label present — human will merge`
      );
    }
    if (labels.has(DRIVER_LABELS.HUMAN_REVIEW)) {
      return decide(
        stored,
        'awaiting-human-review',
        `'human-review' label present — human will review`
      );
    }

    // 4. PR closed (and not merged) while issue is still open — unusual; the
    //    human probably closed the PR but intends the task to re-run. Treat
    //    as failed so the UI surfaces it for a reset.
    if (pr.state === 'closed' && !pr.merged) {
      return decide(stored, 'failed', `PR #${pr.number} closed without merge`);
    }

    // NOTE: PR mergeability is deliberately *not* a display signal. While the
    // orchestrator is actively driving a task (preparing / in-progress /
    // in-review / changes-needed) it owns conflict resolution: attemptMerge
    // and the conflict-detector route an unmergeable PR back through the
    // rebase/rework loop, and a genuinely stuck conflict surfaces as `failed`
    // once the attempt budget is exhausted. A transient `mergeable === false`
    // — common in the seconds after a push while Forgejo recomputes the merge
    // check — must never masquerade as an `awaiting-human-*` handoff the
    // orchestrator isn't performing. Tasks parked for a human (the label
    // branches above) keep their own status; the human sees any conflict when
    // they open the PR. (An earlier revision escalated unmergeable in-review
    // tasks to `awaiting-human-merge` here, which made tasks flicker to a
    // human-handoff chip mid-review — see status-derivation.test.ts.)
  }

  // 6. No Forgejo override — defer to the orchestrator's stored state. This
  //    covers queued, preparing, in-progress, in-review, changes-needed,
  //    failed (while the issue is still open), reset.
  return {
    status: stored,
    reason: 'stored runtime status (no Forgejo override applies)',
    overridden: false,
  };
}

/**
 * Build a result, flagging `overridden` when the derivation picked a value
 * that differs from what the DB has recorded.
 */
function decide(
  stored: TaskStatus,
  derived: TaskStatus,
  reason: string
): DerivedStatusResult {
  return {
    status: derived,
    reason,
    overridden: derived !== stored,
  };
}
