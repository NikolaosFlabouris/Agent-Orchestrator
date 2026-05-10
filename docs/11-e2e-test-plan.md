# End-to-End Test Plan

These tests validate the full task lifecycle against a running orchestrator with Docker and Forgejo. They require the mock agent image, a configured Forgejo instance, and the orchestrator process running with a test database.

## Prerequisites

- Docker Engine available
- Forgejo instance running with test user accounts and API tokens
- Mock agent image built (`docker build -t orchestrator-agent:latest -f images/test-mock/Dockerfile images/test-mock/`)
- Orchestrator configured with a test repository pointing to the mock agent tool
- Environment variables: `TEST_E2E=true`, `TEST_FORGEJO_URL`, `TEST_FORGEJO_ORCHESTRATOR_TOKEN`, `TEST_FORGEJO_USER`

## Test Cases

### 1. Happy path: queue → implement → review → merge

1. Create a Forgejo issue in the test repo
2. Queue the task via `POST /api/tasks/queue`
3. Wait for the scheduler to pick it up (status transitions: queued → preparing → in-progress)
4. Mock dev agent creates a file, commits, pushes
5. Orchestrator verifies push, creates PR (status: in-review)
6. Mock review agent writes approved verdict
7. Orchestrator merges PR, closes issue (status: merged)
8. Verify: issue is closed, PR is merged, task status is `merged`, attempt rows have cost data, timeline events are recorded

### 2. Rework cycle: review rejects → dev rework → review approves → merge

1. Queue a task configured with `mock_verdict: changes_needed` for the first review
2. Mock dev agent implements, mock review agent rejects with feedback
3. Orchestrator starts rework cycle (status: changes-needed → in-progress)
4. Mock dev agent reworks, mock review agent approves on second pass
5. Orchestrator merges
6. Verify: attempt count is 2, both dev and review attempt rows exist, rework feedback is recorded

### 3. Timeout handling: agent timeout → salvage partial work → review

1. Queue a task configured with `mock_mode: timeout` and a short timeout (1 minute)
2. Mock agent sleeps, orchestrator kills container after timeout
3. If partial work exists in the workspace, orchestrator salvages (commits, pushes)
4. Orchestrator continues to review or retries depending on salvage result
5. Verify: attempt status is `timeout`, salvage is attempted, task is not stuck

### 4. Cancellation: cancel mid-execution → verify cleanup

1. Queue a task, wait for it to reach `in-progress`
2. Cancel via `PATCH /api/tasks/:id` with `{ action: "cancel" }`
3. Verify: container is stopped, remote branch is deleted, PR is closed (if created), task status is `cancelled`, slot is freed

### 5. Recovery: kill orchestrator mid-task → restart → task recovered

1. Queue a task, wait for mock agent to start
2. Kill the orchestrator process (SIGKILL, not SIGTERM — bypass graceful shutdown)
3. Restart the orchestrator
4. Verify recovery based on state:
   - If branch was pushed: PR created, task set to `in-review` for pickup by fillSlots
   - If local work exists: salvaged, pushed, set to `in-review`
   - If no work: task re-queued with attempt preserved
5. Verify: task eventually completes (merged or re-queued), no attempt budget consumed by restart

### 6. Dependency gating: blocked task waits for dependency

1. Create two issues: issue A and issue B
2. Issue B's body contains `- [ ] #A` (dependency on A)
3. Queue both tasks
4. Verify: task A is picked up, task B remains queued (skipped by fillSlots due to open dependency)
5. Complete task A (merge)
6. Verify: task B is now eligible and picked up on the next scheduler tick

### 7. Human-merge override: PR left open after review approval

1. Queue a task with the `human-merge` label on the Forgejo issue
2. Mock dev agent implements, mock review agent approves
3. Verify: task status is `awaiting-human-merge` (not `merged`), PR remains open, slot is freed
4. The PR is available for manual merge by a human

### 8. Human-review override: review skipped, awaiting human

1. Queue a task with the `human-review` label on the Forgejo issue
2. Mock dev agent implements and pushes
3. Verify: task status is `awaiting-human-review` (not `in-review`), no review container was started, PR is created, slot is freed
