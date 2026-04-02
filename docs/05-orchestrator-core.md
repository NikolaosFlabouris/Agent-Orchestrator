# Orchestrator Core

## Overview

The orchestrator is a single long-running Node.js process that manages the complete task lifecycle. It is the sole consumer of the Forgejo REST API (for PRs, merges, labels, and issue management), the sole manager of agent containers, and the single source of truth for runtime state. Agents interact with Forgejo only via git fetch/push using a restricted credential. The orchestrator exposes a REST API and WebSocket endpoints consumed by the web UI.

## Main Loop

The orchestrator runs a single event-driven loop:

```
on TICK (triggered by: webhook event, container exit callback, or 60-second fallback poll):

  1. Check for completed containers
     For each completed container:
       - Read /output/result.json from workspace bind mount
       - Read role from /task/meta.json
       - If role == 'develop': call on_dev_agent_complete(task, result)
         If role == 'review': call on_review_agent_complete(task, result)
       - Remove container
       (Slot freeing is handled within the post-agent flow, not here — the flow
       decides whether to free the slot or start the next phase in the same slot.)

  2. Fill empty slots (synchronous — runs within the tick)
     While active_count < max_concurrency AND candidates remain:
       - Take next item from priority order:
         a. Tasks in 'in-review' with no container (recovery: need review container started)
         b. Orphaned rework (status/changes-needed with no active slot)
         c. FIFO queue (status/queued by queue_position)
       - For queued tasks: check dependency gate; skip if deps not met
       - Call launch_dev_container(task) or launch_review_container(task) based on status
         (workspace preparation, task file assembly, and container creation all happen
         synchronously within this step — the slot is occupied from this point onward)
       - active_count++
```

## Queue Model

The queue is a priority FIFO with a configurable concurrency limiter:

```
┌──────────────────────────────────────────────────────────┐
│  ORPHANED REWORK (priority over new tasks)               │
│  Tasks in status/changes-needed that are NOT in an       │
│  active slot (e.g., found after orchestrator restart).   │
│  Ordered by age. This tier is normally empty.            │
├──────────────────────────────────────────────────────────┤
│  QUEUE (FIFO)                                            │
│  Tasks in status/queued, ordered by queue_position (ASC) │
├──────────────────────────────────────────────────────────┤
│  ACTIVE SLOTS (max_concurrency configurable via UI)      │
│  Tasks currently running (preparing, implementing,       │
│  reviewing, reworking, or merging)                       │
└──────────────────────────────────────────────────────────┘
```

### Queue Position

`queue_position` uses sparse integer ordering. New tasks are assigned `MAX(queue_position) + 1`. When a task leaves the queue (starts processing, is cancelled, fails, or is reset), its position is cleared — remaining positions are not renumbered. Gaps are harmless since ordering uses `ORDER BY queue_position ASC`. Drag-and-drop reordering in the UI swaps position values between the dragged task and the target position.

### Slot Lifecycle

A task occupies a single slot for its entire active lifecycle, including rework cycles. The full in-slot loop is:

```
preparing → in-progress → in-review ─┬─► approved → merged (free slot)
                ▲                     │
                │                     ▼
                └──── changes-needed ─┘
                      (rework: same slot, new dev container)
```

The slot is only freed when the task leaves the dev→review→rework loop:

| Transition | Slot freed? |
|---|---|
| `preparing → in-progress` | No — same slot |
| `in-progress → in-review` | No — review container starts immediately |
| `in-review → changes-needed → in-progress` | No — rework dev container starts immediately |
| `in-review → approved → merged` | Yes — task complete |
| `→ awaiting-human-merge/review` | Yes — orchestrator's work is done |
| `→ needs-human-review` | Yes — unclear verdict, needs human |
| `→ failed` or `→ cancelled` | Yes — terminal |

Neither the review nor the rework is separately queued. When the dev container exits, the review starts in the same slot. When the review returns `changes_needed`, the next dev container starts in the same slot. The task holds its slot through the entire cycle until it merges, fails, or requires human intervention.

### Orphaned Rework Tasks

The rework tier in the queue exists only for tasks found in `status/changes-needed` that are not in an active slot. This happens when the orchestrator restarts while a task was mid-cycle — startup recovery may place it back in the queue as `changes-needed`. These orphaned rework tasks get priority over new `queued` items because they're partially complete and closer to done. Under normal operation, this tier is empty.

## Git Operations

The orchestrator and agents have separate git responsibilities. Agents perform git fetch, commit, and push within their containers using a restricted credential. The orchestrator handles everything else (PR creation, merge, branch deletion) via the Forgejo REST API.

**Forgejo API client convention:** all `forgejo.*` functions accept a `repo` object (from `db.getRepo()`) and extract `repo.owner` and `repo.name` internally for API path construction (e.g., `/api/v1/repos/{owner}/{name}/branches/{branch}`). The pseudocode uses `forgejo.get_branch(repo, branch_name)` rather than `forgejo.get_branch(repo.owner, repo.name, branch_name)` for brevity.

### Workspace Preparation (before agent)

Branch names are generated deterministically by the orchestrator when a task is first created:

```
task.branch_name = "agent/issue-{issue_id}-{sanitized_title}"

# sanitized_title: lowercase, spaces to hyphens, strip non-alphanumeric,
# truncate to 50 chars, no trailing hyphens
# Example: "agent/issue-42-add-login-validation"
```

The `agent/` prefix ensures all agent branches fall under the namespace that branch protection allows the agent credential to push to. The branch name is stored in the DB and remains constant across all attempts for the same task.

