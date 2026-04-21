# TODO

## End-to-end test implementation

The e2e test plan is documented in [11 - E2E Test Plan](./11-e2e-test-plan.md). The test file exists at `packages/server/src/__tests__/e2e/task-lifecycle.test.ts`. A happy-path smoke test has been implemented (gated by `TEST_E2E=1`, uses the mock agent image against a disposable Forgejo container). The remaining 7 scenarios from the E2E plan (rework, timeout, cancellation, recovery, dependencies, human overrides, concurrency) are still `.todo` stubs.

Run the smoke test: `npm run test:e2e` (requires Docker and a reachable Forgejo — see test file for the required `TEST_FORGEJO_*` env vars).

## Investigate: git clone fails inside vitest worker processes on Windows

**Status:** Open — needs investigation

**Symptom:** `git clone` with credentials embedded in the URL (`http://user:token@host/repo.git`) fails with `URL rejected: Malformed input to a URL function` when called via `execFileSync` inside a vitest worker process on Windows. The identical command succeeds from bash, from `node -e`, and from a standalone Node.js script with the same environment variables.

**Affected test:** `packages/server/src/__tests__/integration/git-operations.test.ts` — skipped on Windows (`process.platform === 'win32'`).

**Environment:** Windows 11, Node.js 24, Git 2.50.0, vitest 3.2.4.

**What was ruled out:**
- URL format — the same URL works from bash and standalone Node
- Path separators — tried forward slashes, backslashes, and `cygpath` conversion
- Environment variables — tried stripping all `GIT_*` vars, tried a minimal env with only PATH/HOME/SystemRoot
- Git credential manager — tried `-c credential.helper=` to disable it
- Vitest thread pool — tried `--pool=forks`, `--poolOptions.forks.singleFork`
- Child process isolation — even spawning a fresh `node -e` process from within the vitest worker reproduces the failure

**Error source:** The error `URL rejected: Malformed input to a URL function` comes from libcurl (`CURLE_URL_MALFORMAT`). Git 2.50.0 uses a recent libcurl with stricter URL validation. Something about vitest's process context triggers this stricter validation path.

**Potential investigation paths:**
- Compare the full process environment (`process.env`) between a vitest worker and a standalone Node process to find the differentiating variable
- Test with an older Git version (e.g., 2.43) to see if the stricter libcurl validation is the trigger
- Test on Linux to confirm this is Windows-specific
- Try using `git -c url.http://host/.insteadOf=...` or a `.gitconfig` credential helper instead of embedded URL credentials
- Check if vitest sets `NODE_OPTIONS`, `LD_PRELOAD`, or modifies the process's CWD or umask in a way that affects child process spawning
- Use `GIT_CURL_VERBOSE=1` from inside the vitest worker to compare the curl handshake with the working standalone version

**Workaround:** The git-operations tests are skipped on Windows. The same git operations are tested indirectly via the Forgejo API integration tests (which pass) and will run on Linux CI.

## Future Enhancements

### Model selection dropdown

Query available models from the LLM provider and populate a dropdown in the UI instead of free text input. Anthropic models can use a static list. Local LLM servers (Ollama, vLLM, llama.cpp, LM Studio) expose a `/v1/models` endpoint that returns installed/loaded models.

Implementation: add an optional `models_endpoint` field to the `agent_tools` configuration. If set, the orchestrator proxies a query to it and the UI renders a dropdown. Falls back to free text if unset or the query fails.

### Notifications outside the web UI

Webhook notifications to Slack, Discord, or email on task completion, failure, or alerts. Currently all alerts are only visible in the web UI dashboard.

### Docker-in-Docker for agent containers

Some repos use Docker Compose for local development (e.g., running the app with a database). Agents currently cannot start Docker containers. Options: mount the Docker socket (breaks isolation) or use Docker-in-Docker with a nested daemon (adds complexity). Deferred — agents validate via tests and linting, not by running the full application stack.

### Image versioning and rollback

Agent images are always tagged `:latest`. No version history or rollback mechanism. If a rebuilt image introduces a problem, the fix is to correct the Dockerfile and rebuild. A versioning scheme (tag with timestamp or hash) could be added later.

### Multi-repo tasks

A task that spans multiple repositories (e.g., frontend + backend changes for one feature). Would require a "task group" concept where related issues across repos are linked, with dependency gating ensuring the backend task completes before the frontend task starts.

## Known Limitations to Address

### CLI harness prompt injection (mitigated)

The CLI harness now supports a `{{PROMPT_FILE}}` placeholder in `command_template` that substitutes the literal path `/task/prompt.md` — the agent tool reads the file itself, so prompt content never touches the shell. All default tool definitions seeded by `scripts/seed-agent-tools.ts` use this placeholder.

The legacy `${TASK_PROMPT}` placeholder (inline substitution via `envsubst` + `bash -c`) is still honored for backward compatibility, but any custom tool definition using it is vulnerable to shell metacharacters in user-authored issue bodies. Migrate by switching the placeholder in **Settings > Agent Tools**. See [04 - Agent Harness](./04-agent-harness.md#prompt-substitution-in-cli-command-templates).

### Verify OpenCode CLI flags against installed version

`scripts/seed-agent-tools.ts` uses `opencode run "$(cat {{PROMPT_FILE}})"` as the default command template. OpenCode's CLI surface changes between releases; confirm the flags of the actually-installed version at bring-up time:

```bash
docker run --rm -it orchestrator-agent-base:latest opencode run --help
```

If the non-interactive invocation differs, update the `command_template` via **Settings > Agent Tools** and re-seed with `npm run seed:tools -- --force` (or edit inline).

### Docker Compose stop_grace_period coupling

The `stop_grace_period` in docker-compose.yml is static. The orchestrator's drain timeout is dynamic (`agent_timeout_minutes + 5`). If the admin changes the timeout via the UI without updating docker-compose.yml, Docker will SIGKILL before the drain completes.

Workaround: document that changing `agent_timeout_minutes` requires updating `stop_grace_period` and running `docker compose up -d`.

### Forgejo comment/label failure resilience

Label changes (state transitions) should retry up to 3 times on failure. Comments (audit trail) should log a warning and continue — non-blocking. Currently the design specifies this strategy but the retry logic is not detailed in pseudocode.
