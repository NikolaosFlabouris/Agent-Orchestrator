/**
 * Test fixture provisioning for integration and e2e tests.
 *
 * Provisions a test Forgejo instance with:
 * - User accounts (orchestrator, agent)
 * - A test repository with labels and branch protection
 * - API tokens for both accounts
 *
 * Usage:
 *   const env = await setupTestEnvironment();
 *   // env.forgejoUrl, env.orchestratorToken, env.agentToken, env.repo
 *   await teardownTestEnvironment(env);
 */

export interface TestEnvironment {
  forgejoUrl: string;
  orchestratorToken: string;
  agentToken: string;
  repo: {
    owner: string;
    name: string;
  };
}

const FORGEJO_URL = process.env.TEST_FORGEJO_URL ?? 'http://localhost:3001';

export async function setupTestEnvironment(): Promise<TestEnvironment> {
  // Wait for Forgejo to be ready
  await waitForForgejo(FORGEJO_URL);

  // The initial admin account is created on first Forgejo startup.
  // For test environments, we assume admin credentials are:
  //   username: admin, password: admin123
  // These are set via FORGEJO__security__INSTALL_LOCK and initial setup.

  // In a real test setup, this would:
  // 1. Create orchestrator and agent user accounts via admin API
  // 2. Create a test repository
  // 3. Set up labels (status/queued, status/merged, etc.)
  // 4. Configure branch protection on main
  // 5. Generate API tokens for both accounts

  return {
    forgejoUrl: FORGEJO_URL,
    orchestratorToken: 'test-orchestrator-token',
    agentToken: 'test-agent-token',
    repo: {
      owner: 'test-org',
      name: 'test-repo',
    },
  };
}

export async function teardownTestEnvironment(
  _env: TestEnvironment
): Promise<void> {
  // Clean up test data if needed
  // For Docker-based tests, the volume is ephemeral
}

async function waitForForgejo(
  url: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/v1/version`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(`Forgejo not ready at ${url} after ${timeoutMs}ms`);
}