```
prepare_workspace(task):
  repo = db.getRepo(task.repo_id)
  workdir = /workspaces/issue-{task.issue_id}/

  if workdir does not exist:
    git clone {agent_auth_url} workdir
  else:
    # Workspace exists from a previous attempt or before a restart.
    # Ensure the remote URL has the current agent token — the token may
    # have been rotated since this workspace was created.
    git -C workdir remote set-url origin {agent_auth_url}

  if task.attempt == 1:
    # New task: create branch from latest base
    git -C workdir fetch origin {repo.base_branch}
    git -C workdir checkout -B {task.branch_name} origin/{repo.base_branch}

  else:
    # Rework: checkout the existing branch as-is.
    # The agent is responsible for fetching latest base and rebasing/merging.
    # This avoids the orchestrator silently discarding agent work on conflicts.
    verify_workspace_state(task)
    try:
      git -C workdir checkout {task.branch_name}
    catch:
      # Local branch is missing or corrupt — recreate from remote
      try:
        git -C workdir fetch origin {task.branch_name}
        git -C workdir checkout -B {task.branch_name} origin/{task.branch_name}
        log warn "task={task.issue_id} event=rework_branch_restored reason=local_branch_missing"
      catch:
        # Remote branch also gone — unrecoverable
        log error "task={task.issue_id} event=rework_branch_lost reason=not_on_local_or_remote"
        raise  # Caught by prep failure handler
```

On first attempt, the orchestrator creates a fresh branch from the latest base. On rework, it simply checks out the existing branch — the agent's prompt instructs it to fetch latest main and rebase as its first step, resolving any conflicts as part of the implementation cycle.

### Workspace Preparation Failure Handling

Preparation failures (clone timeout, Forgejo unreachable, git errors) are transient infrastructure issues, not agent failures. They should not consume an attempt:

```
try:
  prepare_workspace(task)
catch error:
  task.prep_failure_count++

  if task.prep_failure_count >= 3:
    # Permanent failure — stop retrying
    relabel: status/failed
    forgejo.comment_on_issue(task.issue_id,
      "Workspace preparation failed 3 times. Last error: {error}. Marking as failed.")
    log error "task={task.issue_id} event=prep_failed_permanent error={error}"
  else:
    # Transient failure — return to queue for retry
    relabel: status/queued
    forgejo.comment_on_issue(task.issue_id,
      "Workspace preparation failed: {error}. Task returned to queue (attempt not incremented).")
    log warn "task={task.issue_id} event=prep_failed_transient error={error} retry={task.prep_failure_count}"

  free slot
  return
```

The `prep_failure_count` resets to zero when preparation succeeds. This prevents infinite retry loops while allowing recovery from brief network outages.

### Workspace State Verification

Agents have full Bash and git access. They can leave the workspace in broken states — mid-rebase, mid-merge conflict, detached HEAD, or on the wrong branch. Before any post-agent git operation, the orchestrator restores the workspace to a known state:

```
verify_workspace_state(task):
  workdir = /workspaces/issue-{task.issue_id}/

  # Abort any in-progress rebase the agent left behind
  if exists(workdir/.git/rebase-merge) or exists(workdir/.git/rebase-apply):
    git -C workdir rebase --abort
    log warn "task={task.issue_id} event=rebase_aborted reason=agent_left_mid_rebase"

  # Abort any in-progress merge conflict
  if exists(workdir/.git/MERGE_HEAD):
    git -C workdir merge --abort
    log warn "task={task.issue_id} event=merge_aborted reason=agent_left_mid_merge"

  # Ensure we're on the expected branch (agent may have checked out something else)
  current_branch = git -C workdir branch --show-current
  if current_branch != task.branch_name:
    try:
      git -C workdir checkout {task.branch_name}
    catch:
      # Branch doesn't exist locally — recreate from remote if possible
      git -C workdir fetch origin {task.branch_name}
      git -C workdir checkout -B {task.branch_name} origin/{task.branch_name}
    log warn "task={task.issue_id} event=branch_restored expected={task.branch_name} found={current_branch}"
```

This runs before `post_dev_agent` and before rework workspace preparation.

### Post-Agent Verification (after dev agent)

The agent is expected to commit and push its work. The orchestrator verifies this happened and creates the PR. If the agent didn't push (crash, timeout, or oversight), the orchestrator salvages local work as a fallback. Returns `true` if a PR is ready for review, `false` if the task was marked as failed (caller should not continue).

```
post_dev_agent(task) -> boolean:
  repo = db.getRepo(task.repo_id)
  issue = forgejo.get_issue(repo, task.issue_id)  # fetches title on demand
  workdir = /workspaces/issue-{task.issue_id}/

  verify_workspace_state(task)

  # Primary check: did the agent push the expected branch?
  branch_exists = forgejo.get_branch(repo, task.branch_name)
    # GET /api/v1/repos/{owner}/{repo}/branches/{branch}
    # Returns 200 if branch exists, 404 if not

  if branch_exists:
    # Agent pushed successfully. Verify the remote is ahead of base.
    # The Forgejo API provides the branch's latest commit SHA.
    base_sha = forgejo.get_branch(repo, repo.base_branch).commit.sha
    if branch_exists.commit.sha == base_sha:
      relabel: status/failed
      forgejo.comment_on_issue(task.issue_id, "No changes produced — branch matches base.")
      db.update_task(task.id, status: 'failed')
      free slot
      return false

  else:
    # Check if the agent pushed to a different branch name by mistake.
    # The orchestrator generates branch names with a deterministic prefix: agent/issue-{id}-
    # If a branch matching this prefix exists but doesn't match task.branch_name, log a warning.
    expected_prefix = "agent/issue-{task.issue_id}-"
    repo_branches = forgejo.list_branches(repo)
    unexpected = [b for b in repo_branches if b.name.startsWith(expected_prefix)
                  and b.name != task.branch_name]
    if unexpected:
      log warn "Agent may have pushed to unexpected branch: {unexpected[0].name} "
               "(expected {task.branch_name}). Ignoring — will salvage from local workspace."
    # Agent did not push. Check if there's local work to salvage.
    #
    # Three checks cover all cases:
    #   has_uncommitted  — modified or staged tracked files
    #   has_untracked    — new files the agent created but never git-added
    #   has_commits      — local commits ahead of what's on the remote base
    has_uncommitted = NOT (git -C workdir diff --quiet AND git -C workdir diff --cached --quiet)
    has_untracked = git -C workdir ls-files --others --exclude-standard is non-empty
    has_commits = git -C workdir log origin/{repo.base_branch}..HEAD --oneline is non-empty

    if NOT has_uncommitted AND NOT has_untracked AND NOT has_commits:
      relabel: status/failed
      forgejo.comment_on_issue(task.issue_id, "No changes produced by agent.")
      db.update_task(task.id, status: 'failed')
      free slot
      return false

    # Salvage: commit anything uncommitted, then push.
    # Uses the agent credential already configured on the workspace remote.
    if has_uncommitted OR has_untracked:
      git -C workdir add -A
      git -C workdir commit -m "feat: {issue.title}

      Automated implementation for issue #{task.issue_id}
      Attempt: {task.attempt}
      (Committed by orchestrator — agent did not push)"

    git -C workdir push -f origin {task.branch_name}
    if push fails:
      retry once
      if still fails:
        log error "task={task.issue_id} event=salvage_push_failed error={error}"
        relabel: status/failed
        forgejo.comment_on_issue(task.issue_id,
          "Salvage push failed: {error}. Local work preserved in workspace.")
        db.update_task(task.id, status: 'failed')
        free slot
        # The workspace is NOT deleted — the user can inspect it or reset the task.
        return false

  # Create or update PR via Forgejo API (uses orchestrator token, not workspace credential)
  try:
    if task.pr_number is null:
      pr = forgejo.create_pull_request(
        title: issue.title,
        head: task.branch_name,
        base: repo.base_branch,
        body: "Automated PR for #{task.issue_id}\n\nCloses #{task.issue_id}"
      )
      task.pr_number = pr.number
    else:
      forgejo.comment_on_pr(task.pr_number,
        "Branch updated with rework changes (attempt {task.attempt})")
  catch error:
    log error "task={task.issue_id} event=pr_creation_failed error={error}"
    relabel: status/failed
    forgejo.comment_on_issue(task.issue_id,
      "Failed to create PR: {error}. Branch exists on remote — use Reset to retry.")
    db.update_task(task.id, status: 'failed')
    free slot
    return false

  return true
```

