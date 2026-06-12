# Task State Machine

## Overview

Every task flows through a well-defined state machine, modeled as exclusive scoped labels on Forgejo issues. The orchestrator is the sole actor that transitions tasks between states. All transitions are logged as comments on the Forgejo issue.

## States

| Label | Description | Terminal? |
|-------|-------------|-----------|
| `status/queued` | Task is ready to be picked up from the queue | No |
| `status/preparing` | Orchestrator has claimed this task and is preparing the workspace (clone, fetch, branch creation) | No |
| `status/in-progress` | Agent container running (dependency install via pre-agent script, then agent works) | No |
| `status/in-review` | Review agent is evaluating changes | No |
| `status/changes-needed` | Review rejected, rework in progress (same slot) | No |
| `status/approved` | Review passed, ready to merge (transient — label not applied, orchestrator merges immediately) | No |
| `status/merged` | PR merged, task complete | Yes |
| `status/failed` | Unrecoverable failure — max attempts exhausted, infrastructure error, or preparation failure | Yes |
| `status/cancelled` | Cancelled by user | Yes |
| *(no label)* | Task reset by user — `status/*` labels removed, issue left open, DB status is `reset` | Yes |
| `status/awaiting-human-merge` | Agent work done, PR left for manual merge (`human-merge` label present) | Yes (from orchestrator's perspective) |
| `status/awaiting-human-review` | Implementation done, waiting for human review (`human-review` label present) | Yes (from orchestrator's perspective) |
| `status/needs-human-review` | Review agent produced unclear verdict | Yes (from orchestrator's perspective) |

Terminal states free the active slot. The issue may remain open in Forgejo (e.g., `awaiting-human-merge`) but the orchestrator considers the task complete and moves on.

## State Transitions

```
                                        ┌──────────────────────────────────────┐
                                        │                                      │
                                        ▼                                      │
queued ──► preparing ──► in-progress ──► in-review ──► approved ──► merged     │
                            ▲                │                                 │
                            │                ▼                                 │
                            │         changes-needed                          │
                            │                │                                 │
                            └────────────────┘                                 │
                            (rework cycle)                                     │
                                                                               │
                                                                 merge conflict┘
                                                                 (treated as rework)
```

### Transition Details

**queued → preparing**
- Trigger: orchestrator's queue fill loop has an empty slot
- Action: assign issue to orchestrator service account, relabel, post comment "Preparing workspace (attempt N)"
- Atomicity: read issue state, verify still queued, update label + assignee, verify update
- If another instance claimed first, the label will have changed — skip and try next
- Orchestrator begins workspace preparation (clone/fetch, branch creation)

**preparing → in-progress**
- Trigger: workspace ready, agent container started
- Action: relabel, post comment "Implementation started (attempt N)"

**preparing → queued** (transient failure)
- Trigger: workspace preparation fails due to a transient error (Forgejo unreachable, network timeout, git clone failure)
- Action: relabel back to `status/queued`, post comment "Workspace preparation failed: {error}. Task returned to queue."
- The attempt counter is NOT incremented — preparation failures are infrastructure issues, not agent failures
- The task becomes eligible for pickup on the next scheduler tick
- A `prep_failure_count` is tracked internally. If preparation fails 3 consecutive times for the same task, transition to `status/failed` instead to avoid infinite retry loops

**preparing → failed** (permanent failure)
- Trigger: workspace preparation fails due to a permanent error (disk full, invalid repo configuration) or exceeds max prep retries
- Action: relabel, post comment with failure details

**in-progress → preparing** (dev agent failure retry, same slot)
- Trigger: dev agent exits with failure or timeout (with no salvageable work) and attempts remain
- Action: relabel, post failure details, immediately restart dev container in same slot
- Attempt counter is incremented. The task does not re-enter the queue.

**in-progress → in-review**
- Trigger: dev agent container exits successfully, orchestrator verifies push / creates PR
- Action: relabel, start review container immediately in the same slot, post comment "Implementation complete. PR #N opened."
- The task holds its slot — the review is not separately queued
- Exception: the review stage resolves its own agent profile, which may target a different provider than the dev run. If that provider's `concurrency_limit` is saturated, the task parks as `in-review` with no container and the scheduler launches the review once a slot frees (same Priority-1 pickup the restart-recovery path uses)

**in-review → approved → merged** (or → awaiting-human-merge)
- Trigger: review agent returns verdict "approved"
- The `status/approved` label is not applied via the API — the state is transient. The orchestrator moves directly to merge (or human-merge handoff) within the same tick.
- If `human-merge` label present: relabel `status/awaiting-human-merge`, free slot
- Otherwise: call `attempt_merge` which relabels to `status/merged` on success or `status/changes-needed` on conflict

**in-review → changes-needed → in-progress** (rework in same slot)
- Trigger: review agent returns verdict "changes_needed" and attempts remain
- Action: relabel, post review feedback as PR comments and issue comment, start dev container immediately in the same slot with rework prompt
- The task does not re-enter the queue. The slot stays occupied through the rework cycle.
- Dev agent receives original task + accumulated review feedback

**in-review → failed** (max attempts exhausted)
- Trigger: review agent returns verdict "changes_needed" but attempt >= max_attempts
- Action: relabel, post failure summary, free slot

**in-review → needs-human-review**
- Trigger: review agent returns verdict "unclear" or review agent fails after retries
- Action: relabel, post comment asking for human intervention
- Slot is freed

**changes-needed → preparing** (orphaned rework only)
- Trigger: task found in `changes-needed` without an active slot (e.g., after orchestrator restart)
- Action: relabel, post comment "Preparing rework (attempt N)"
- These orphaned rework tasks get priority over new `queued` items in the fill_slots loop
- Under normal operation, this transition does not occur — rework happens inline within the slot

**approved → merged**
- Trigger: orchestrator merges PR via Forgejo API
- Action: relabel, close issue, post comment "Merged via PR #N."

**approved → changes-needed** (merge conflict)
- Trigger: merge attempt fails due to conflict
- Action: relabel, post comment "Merge conflict detected. Sending back for rework."
- Task re-enters rework cycle with conflict resolution feedback

**approved → awaiting-human-merge**
- Trigger: `human-merge` label is present on the issue
- Action: relabel, post comment "Review approved. PR #N ready for manual merge."
- Slot is freed

**Any active state → cancelled**
- Trigger: user cancels via UI
- Action: stop container, delete remote branch, close PR, relabel, post comment

**Any active state → failed**
- Trigger: max retry attempts exceeded, or unrecoverable error
- Action: stop container if running, relabel, post failure details as comment

**Terminal state (except merged) → (unqueued)**
- Trigger: user resets task via UI
- Valid from: `failed`, `cancelled`, `awaiting-human-merge`, `awaiting-human-review`, `needs-human-review`
- Not valid from: `merged` (the code is already in main — resetting would not undo the merge)
- Action: stop container if running, delete remote branch, close PR if open, delete workspace, remove `status/*` label, reset attempt counter and prep failure count, post comment "Task reset by user."
- The issue returns to a clean state in Forgejo with no `status/*` label. It can be re-queued later via the UI.
- This is a destructive operation — all agent work, branches, and PRs for this task are deleted.

## Attempt Tracking

Each task has an attempt counter that increments on each dev agent cycle (initial implementation + each rework). The counter is used for:

- Determining when to give up (`attempt >= max_attempts` → `status/failed`)
- Providing context in commit messages and comments
- Branch naming remains constant across attempts (agent pushes to same branch)

**Important:** orchestrator restarts do not count against the attempt budget. On restart, the orchestrator examines the actual state of each in-flight task — checking for exited containers with results, pushed branches, and local workspace changes — and recovers appropriately rather than discarding work. See [05 - Orchestrator Core](./05-orchestrator-core.md) for the full startup recovery logic.

## Override Labels

### human-merge

When present on an issue, the orchestrator completes the full agent workflow (implementation + review) but does not merge the PR. Instead, the task transitions to `status/awaiting-human-merge` and the slot is freed. The PR remains open for manual merge by a human.

### human-review

When present on an issue, the orchestrator completes implementation and creates the PR but does not launch the review agent. The task transitions to `status/awaiting-human-review` and the slot is freed. A human reviews the PR manually.

## Rework Handling

Under normal operation, rework happens inline within the task's active slot. When the review agent returns `changes_needed`, the orchestrator immediately starts a new dev container in the same slot — the task never re-enters the queue.

If a task is found in `status/changes-needed` without an active slot (e.g., after an orchestrator restart or recovery), it enters the queue with priority over new `queued` items. These orphaned rework tasks are picked up first because they're partially complete, have a PR open, and represent closer-to-done work.

## Dependency Gating

Before a queued task can be picked up, the orchestrator checks its dependencies (parsed from checklist items in the issue body). If any referenced issue is still open, the task is skipped and remains in the queue. The queue fill loop tries the next candidate.

```
fill_slots:
  for each candidate in queue (rework first, then FIFO):
    deps = extract_dependencies(candidate.issue_body)
    if not check_dependencies_met(deps):
      skip — leave in queue, try next
    launch task
```

## Issue Comment Audit Trail

Every orchestrator action is logged as an issue comment:

| Event | Comment Template |
|-------|-----------------|
| Workspace preparing | "Task claimed. Preparing workspace (attempt {N})." |
| Implementation started | "Implementation started (attempt {N})." |
| Implementation complete | "Implementation complete (attempt {N}). Changes pushed to branch `{branch}`. PR #{pr} opened." |
| Review started | "Review started (attempt {N})." |
| Review approved | "Review passed. Merging PR #{pr}." |
| Review rejected | "Review found issues (attempt {N}). Sending back for rework.\n\n{feedback_summary}" |
| Merge conflict | "Merge conflict against {base_branch}. Sending back for resolution." |
| Merged | "Merged via PR #{pr}. Closing issue." |
| Failed | "Failed after {N} attempts. Last error: {detail}" |
| Cancelled | "Task cancelled: {reason}. Branch and PR cleaned up." |
| Human merge deferred | "Review approved. PR #{pr} is ready for manual merge. Label `human-merge` detected." |
| Orchestrator recovered | "Orchestrator recovered after restart. {recovery_action_taken}" |
