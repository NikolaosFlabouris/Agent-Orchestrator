import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
// os not needed — using project root for temp dirs

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true' || !process.env.TEST_DOCKER;
const MOCK_IMAGE = 'orchestrator-test-mock:test';

describe.skipIf(SKIP)('Harness contract integration', { timeout: 120_000 }, () => {
  let docker: Docker;
  const createdContainers: string[] = [];
  let tmpDir: string;

  beforeAll(async () => {
    if (process.platform === 'win32') {
      docker = new Docker({ socketPath: '//./pipe/dockerDesktopLinuxEngine' });
    } else {
      docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    // Build the mock agent image
    const projectRoot = path.resolve(__dirname, '../../../../..');
    const mockDir = path.join(projectRoot, 'images', 'test-mock');

    // Use docker CLI to build (simpler than dockerode build API)
    const { execFileSync } = await import('node:child_process');
    execFileSync('docker', [
      'build', '-t', MOCK_IMAGE,
      '-f', path.join(mockDir, 'Dockerfile'),
      mockDir,
    ], { timeout: 60_000, stdio: 'pipe' });

    // Create a temp directory for mount volumes
    // Use project root to ensure Docker Desktop can access it (Windows file sharing)
    tmpDir = path.join(projectRoot, '.test-tmp-harness-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    for (const id of createdContainers) {
      try {
        const c = docker.getContainer(id);
        try { await c.stop({ t: 1 }); } catch { /* */ }
        await c.remove({ force: true });
      } catch { /* */ }
    }
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  function setupDirs(testName: string) {
    const base = path.join(tmpDir, testName);
    const taskDir = path.join(base, 'task');
    const outputDir = path.join(base, 'output');
    const repoDir = path.join(base, 'repo');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    // Make dirs writable by container user (UID 1000)
    for (const dir of [taskDir, outputDir, repoDir, base]) {
      fs.chmodSync(dir, 0o777);
    }

    // Init a git repo so the mock agent can commit
    const { execFileSync: exec } = require('node:child_process');
    exec('git', ['init', '--initial-branch', 'main', repoDir], { stdio: 'pipe' });
    exec('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    exec('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    // Create an initial commit so branches work
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n');
    fs.chmodSync(path.join(repoDir, 'README.md'), 0o666);
    exec('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
    exec('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });

    return { taskDir, outputDir, repoDir };
  }

  async function runMockContainer(
    dirs: { taskDir: string; outputDir: string; repoDir: string },
    meta: Record<string, unknown>
  ): Promise<{ exitCode: number }> {
    fs.writeFileSync(
      path.join(dirs.taskDir, 'meta.json'),
      JSON.stringify(meta)
    );
    fs.writeFileSync(
      path.join(dirs.taskDir, 'prompt.md'),
      '# Test prompt\nDo something.'
    );

    // Docker on Windows needs forward slashes in bind mount paths
    const toDockerPath = (p: string) => p.replace(/\\/g, '/');

    const container = await docker.createContainer({
      Image: MOCK_IMAGE,
      HostConfig: {
        Binds: [
          `${toDockerPath(dirs.repoDir)}:/repo`,
          `${toDockerPath(dirs.taskDir)}:/task`,
          `${toDockerPath(dirs.outputDir)}:/output`,
        ],
      },
    });
    createdContainers.push(container.id);

    await container.start();
    const result = await container.wait();
    return { exitCode: result.StatusCode };
  }

  it('produces result.json with success status (review role — no git needed)', async () => {
    const dirs = setupDirs('success-review');
    const { exitCode } = await runMockContainer(dirs, {
      role: 'review',
      issue_id: 1,
      branch_name: 'main',
      attempt: 1,
      mock_mode: 'success',
      mock_verdict: 'approved',
    });

    expect(exitCode).toBe(0);

    const resultPath = path.join(dirs.outputDir, 'result.json');
    expect(fs.existsSync(resultPath)).toBe(true);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.status).toBe('success');
    expect(result.usage).toBeDefined();
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });

  it('produces result.json on failure', async () => {
    const dirs = setupDirs('failure');
    // Ensure output dir is writable by any user (container runs as UID 1000)
    fs.chmodSync(dirs.outputDir, 0o777);
    const { exitCode } = await runMockContainer(dirs, {
      role: 'develop',
      issue_id: 2,
      branch_name: 'main',
      attempt: 1,
      mock_mode: 'failure',
    });

    // Mock agent exits 1 on failure
    expect(exitCode).toBe(1);

    const resultPath = path.join(dirs.outputDir, 'result.json');
    expect(fs.existsSync(resultPath)).toBe(true);

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    expect(result.status).toBe('failure');
    expect(result.error_message).toBeTruthy();
  });

  it('produces review.json with verdict (review role)', async () => {
    const dirs = setupDirs('review-approved');
    const { exitCode } = await runMockContainer(dirs, {
      role: 'review',
      issue_id: 3,
      branch_name: 'main',
      attempt: 1,
      mock_mode: 'success',
      mock_verdict: 'approved',
    });

    expect(exitCode).toBe(0);

    const reviewPath = path.join(dirs.outputDir, 'review.json');
    expect(fs.existsSync(reviewPath)).toBe(true);

    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf-8'));
    expect(review.verdict).toBe('approved');
  });

  it('produces changes_needed verdict', async () => {
    const dirs = setupDirs('review-reject');
    const { exitCode } = await runMockContainer(dirs, {
      role: 'review',
      issue_id: 4,
      branch_name: 'main',
      attempt: 1,
      mock_mode: 'success',
      mock_verdict: 'changes_needed',
    });

    expect(exitCode).toBe(0);

    const review = JSON.parse(
      fs.readFileSync(path.join(dirs.outputDir, 'review.json'), 'utf-8')
    );
    expect(review.verdict).toBe('changes_needed');
    expect(review.feedback).toBeTruthy();
  });

  it('writes usage data in result.json', async () => {
    const dirs = setupDirs('usage-test');
    // Use review role to avoid git operations
    await runMockContainer(dirs, {
      role: 'review',
      issue_id: 5,
      branch_name: 'main',
      attempt: 1,
      mock_mode: 'success',
      mock_verdict: 'approved',
    });

    const result = JSON.parse(
      fs.readFileSync(path.join(dirs.outputDir, 'result.json'), 'utf-8')
    );
    expect(result.usage).toBeDefined();
    expect(result.usage.input_tokens).toBe(3000); // review uses 3000 input tokens
    expect(result.usage.output_tokens).toBe(1000);
    expect(result.usage.model).toBe('mock-model');
  });
});
