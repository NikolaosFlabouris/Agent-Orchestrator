# Testing Strategy

## Overview

The orchestrator is a stateful system that coordinates Docker containers, git operations, and a remote Forgejo instance. Testing must cover the internal logic (state machine, queue, change detection), the integration boundaries (Forgejo API, Docker API, git), and the end-to-end task lifecycle. Each layer uses different tools and tradeoffs.

## Test Layers

### Unit Tests

Pure logic with no external dependencies. These are fast, deterministic, and run on every commit.

**State machine transitions:**

- Every valid transition produces the correct next state and side-effect list
- Invalid transitions (e.g., `queued` directly to `merged`) are rejected
- Terminal states (`merged`, `failed`, `cancelled`, `awaiting-human-*`) cannot transition further
- Override labels (`human-merge`, `human-review`) alter the transition path correctly

**Queue ordering:**

- Rework items (`status/changes-needed`) are dequeued before new items (`status/queued`)
- Within each priority tier, FIFO ordering is maintained
- Reordering via the API updates `queue_position` and is reflected in dequeue order
- Removing a queued item does not affect ordering of remaining items

**Dependency gating:**

- A task with all dependencies closed is eligible for pickup
- A task with any open dependency is skipped
- Dependency parsing extracts issue numbers from checklist markdown (`- [ ] #38`)
- Malformed dependency syntax (missing `#`, non-numeric) is handled gracefully

**Change detection (post_dev_agent):**

- Uncommitted changes to tracked files are detected (`has_uncommitted`)
- New untracked files are detected (`has_untracked`)
- Agent commits ahead of base are detected (`has_commits`)
- A completely clean workspace (no changes of any kind) is detected as "no work produced"
- Combinations: agent commits + uncommitted leftovers both detected correctly

**Prompt assembly:**

- Dev prompt includes issue body, context, and constraints
- Rework prompt appends review feedback with attempt number
- Review prompt includes original task description and diff instructions
- Template variables are substituted correctly
- Missing optional fields (no review feedback on first attempt) produce valid prompts

**Branch naming:**

- Branch names are generated from issue ID and title
- Special characters in titles are sanitized
- Branch names respect git's naming rules (no spaces, no `..`, no trailing `.lock`)

**Framework:** Vitest (aligns with Vite frontend tooling, fast, good TypeScript support). No mocking libraries needed for this layer — pure functions in, assertions out.

### Integration Tests

Test the orchestrator against real external services running in Docker containers. Slower than unit tests, run in CI and during development.

**Forgejo API client:**

Spin up a Forgejo container as a test fixture. Run against the real API:

- Create repository, create issue, verify state
- Apply scoped labels, verify exclusivity (applying `status/in-progress` removes `status/queued`)
- Create PR, merge PR, verify branch state
- Comment on issues and PRs, verify comments appear
- Branch protection enforcement: verify the agent account cannot push to protected branches
- OAuth2 flow: verify token exchange produces valid session

```yaml
# test/docker-compose.test.yml
services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:14
    ports:
      - "3001:3000"
    volumes:
      - forgejo-test-data:/data
    environment:
      - USER_UID=1000
      - USER_GID=1000

volumes:
  forgejo-test-data:
```

Test setup provisions the Forgejo instance with test repositories, user accounts, labels, and branch protection rules via the API before each test suite.

**Docker container lifecycle:**

Test against the real Docker socket:

- Create a container with the agent labels, resource limits, and mounts
- Verify container starts, runs, and exits
- Verify `container.wait()` returns the correct exit code
- Verify mounted volumes are readable/writable from inside the container
- Verify container cleanup (stop + remove) works for running containers
- Verify orphan detection: list containers by `managed-by=orchestrator` label

**Git operations:**

Test against a real git repository (local or hosted on the test Forgejo instance):

- Clone, fetch, checkout, branch creation
- Commit, push (verify branch appears on remote)
- Force push on rework
- Verify agent credential can push to `agent/*` branches
- Verify agent credential cannot push to protected branches

**Harness contract:**

Build the agent base image and run a minimal container:

- Verify `result.json` is always produced (success, failure, timeout cases)
- Verify review agent produces `review.json` with valid verdict
- Verify pre-agent script runs before agent invocation
- Verify timeout enforcement kills the agent process
- Verify progress log is written incrementally

For harness tests, use a mock agent that doesn't call any LLM — a simple script that creates files, optionally commits, and writes the expected output files. This validates the harness machinery without API costs.