### Pre-Merge Freshness Check

```
attempt_merge(task):
  repo = db.getRepo(task.repo_id)
  # Verify PR is still mergeable
  pr = forgejo.get_pull_request(task.pr_number)
  if pr.mergeable == false:
    if task.attempt >= task.max_attempts:
      relabel: status/failed
      post comment: "PR not mergeable after {max_attempts} attempts."
      free slot
      return
    # Rework in same slot — task needs to rebase against updated base
    task.attempt++
    relabel: status/changes-needed
    post comment: "Base branch has moved. Sending back for rebase (attempt {task.attempt})."
    launch_dev_container(task, feedback: "Rebase onto latest {repo.base_branch}.")
    return

  try:
    result = forgejo.merge_pull_request(
      pr_number: task.pr_number,
      merge_type: db.getSetting('merge_strategy')  # squash, merge, or rebase
    )
  catch error:
    # Unexpected merge error (404 PR deleted, 405 permission, network failure, etc.)
    log error "task={task.issue_id} event=merge_failed error={error}"
    relabel: status/failed
    forgejo.comment_on_issue(task.issue_id,
      "Merge failed unexpectedly: {error}. PR #{task.pr_number} may need manual attention.")
    free slot
    return

  if result.success:
    forgejo.replace_label(task.issue_id, add: 'status/merged')
    forgejo.close_issue(task.issue_id)
    forgejo.comment_on_issue(task.issue_id, "Merged via PR #{task.pr_number}.")
    free slot

  elif result.conflict:
    if task.attempt >= task.max_attempts:
      relabel: status/failed
      post comment: "Merge conflict after {max_attempts} attempts."
      free slot
      return
    # Rework in same slot — task needs to resolve merge conflicts
    task.attempt++
    relabel: status/changes-needed
    forgejo.comment_on_issue(task.issue_id,
      "Merge conflict against {repo.base_branch}. Sending back for resolution (attempt {task.attempt}).")
    launch_dev_container(task, feedback: "Resolve conflicts with {repo.base_branch}.")
```

## Container Launch Helpers

These are the concrete steps behind `launch_dev_container` and `launch_review_container` used in the post-agent flows and the main loop's fill_slots.

### launch_dev_container(task, feedback)

Starts a dev agent container in the task's current slot. Used for initial implementation and rework cycles.

```
launch_dev_container(task, feedback=null):
  repo = db.getRepo(task.repo_id)
  issue = forgejo.get_issue(repo, task.issue_id)
  workdir = /workspaces/issue-{task.issue_id}/
  outputDir = workdir + '/.output'

  # 1. Archive previous attempt's output (if any) before overwriting
  if exists(outputDir + '/result.json'):
    # Find the most recent attempt row to name the archive
    prev = db.getLatestAttempt(task.id)  # latest completed attempt
    if prev:
      archiveDir = outputDir + '/archive/attempt-' + prev.attempt_number + '-' + prev.role
      mkdir -p archiveDir
      mv outputDir/result.json archiveDir/
      mv outputDir/progress.log archiveDir/ (if exists)
      mv outputDir/review.json archiveDir/ (if exists)
      # Update the attempt row's log_path to point to the archived location
      db.update_attempt(prev.id, log_path: archiveDir + '/progress.log')

  # 2. Ensure workspace is in a clean git state
  verify_workspace_state(task)

  # 3. Prepare workspace (clone if new, checkout branch)
  prepare_workspace(task)

  # 3. Assemble task files
  # prompt.md is the complete prompt. If feedback is present (rework cycle),
  # it is included in prompt.md via the template's "Review Feedback" section.
  # The harness reads prompt.md and passes it directly — no separate feedback file.
  write /task/prompt.md from dev agent prompt template with {issue.body, repo, task, feedback}
  # Resolve per-task → per-repo → global settings for configurable fields
  effective_tool_id = task.agent_tool || repo.agent_tool
  effective_tool = db.getAgentTool(effective_tool_id)
  effective_model = task.model || repo.model || db.getSetting('default_model')
  effective_max_turns = repo.max_turns || db.getSetting('default_max_turns')
  effective_timeout = repo.timeout_minutes || db.getSetting('agent_timeout_minutes')
  effective_command = effective_tool.command_template || ''  # empty for SDK tools

  write /task/meta.json with {
    issue_id, branch_name, base_branch: repo.base_branch,
    max_runtime_minutes: effective_timeout,
    attempt: task.attempt, role: "develop",
    pr_number, model: effective_model, max_turns: effective_max_turns,
    pre_agent_script: repo.pre_agent_script,
    agent_tool: effective_tool_id, agent_command: effective_command
  }

  # 4. Create and start container
  container = createAgentContainer(task, repo)
  container.start()
  db.update_task(task.id, container_id: container.id, started_at: now())

  # 5. Record attempt
  start_attempt(task, 'develop')

  relabel: status/in-progress
  forgejo.comment_on_issue(task.issue_id,
    "Implementation started (attempt {task.attempt}).")
  log info "task={task.issue_id} event=dev_container_started attempt={task.attempt}"
```

