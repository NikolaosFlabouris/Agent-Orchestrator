# TODO

## End-to-end test implementation

The e2e test plan is documented in [11 - E2E Test Plan](./11-e2e-test-plan.md). The test file exists at `packages/server/src/__tests__/e2e/task-lifecycle.test.ts` with 8 test case stubs (`.todo`). These need to be implemented against a running orchestrator with Docker and Forgejo.

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