```bash
# test/mock-agent.sh — replaces the real agent for testing
echo "mock change" > /repo/test-file.txt
git add -A && git commit -m "test commit"
git push origin $(git branch --show-current)
cat > /output/result.json << 'EOF'
{"status": "success", "exit_code": 0}
EOF
```

**Framework:** Vitest with longer timeouts. Test fixtures manage Docker containers and Forgejo state via setup/teardown hooks. Tests run sequentially within each integration suite (shared Forgejo state).

### End-to-End Tests

Full task lifecycle against real infrastructure. Run manually or in CI on a schedule (not on every commit — too slow and potentially expensive).

**Lifecycle test with mock agent:**

1. Start test Forgejo + orchestrator
2. Create a repository with labels and branch protection
3. Queue a task via the orchestrator API
4. Orchestrator creates agent container with mock agent (no LLM)
5. Mock agent makes a change, commits, pushes
6. Orchestrator detects push, creates PR
7. Review agent (also mocked) approves
8. Orchestrator merges PR
9. Verify: issue is closed, labels are correct, branch is merged, PR is merged

This validates the full flow without LLM costs. The mock agent image replaces the real agent image in the orchestrator configuration.

**Lifecycle test variants:**

- Rework cycle: mock review agent rejects on first attempt, approves on second
- Timeout: mock agent sleeps past the timeout, verify salvage of partial work
- Cancellation: cancel a task mid-execution, verify cleanup (container stopped, PR closed, branch deleted)
- Dependency gating: create two tasks with a dependency, verify ordering
- Human-merge override: verify PR is left open, slot is freed
- Orchestrator restart: kill the orchestrator mid-task, restart, verify task is re-queued and completes

**Lifecycle test with real agent (optional, expensive):**

Run sparingly to validate that real LLM agents produce meaningful output. Use a trivial task (e.g., "add a comment to the README") against a real Anthropic API key with Haiku to minimize cost.

## Mock Agent Image

A dedicated test image that simulates agent behavior without calling any LLM:

```dockerfile
# images/test-mock/Dockerfile
FROM orchestrator-agent:latest

COPY test/mock-harness.sh /usr/local/bin/mock-harness
RUN chmod +x /usr/local/bin/mock-harness

ENTRYPOINT ["/usr/local/bin/mock-harness"]
```

The mock harness reads `/task/meta.json` to determine the role and simulates behavior:

- **develop role:** creates a file, commits, pushes, writes `result.json`
- **review role:** reads the diff, writes an `approved` or `changes_needed` verdict to `review.json` based on a flag in meta.json
- **failure mode:** if `meta.json` contains `"mock_fail": true`, exits with a failure result
- **timeout mode:** if `meta.json` contains `"mock_timeout": true`, sleeps indefinitely

This mock image is configured as an agent tool in test environments:

```json
{
  "id": "mock-agent",
  "display_name": "Mock Agent (Testing)",
  "type": "cli",
  "command_template": "/usr/local/bin/mock-harness",
  "env_vars": {}
}
```

## Project Structure

```
orchestrator/
├── packages/
│   ├── server/
│   │   └── src/
│   │       └── __tests__/
│   │           ├── unit/
│   │           │   ├── state-machine.test.ts
│   │           │   ├── queue.test.ts
│   │           │   ├── dependencies.test.ts
│   │           │   ├── change-detection.test.ts
│   │           │   ├── prompt-assembly.test.ts
│   │           │   └── branch-naming.test.ts
│   │           ├── integration/
│   │           │   ├── forgejo-client.test.ts
│   │           │   ├── docker-lifecycle.test.ts
│   │           │   ├── git-operations.test.ts
│   │           │   └── harness-contract.test.ts
│   │           └── e2e/
│   │               └── task-lifecycle.test.ts
│   └── shared/
│       └── src/
│           └── __tests__/
│               └── labels.test.ts
├── test/
│   ├── docker-compose.test.yml     ← test Forgejo instance
│   ├── mock-harness.sh             ← mock agent script
│   ├── fixtures/                   ← test data (issue bodies, review verdicts)
│   └── setup.ts                    ← test fixture provisioning
├── images/
│   └── test-mock/
│       └── Dockerfile              ← mock agent image
```

## Test Execution

```bash
# Unit tests — fast, no dependencies, run on every commit
npm test -w packages/server -- --run unit

# Integration tests — requires Docker, run in CI
npm test -w packages/server -- --run integration

# End-to-end — requires Docker + test Forgejo, run on schedule or manually
npm test -w packages/server -- --run e2e

# All tests
npm test
```