### launch_review_container(task)

Starts a review agent container in the task's current slot. Called immediately after dev agent verification succeeds.

```
launch_review_container(task):
  repo = db.getRepo(task.repo_id)
  issue = forgejo.get_issue(repo, task.issue_id)
  workdir = /workspaces/issue-{task.issue_id}/
  outputDir = workdir + '/.output'

  # 1. Archive previous attempt's output (same logic as launch_dev_container)
  if exists(outputDir + '/result.json'):
    prev = db.getLatestAttempt(task.id)
    if prev:
      archiveDir = outputDir + '/archive/attempt-' + prev.attempt_number + '-' + prev.role
      mkdir -p archiveDir
      mv outputDir/result.json archiveDir/
      mv outputDir/progress.log archiveDir/ (if exists)
      mv outputDir/review.json archiveDir/ (if exists)
      db.update_attempt(prev.id, log_path: archiveDir + '/progress.log')

  # 2. Record branch SHA before review (to detect if review agent modifies it)
  task.pre_review_sha = forgejo.get_branch(repo, task.branch_name).commit.sha

  # 2. Resolve configuration (same resolution order as launch_dev_container)
  effective_tool_id = task.agent_tool || repo.agent_tool
  effective_tool = db.getAgentTool(effective_tool_id)
  effective_model = task.model || repo.model || db.getSetting('default_model')
  effective_max_turns = repo.max_turns || db.getSetting('default_max_turns')
  effective_timeout = repo.timeout_minutes || db.getSetting('agent_timeout_minutes')
  effective_command = effective_tool.command_template || ''

  # 3. Assemble task files
  write /task/prompt.md from review agent prompt template with {issue.body, repo}
  write /task/meta.json with {
    issue_id, branch_name, base_branch: repo.base_branch,
    max_runtime_minutes: effective_timeout,
    attempt: task.attempt, role: "review",
    pr_number: task.pr_number, model: effective_model, max_turns: effective_max_turns,
    pre_agent_script: repo.pre_agent_script,
    agent_tool: effective_tool_id, agent_command: effective_command
  }

  # 3. Create and start container
  container = createAgentContainer(task, repo)
  container.start()
  db.update_task(task.id, container_id: container.id)

  # 4. Record attempt
  start_attempt(task, 'review')

  relabel: status/in-review
  forgejo.comment_on_issue(task.issue_id,
    "Review started (attempt {task.attempt}).")
  log info "task={task.issue_id} event=review_container_started attempt={task.attempt}"
```

## Attempt Tracking

An `attempts` row is created when a container starts and updated when it exits. The row ID is held in memory on the task object (`task.current_attempt_id`) for the duration of the container's lifecycle.

```
start_attempt(task, role):
  # Called when a dev or review container is started
  attempt_id = db.insert_attempt(
    task_id: task.id,
    attempt_number: task.attempt,
    role: role,             # 'develop' or 'review'
    status: 'running',
    started_at: now()
  )
  task.current_attempt_id = attempt_id  # in-memory only, not persisted in tasks table
  return attempt_id

complete_attempt(task, result):
  # Called when the container exits, before post-agent flows
  record_attempt_cost(task, result)

  # Read review verdict if this was a review attempt
  verdict = null
  feedback = null
  if exists(/output/review.json):
    review = JSON.parse(read /output/review.json)
    verdict = review.verdict
    feedback = JSON.stringify(review.feedback)

  db.update_attempt(task.current_attempt_id,
    status: result.status,         # 'success', 'failure', 'timeout'
    completed_at: now(),
    verdict: verdict,              # null for dev attempts, 'approved'/'changes_needed'/'unclear' for review
    log_path: '/workspaces/issue-{task.issue_id}/.output/progress.log',
    feedback: feedback             # review feedback JSON, null for dev attempts
  )
```

