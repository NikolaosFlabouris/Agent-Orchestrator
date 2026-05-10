import { describe, it, expect } from 'vitest';

/**
 * End-to-end tests for the full task lifecycle.
 *
 * Requires a running orchestrator, Docker with agent images built, and a
 * reachable Forgejo instance. The happy-path case below is the only one
 * implemented today — see docs/11-e2e-test-plan.md for the remaining
 * scenarios (rework, timeout, cancellation, recovery, dependencies, human
 * overrides).
 *
 * Run:
 *   TEST_E2E=1 \
 *   TEST_ORCHESTRATOR_URL=http://localhost:8081 \
 *   TEST_FORGEJO_URL=http://localhost:3000 \
 *   TEST_FORGEJO_ORCHESTRATOR_TOKEN=... \
 *   TEST_FORGEJO_USER=orchestrator \
 *   TEST_REPO=acme/demo \
 *   npm run test:e2e
 *
 * Preconditions (set up manually or via a fixture script before running):
 *   - The orchestrator is running and reachable at TEST_ORCHESTRATOR_URL.
 *     First-run seeding (schema v21) provides a default agent profile
 *     `default-claude-sdk` against the Anthropic provider, so the
 *     bootstrap path works as long as ANTHROPIC_API_KEY is set in the
 *     orchestrator's .env.
 *   - Agent images built: `./scripts/build-agent-images.sh`
 *   - The repo `TEST_REPO` is registered in the orchestrator. Either
 *     leave `agent_profile_id` null (inherits the global default) or
 *     point it at a profile suited for testing.
 *   - Labels `status/queued`, `status/in-progress`, `status/in-review`,
 *     `status/merged` exist in the repo (see docs/01-forgejo-setup.md).
 */

const SKIP = !process.env.TEST_E2E;
const ORCHESTRATOR_URL =
  process.env.TEST_ORCHESTRATOR_URL ?? 'http://localhost:8081';
const FORGEJO_URL = process.env.TEST_FORGEJO_URL ?? '';
const FORGEJO_TOKEN = process.env.TEST_FORGEJO_ORCHESTRATOR_TOKEN ?? '';
const FORGEJO_USER = process.env.TEST_FORGEJO_USER ?? '';
const TEST_REPO = process.env.TEST_REPO ?? '';

const HAPPY_PATH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function forgejoFetch(
  pathStr: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${FORGEJO_URL}${pathStr}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `token ${FORGEJO_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

async function orchestratorFetch(pathStr: string): Promise<Response> {
  return fetch(`${ORCHESTRATOR_URL}${pathStr}`);
}

async function waitFor<T>(
  label: string,
  predicate: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 3000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result !== null && result !== undefined) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timeout waiting for: ${label} (${timeoutMs}ms). Last error: ${String(lastErr)}`
  );
}

describe.skipIf(SKIP)('Task lifecycle e2e', () => {
  describe('happy path', () => {
    it(
      'queue -> implement -> review -> merge',
      async () => {
        // Guard — these env vars are required only when TEST_E2E is on.
        expect(FORGEJO_URL, 'TEST_FORGEJO_URL required').toBeTruthy();
        expect(FORGEJO_TOKEN, 'TEST_FORGEJO_ORCHESTRATOR_TOKEN required').toBeTruthy();
        expect(TEST_REPO, 'TEST_REPO (owner/name) required').toBeTruthy();

        const [owner, name] = TEST_REPO.split('/');
        expect(owner && name, 'TEST_REPO must be owner/name').toBeTruthy();

        // 1. Create a Forgejo issue
        const issueTitle = `e2e-happy-path ${new Date().toISOString()}`;
        const issueBody =
          'Add a line at the end of README.md saying `Hello from the orchestrator e2e test!`.';

        const createRes = await forgejoFetch(
          `/api/v1/repos/${owner}/${name}/issues`,
          {
            method: 'POST',
            body: JSON.stringify({
              title: issueTitle,
              body: issueBody,
              labels: [], // label applied in a separate call so the orchestrator treats this as a queue trigger
            }),
          }
        );
        expect(createRes.ok, `Forgejo issue creation failed: ${createRes.status}`).toBe(true);
        const issue = (await createRes.json()) as { number: number; id: number };

        // 2. Label the issue status/queued (this is what the orchestrator watches for)
        const labelRes = await forgejoFetch(
          `/api/v1/repos/${owner}/${name}/issues/${issue.number}/labels`,
          {
            method: 'POST',
            body: JSON.stringify({ labels: ['status/queued'] }),
          }
        );
        expect(labelRes.ok, `Label apply failed: ${labelRes.status}`).toBe(true);

        // 3. Wait for the orchestrator to register the task
        const task = await waitFor(
          `task registered for issue #${issue.number}`,
          async () => {
            const res = await orchestratorFetch('/api/tasks');
            if (!res.ok) return null;
            const { tasks } = (await res.json()) as { tasks: Array<{ id: number; issue_id: number; status: string }> };
            return tasks.find((t) => t.issue_id === issue.id) ?? null;
          },
          60_000
        );

        // 4. Wait for terminal status 'merged' — orchestrator drives the full
        //    dev -> review -> merge flow on its own once the task is queued.
        //    GET /api/tasks/:id returns the task fields spread at the top level
        //    (plus `attempts`, `events`, `forgejo_links`).
        const merged = await waitFor(
          `task ${task.id} to reach status=merged`,
          async () => {
            const res = await orchestratorFetch(`/api/tasks/${task.id}`);
            if (!res.ok) return null;
            const t = (await res.json()) as {
              id: number;
              status: string;
              pr_number: number | null;
            };
            if (t.status === 'merged') return t;
            if (t.status === 'failed' || t.status === 'cancelled') {
              throw new Error(`Task ended in terminal non-merged state: ${t.status}`);
            }
            return null;
          },
          HAPPY_PATH_TIMEOUT_MS
        );

        expect(merged.status).toBe('merged');
        expect(merged.pr_number).not.toBeNull();

        // 5. Verify Forgejo-side state
        const issueAfter = await forgejoFetch(
          `/api/v1/repos/${owner}/${name}/issues/${issue.number}`
        );
        expect(issueAfter.ok).toBe(true);
        const issueJson = (await issueAfter.json()) as { state: string };
        expect(issueJson.state).toBe('closed');

        const prRes = await forgejoFetch(
          `/api/v1/repos/${owner}/${name}/pulls/${merged.pr_number}`
        );
        expect(prRes.ok).toBe(true);
        const prJson = (await prRes.json()) as { merged: boolean };
        expect(prJson.merged).toBe(true);

        // 6. Verify attempt data was recorded
        const detailRes = await orchestratorFetch(`/api/tasks/${task.id}`);
        const detail = (await detailRes.json()) as {
          attempts: Array<{ role: string; status: string }>;
        };
        expect(detail.attempts?.length ?? 0).toBeGreaterThanOrEqual(2); // at least one develop + one review
        expect(detail.attempts.some((a) => a.role === 'develop' && a.status === 'success')).toBe(true);
        expect(detail.attempts.some((a) => a.role === 'review' && a.status === 'success')).toBe(true);

        void FORGEJO_USER; // reserved for future assertions against the acting user
      },
      HAPPY_PATH_TIMEOUT_MS + 30_000
    );
  });

  describe('rework cycle', () => {
    it.todo('review rejects -> dev rework -> review approves -> merge');
  });

  describe('timeout handling', () => {
    it.todo('agent timeout -> salvage partial work -> review');
  });

  describe('cancellation', () => {
    it.todo('cancel mid-execution -> container stopped, PR closed, branch deleted');
  });

  describe('recovery', () => {
    it.todo('kill orchestrator mid-task -> restart -> task recovered');
  });

  describe('dependency gating', () => {
    it.todo('task with open dependency is skipped, runs after dependency closes');
  });

  describe('human overrides', () => {
    it.todo('human-merge label -> PR left open after review approval');
    it.todo('human-review label -> review skipped, awaiting human');
  });
});