On orchestrator restart, `task.current_attempt_id` is lost (it's in-memory). If recovery processes results from an exited container, it looks up the attempt row by `(task_id, attempt_number, role)` with `status = 'running'` and updates it. If no matching row exists (the orchestrator crashed before creating it), recovery creates a new attempt row.

## Cost Tracking

### Token Usage Source

The Anthropic API returns token usage with every response. The harness captures cumulative usage across all turns of an agent session and writes it to `result.json`:

```json
{
  "status": "success",
  "exit_code": 0,
  "usage": {
    "input_tokens": 125000,
    "output_tokens": 8500,
    "model": "claude-sonnet-4-20250514"
  }
}
```

How each harness captures usage:

| Harness | Source | Notes |
|---|---|---|
| SDK (TypeScript) | Agent SDK `query()` returns messages with `usage` fields. Sum `input_tokens` and `output_tokens` across all messages. | The SDK tracks cumulative usage automatically. |
| CLI (Claude Code) | `--output-format stream-json` emits JSON events with usage. Parse the final event for cumulative totals. | The `--bare` flag ensures clean JSON output. |
| CLI (OpenCode, local LLM) | Not available — local LLM servers don't report token usage in a standard format. | Usage fields are null. Cost is recorded as zero. |

The `model` field in usage captures the actual model used (e.g., `claude-sonnet-4-20250514`) which may include the full version string. The orchestrator normalizes this to match the pricing table keys.

### Model Pricing

Default pricing is hardcoded in the orchestrator and can be overridden via the Settings UI. Stored in the `settings` table as a JSON value under the key `model_pricing`:

```json
{
  "claude-sonnet-4": { "input_per_mtok": 3.00, "output_per_mtok": 15.00 },
  "claude-opus-4": { "input_per_mtok": 5.00, "output_per_mtok": 25.00 },
  "claude-haiku-4": { "input_per_mtok": 1.00, "output_per_mtok": 5.00 }
}
```

Keys use the model family name without the date suffix (e.g., `claude-sonnet-4` not `claude-sonnet-4-20250514`). The orchestrator strips the date suffix from the `usage.model` field when looking up pricing. If no match is found, cost is recorded as zero with a warning logged.

Pricing is non-secret configuration, so storing it in the `settings` table is appropriate.

### Cost Calculation

After each agent container exits, the orchestrator computes cost from the usage and pricing:

```
record_attempt_cost(task, result):
  if result.usage AND result.usage.input_tokens:
    model_key = normalize_model_name(result.usage.model)
      # "claude-sonnet-4-20250514" → "claude-sonnet-4"
    pricing = get_model_pricing(model_key)

    if pricing is null:
      log warn "task={task.issue_id} event=unknown_model_pricing model={result.usage.model}"
      cost_usd = 0
    else:
      cost_usd = (result.usage.input_tokens * pricing.input_per_mtok / 1_000_000)
               + (result.usage.output_tokens * pricing.output_per_mtok / 1_000_000)

    db.update_attempt(task.current_attempt_id,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      model: result.usage.model,
      cost_usd: cost_usd
    )
```

### Cost Queries

```sql
-- Total cost for a task (all attempts)
SELECT SUM(cost_usd) FROM attempts WHERE task_id = ?

-- Daily cost
SELECT SUM(cost_usd) FROM attempts WHERE date(completed_at) = date('now')

-- Cost by model (for the settings/analytics view)
SELECT model, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
       SUM(cost_usd) as total_cost
FROM attempts WHERE date(completed_at) = date('now') GROUP BY model
```

## Post-Agent Flows

### After Dev Agent

```
on_dev_agent_complete(task, result):
  complete_attempt(task, result)  # updates attempt row: status, completed_at, cost

  if result.status == "success":
    # post_dev_agent verifies push, salvages if needed, creates/updates PR.
    # Returns true if a PR is ready for review, false if the task was marked as failed.
    if post_dev_agent(task):
      forgejo.comment_on_issue(task.issue_id,
        "Implementation complete (attempt {task.attempt}).")
      continue_to_review(task)
    # If post_dev_agent returned false, it already marked the task as failed and freed the slot.

  if result.status == "timeout":
    # Check if the agent produced usable work before timing out.
    # post_dev_agent handles salvage — returns true if work was saved and PR is ready.
    if post_dev_agent(task):
      forgejo.comment_on_issue(task.issue_id,
        "Agent timed out but partial work was salvaged (attempt {task.attempt}).")
      continue_to_review(task)
    else:
      # post_dev_agent found no work and marked the task as failed,
      # OR it found work but salvage push failed. Either way, check if we should retry.
      # Only retry if the task wasn't already marked as failed by post_dev_agent.
      if task.status != 'failed':
        handle_dev_failure(task, "Agent timed out with no salvageable work")

  if result.status == "failure":
    handle_dev_failure(task, result.error_message or "Agent exited with failure status (exit code {result.exit_code})")


continue_to_review(task):
  if "human-review" label present:
    relabel: status/awaiting-human-review
    free slot
  else:
    # Start review immediately in the same slot — no queuing.
    # launch_review_container handles relabelling, SHA recording, and container start.
    launch_review_container(task)


handle_dev_failure(task, error_detail):
  task.attempt++
  if task.attempt >= task.max_attempts:
    # Max attempts exhausted.
    relabel: status/failed
    forgejo.comment_on_issue(task.issue_id,
      "Task failed after {task.max_attempts} attempts. "
      "Last error: {error_detail}. Use the Reset action to retry from scratch.")
    db.update_task(task.id, status: 'failed')
    free slot
    log error "task={task.issue_id} event=attempts_exhausted attempts={task.max_attempts}"
  else:
    # Retry in the same slot — no re-queuing.
    post failure details as issue comment:
      "Dev agent failed (attempt {task.attempt}/{task.max_attempts}): {error_detail}. Retrying."
    relabel: status/preparing
    launch_dev_container(task)
    log warn "task={task.issue_id} event=dev_failed_retry attempt={task.attempt} error={error_detail}"
```

### After Review Agent

```
on_review_agent_complete(task, result):
  repo = db.getRepo(task.repo_id)
  complete_attempt(task, result)

  if result.status != "success":
    # Review agent itself failed (LLM timeout, invalid output, etc.)
    # Retry up to 2 times — review failures are infrastructure issues, not code issues.
    MAX_REVIEW_RETRIES = 2
    task.review_retry_count = (task.review_retry_count || 0) + 1
    if task.review_retry_count <= MAX_REVIEW_RETRIES:
      log warn "task={task.issue_id} event=review_failed_retry retry={task.review_retry_count}"
      launch_review_container(task)
    else:
      relabel: status/needs-human-review
      forgejo.comment_on_issue(task.issue_id,
        "Review agent failed {MAX_REVIEW_RETRIES + 1} times. Human review required.")
      free slot
    return

  task.review_retry_count = 0  # reset on success

  # Verify the review agent didn't modify the branch (review agents should only read)
  current_sha = forgejo.get_branch(repo, task.branch_name).commit.sha
  if current_sha != task.pre_review_sha:
    log warn "task={task.issue_id} event=review_modified_branch pre={task.pre_review_sha} post={current_sha}"
    # Continue with review verdict — the modification is logged but doesn't block the flow.
    # The next dev cycle or human reviewer can address unexpected changes.

  review = read /output/review.json

  if review.verdict == "approved":
    if "human-merge" label present:
      relabel: status/awaiting-human-merge
      post comment: "Review approved. PR ready for manual merge."
      free slot
    else:
      attempt_merge(task)

  if review.verdict == "changes_needed" && attempt < max_attempts:
    post feedback as PR review comments via Forgejo API
    post summary as issue comment
    relabel: status/changes-needed
    # Rework in the same slot — start dev container immediately with feedback.
    # The task does not re-enter the queue.
    task.attempt++
    launch_dev_container(task, feedback: review.feedback)

  if review.verdict == "changes_needed" && attempt >= max_attempts:
    post feedback as PR review comments via Forgejo API
    post summary as issue comment
    relabel: status/failed
    post comment: "Failed after {max_attempts} attempts."
    free slot

  if review.verdict == "unclear":
    post comment asking for human intervention
    relabel: status/needs-human-review
    free slot
```

## Cancellation

```
cancel_task(task, reason="Cancelled by user"):
  repo = db.getRepo(task.repo_id)
  # 1. Stop running container
  if task.container_id:
    docker.stop(task.container_id, timeout=10)
    docker.remove(task.container_id)

  # 2. Delete remote branch via Forgejo API (orchestrator token)
  if task.branch_name:
    try: forgejo.delete_branch(repo, task.branch_name)
      # DELETE /api/v1/repos/{owner}/{repo}/branches/{branch}
    catch: pass  # Branch may not exist on remote

  # 3. Close PR if opened
  if task.pr_number:
    forgejo.comment_on_pr(task.pr_number, "Task cancelled: {reason}")
    forgejo.close_pull_request(task.pr_number)

  # 4. Update issue
  forgejo.comment_on_issue(task.issue_id, "Task cancelled: {reason}. Branch and PR cleaned up.")
  forgejo.replace_label(task.issue_id, add: 'status/cancelled')

  # 5. Free slot and fill
  queue.remove(task)
  active_slots.release(task)
  fill_slots()
```

## Reset Task

Resets a task to a clean, unqueued state. Used when a task has failed due to git errors, agent misbehaviour, or other unrecoverable states. This is a destructive operation — all agent work is deleted.

```
reset_task(task, reason="Reset by user"):
  repo = db.getRepo(task.repo_id)
  # 1. Stop running container (if active)
  if task.container_id:
    docker.stop(task.container_id, timeout=10)
    docker.remove(task.container_id)

  # 2. Delete remote branch
  if task.branch_name:
    try: forgejo.delete_branch(repo, task.branch_name)
    catch: pass  # Branch may not exist

  # 3. Close PR if opened
  if task.pr_number:
    forgejo.comment_on_pr(task.pr_number, "Task reset: {reason}")
    forgejo.close_pull_request(task.pr_number)

  # 4. Delete local workspace
  workdir = /workspaces/issue-{task.issue_id}/
  if workdir exists: rm -rf workdir

  # 5. Remove all status labels from the Forgejo issue (return to unqueued)
  forgejo.remove_labels(task.issue_id, prefix: 'status/')
  forgejo.comment_on_issue(task.issue_id,
    "Task reset: {reason}. Branch, PR, and workspace deleted. Issue is unqueued.")

  # 6. Clean up internal state
  db.update_task(task.id,
    status: 'reset',
    branch_name: null,
    pr_number: null,
    container_id: null,
    attempt: 1,
    prep_failure_count: 0,
    started_at: null,
    completed_at: null
  )

  # 7. Free slot if occupied
  if active_slots.contains(task):
    active_slots.release(task)
    fill_slots()

  log info "task={task.issue_id} event=task_reset reason={reason}"
```

After reset, the issue exists in Forgejo with no `status/*` label. The user can re-queue it via the UI when ready, which starts a fresh cycle from attempt 1.

## Graceful Shutdown

Running agents consume LLM API tokens. Killing them wastes money and discards partially completed work. The orchestrator handles `SIGTERM` and `SIGINT` with a drain process that gives running agents time to finish.

```
on_signal(SIGTERM or SIGINT):
  log "Shutdown requested. Draining active tasks..."

  # 1. Stop accepting new work immediately
  scheduler.pause()
  # No new tasks will be picked up from the queue

  # 2. Set a drain deadline
  drain_timeout = configurable (default: max_runtime_minutes + 5 minutes)
  deadline = now + drain_timeout

  # 3. Wait for running containers to finish
  running = db.get_tasks(status IN ['preparing', 'in-progress', 'in-review'])
  if running is empty:
    proceed to shutdown

  log "Waiting for {len(running)} active tasks to complete (deadline: {deadline})..."

  while now < deadline AND running is not empty:
    for task in running:
      container_state = docker.inspect(task.container_id).State

      if container_state.Status == "exited":
        # Container finished during drain — run normal post-agent flow
        log "Task #{task.issue_id} completed during drain. Processing results."
        result = read /output/result.json from workspace
        role = read /task/meta.json .role  # 'develop' or 'review'
        if role == 'develop': on_dev_agent_complete(task, result)
        else: on_review_agent_complete(task, result)
        docker.remove(task.container_id)
        running.remove(task)

    if running is not empty:
      sleep 5 seconds

  # 4. Handle tasks that didn't finish before deadline
  for task in running:
    log "Task #{task.issue_id} did not complete before drain deadline."
    docker.stop(task.container_id, timeout=10)
    docker.remove(task.container_id)

    # Leave the DB status as-is (e.g., 'in-progress', 'in-review').
    # Startup recovery will examine the actual state (container, remote branch,
    # local workspace) and decide the correct recovery action.

  # 5. Clean exit
  db.update_setting('last_shutdown', 'graceful')
  log "Shutdown complete."
  process.exit(0)
```

### Shutdown Behavior Summary

| Scenario | What happens |
|---|---|
| No active tasks | Immediate clean shutdown |
| Active tasks finish before deadline | Normal post-agent flow runs, then clean shutdown |
| Active tasks still running at deadline | Containers killed, tasks marked as interrupted for startup recovery |
| `SIGKILL` or power loss | No handler runs. Startup recovery handles everything. |

### Docker Compose Integration

Docker Compose sends `SIGTERM` on `docker compose down` and waits for `stop_grace_period` before sending `SIGKILL`:

```yaml
services:
  orchestrator:
    # ...
    stop_grace_period: 35m  # match max_runtime_minutes + buffer
```

## Startup Recovery

On startup, the orchestrator examines the actual state of each in-flight task rather than assuming everything is lost. With agents pushing their own work to Forgejo, the orchestrator can check what actually happened during a crash or interrupted shutdown.

```
on_startup():
  # 1. Verify Forgejo connection (everything else depends on this)
  try: forgejo.get_current_user()
  catch:
    log "Cannot reach Forgejo. Pausing scheduler."
    set_paused(true)
    # Skip recovery — will retry when Forgejo becomes available
    return

  # 2. Recover orphaned containers
  containers = docker.list_containers(label="managed-by=orchestrator")
  container_map = { c.Labels['task-id']: c for c in containers }

  # 3. Recover in-flight tasks
  in_flight = db.get_tasks(status IN ['preparing', 'in-progress', 'in-review'])

  for task in in_flight:
    container = container_map.get(task.id)

    if container AND container.State.Status == "running":
      # Container is still running (survived a graceful shutdown attempt or
      # the orchestrator crashed while the container kept going).
      # Kill it — we can't trust partial state.
      docker.stop(container, timeout=10)
      docker.remove(container)
      recover_task(task)

    elif container AND container.State.Status == "exited":
      # Container finished but orchestrator died before processing results.
      # Read the results and run the normal post-agent flow.
      log "Task #{task.issue_id}: container exited during downtime. Processing results."
      try:
        result = read /output/result.json from workspace
        role = read /task/meta.json .role
        if role == 'develop': on_dev_agent_complete(task, result)
        else: on_review_agent_complete(task, result)
        docker.remove(container)
      catch:
        # Result file missing or corrupt — fall through to recover_task
        docker.remove(container)
        recover_task(task)

    else:
      # No container found. Orchestrator died after the container exited
      # but before processing results, OR container was killed externally.
      recover_task(task)

  # 4. Clean up any orphaned containers not associated with a known task
  for container in containers:
    if container.Labels['task-id'] NOT IN in_flight task IDs:
      docker.stop(container, timeout=10)
      docker.remove(container)

  # 5. Resume scheduler
  scheduler.start()
```

### Task Recovery Logic

`recover_task` examines the remote state to determine how much work was completed:

```
recover_task(task):
  repo = db.getRepo(task.repo_id)
  # Check if the agent pushed its branch to Forgejo
  branch = forgejo.get_branch(repo, task.branch_name)
    # GET /api/v1/repos/{owner}/{repo}/branches/{branch}

  if branch exists:
    # Agent pushed work. Check if it's ahead of base.
    base = forgejo.get_branch(repo, repo.base_branch)

    if branch.commit.sha == base.commit.sha:
      # Branch exists but has no changes — treat as no work
      reset_to_queued(task, "Branch exists but contains no changes.")

    elif task.status == 'in-progress':
      # Dev agent pushed work. Continue to PR creation / review.
      log "Task #{task.issue_id}: found pushed branch. Creating PR."
      if task.pr_number is null:
        pr = forgejo.create_pull_request(...)
        task.pr_number = pr.number
      forgejo.comment_on_issue(task.issue_id,
        "Orchestrator recovered after restart. Agent work found on branch. Continuing to review.")
      relabel: status/in-review
      # Task needs a slot to run its review. Add to queue — the fill_slots loop
      # will claim a slot and start the review container on the next tick.
      db.update_task(task.id, status: 'in-review')

    elif task.status == 'in-review':
      # Review agent was running. We don't know the verdict — re-run review.
      log "Task #{task.issue_id}: review was in progress. Re-running review."
      forgejo.comment_on_issue(task.issue_id,
        "Orchestrator recovered after restart. Re-running review.")
      # Task is already in-review status. The fill_slots loop will detect
      # in-review tasks without a container and start the review.
      db.update_task(task.id, status: 'in-review', container_id: null)

  else:
    # No branch on remote. Check if there's local work in the workspace.
    workdir = get_workdir(task)
    if workdir exists:
      has_uncommitted = NOT (git -C workdir diff --quiet AND git -C workdir diff --cached --quiet)
      has_untracked = git -C workdir ls-files --others --exclude-standard is non-empty
      has_commits = git -C workdir log origin/{repo.base_branch}..HEAD --oneline is non-empty

      if has_uncommitted OR has_untracked OR has_commits:
        # Local work exists but was never pushed. Salvage it.
        log "Task #{task.issue_id}: found local unpushed work. Salvaging."
        if has_uncommitted OR has_untracked:
          git -C workdir add -A
          git -C workdir commit -m "feat: {issue.title} (salvaged after restart)"
        try:
          git -C workdir push -f origin {task.branch_name}
        catch error:
          # Push failed — can't salvage. Re-queue for a fresh attempt.
          log error "task={task.issue_id} event=recovery_push_failed error={error}"
          reset_to_queued(task, "Recovery salvage push failed: {error}.")
          return
        forgejo.comment_on_issue(task.issue_id,
          "Orchestrator recovered after restart. Unpushed agent work salvaged and pushed.")
        relabel: status/in-review
        db.update_task(task.id, status: 'in-review', container_id: null)
        return

    # No remote branch, no local work. Re-queue.
    reset_to_queued(task, "No work found after restart.")

reset_to_queued(task, reason):
  db.update_task(task.id,
    status: 'queued',
    container_id: null,
    started_at: null
  )
  forgejo.replace_label(task.issue_id, add: 'status/queued')
  forgejo.comment_on_issue(task.issue_id,
    "Orchestrator restarted. {reason} Task returned to queue (attempt {task.attempt} preserved).")
```

### Recovery Decision Matrix

| Container state | Branch pushed? | Local work? | Recovery action |
|---|---|---|---|
| Exited (result.json present) | — | — | Process results normally (best case) |
| Exited (no result.json) | Yes, ahead of base | — | Create PR, set status in-review for slot pickup |
| Exited (no result.json) | No | Yes | Salvage, push, set status in-review for slot pickup |
| Exited (no result.json) | No | No | Re-queue (attempt preserved) |
| Still running | — | — | Kill, then check branch/local work |
| No container found | Yes, ahead of base | — | Create PR, set status in-review for slot pickup |
| No container found | No | Yes | Salvage, push, set status in-review for slot pickup |
| No container found | No | No | Re-queue (attempt preserved) |

### Recovery Guarantees

- **Restart never counts against the attempt budget.** The attempt counter is preserved but not incremented.
- **Pushed work is never discarded.** If the agent pushed to its branch before the crash, recovery detects it and continues the workflow.
- **Local work is salvaged when possible.** If the workspace has uncommitted or committed-but-unpushed changes, recovery commits and pushes them.
- **Unknown states default to re-queue.** When recovery can't determine what happened, the task goes back to the queue for a full retry.
- **Every recovery action is logged as a Forgejo issue comment.** The audit trail shows exactly what recovery did.

### SQLite Crash Safety

```typescript
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

WAL mode provides crash resilience. If the process dies mid-write, SQLite recovers automatically on next open.

## Forgejo Event Integration

The orchestrator uses Forgejo webhooks for real-time event notification, with a fallback polling loop to catch any missed events.

### Webhooks (primary)

A webhook endpoint receives events from Forgejo as they happen:

```
POST /webhooks/forgejo
```

**Webhook registration:** during repository setup, the orchestrator registers a webhook via the Forgejo API:

```
POST /api/v1/repos/{owner}/{repo}/hooks
{
  "type": "forgejo",
  "config": {
    "url": "http://orchestrator-host:8080/webhooks/forgejo",
    "content_type": "json",
    "secret": "<webhook_secret>"
  },
  "events": ["issues", "issue_comment", "pull_request"],
  "active": true
}
```

The webhook secret is stored in the `.env` file (`FORGEJO_WEBHOOK_SECRET`). The orchestrator verifies the `X-Forgejo-Signature` header on every request using HMAC-SHA256. If verification fails, the request is rejected with HTTP 401 and the event is not processed. A warning is logged: `event=webhook_signature_invalid`.

**Events handled:**

| Event | Trigger | Orchestrator action |
|---|---|---|
| `issues` / `opened` | New issue created with `status/queued` label | Add to internal queue (if not already tracked) |
| `issues` / `label_updated` | Label changed on a tracked issue | Sync internal state (e.g., detect external cancellation) |
| `issues` / `closed` | Issue closed externally | Mark task as cancelled if still active |
| `pull_request` / `closed` (merged) | PR merged manually | Mark task as merged, free slot |
| `issue_comment` / `created` | Comment on a tracked issue | No action (informational) |

On receiving a relevant event, the orchestrator triggers an immediate scheduler tick rather than waiting for the next poll cycle.

**Idempotency:** Forgejo retries webhook deliveries on timeout or failure. The orchestrator may also receive duplicate events after a restart (queued webhooks delivered while the orchestrator was down). All webhook handlers must be idempotent:

- **Issue opened / queued:** check `db.get_task_by_issue(issue_id)` before inserting. If the task already exists in any state, skip. Log a warning: `"Duplicate queue request for issue #{id}, already tracked as {status}."`.
- **Label changed:** read the current DB state and only act if the transition is valid. A duplicate label event for an already-transitioned task is a no-op.
- **Issue closed / PR merged:** check current DB state. If already in a terminal state, skip.

The fallback poll applies the same checks — it queries Forgejo for `status/queued` issues and only adds ones not already in the internal queue.

### Fallback polling (secondary)

Webhooks can fail silently (network blip, orchestrator temporarily unreachable during restart). A fallback poll catches anything the webhooks missed:

- **Poll interval:** 60 seconds (configurable)
- **What's polled:** issues with `status/queued` label, active task issue state
- **External state detection:** if a human manually changes labels, closes an issue, or merges a PR and the webhook was missed, the poll catches it on the next cycle

The 60-second poll interval is acceptable because webhooks handle the common case instantly. The poll is a safety net, not the primary mechanism.

## Credential Management

All secrets are loaded from environment variables (sourced from `.env` files) at process startup. No secrets are persisted in SQLite or any other on-disk store. The database stores only non-secret configuration (concurrency limits, repo settings, task state). The `agent_tools` table stores credential metadata (e.g., which env var name to read) but never the secret values themselves.

### Credential inventory

| Secret | Source | Lifetime |
|---|---|---|
| Orchestrator Forgejo token | `.env` → `process.env.FORGEJO_ORCHESTRATOR_TOKEN` | Long-lived (personal access token) |
| Agent Forgejo token | `.env` → `process.env.FORGEJO_AGENT_TOKEN` | Long-lived (personal access token) |
| LLM API keys (Anthropic, etc.) | `.env` → `process.env.ANTHROPIC_API_KEY` (etc.) | Long-lived (API key) |
| OAuth2 client ID + secret | `.env` → `process.env.FORGEJO_OAUTH_CLIENT_*` | Long-lived (app registration) |
| OAuth2 user session tokens | In memory (signed cookie) | Short-lived (session) |

### Git credential (workspace remote URL)

The agent token is embedded in the workspace git remote URL during `prepare_workspace`:

```
http://agent:<FORGEJO_AGENT_TOKEN>@forgejo-host:3000/org/repo.git
```

This is read from `process.env.FORGEJO_AGENT_TOKEN` and set once at clone time. The orchestrator's own API token is never written to the workspace.

Note: the agent token appears in `.git/config` within the workspace directory. This is on the same Docker volume on Machine B that hosts the `.env` file, so it does not expand the trust boundary.

### Agent tool credentials (container environment variables)

LLM API keys and agent tool configuration are injected as container environment variables:

```typescript
function getAgentToolEnv(task: Task, repo: Repo, tool: AgentTool): string[] {
  // tool is already resolved: task.agent_tool || repo.agent_tool (see createAgentContainer)
  const env: string[] = [];

  // Static env vars from tool config (non-secret, stored in DB)
  for (const [key, value] of Object.entries(tool.env_vars)) {
    env.push(`${key}=${value}`);
  }

  // Auth credentials — read from process.env, never from DB
  if (tool.auth_type === 'api-key') {
    const envVarName = tool.auth_config.env_var;  // e.g., "ANTHROPIC_API_KEY"
    const key = process.env[envVarName];           // read from environment, not DB
    if (key) {
      env.push(`${envVarName}=${key}`);
    } else if (!tool.auth_config.optional) {
      log warn `event=missing_api_key env_var=${envVarName} tool=${tool.id}`;
    }
    // If optional and missing, skip silently
  }
  // auth_type === 'none': no credentials injected

  return env;
}
```

Container environment variables are visible via `docker inspect`. This is inherent to Docker and represents the same trust boundary as Machine B filesystem access.
