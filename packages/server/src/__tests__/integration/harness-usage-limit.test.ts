import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Docker from 'dockerode';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP = process.env.SKIP_DOCKER_TESTS === 'true' || !process.env.TEST_DOCKER;
const HARNESS_IMAGE = 'orchestrator-test-harness:test';

/**
 * Contract tests for the REAL harness-cli.sh (test-mock replaces the harness
 * entirely, so it cannot cover harness behaviour). The agent CLI is scripted
 * via meta.json agent_command — the harness treats it as an opaque command,
 * which is exactly the production contract.
 *
 * Focus: the usage-limit retry loop. A Claude Code usage-limit failure must
 * be retried inside the container (fresh agent, intact workspace, no
 * container exit), while any other failure must exit immediately so the
 * orchestrator's attempt handling owns it.
 */
describe.skipIf(SKIP)('Harness usage-limit retry integration', { timeout: 180_000 }, () => {
  let docker: Docker;
  const createdContainers: string[] = [];
  let tmpDir: string;

  beforeAll(async () => {
    if (process.platform === 'win32') {
      docker = new Docker({ socketPath: '//./pipe/dockerDesktopLinuxEngine' });
    } else {
      docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    const projectRoot = path.resolve(__dirname, '../../../../..');

    // Assemble the build context in a temp dir: the Dockerfile COPYs
    // harness-cli.sh, which lives outside images/test-harness in the repo
    // (building with the repo root as context would upload node_modules).
    const buildDir = path.join(projectRoot, '.test-tmp-harness-build-' + Date.now());
    fs.mkdirSync(buildDir, { recursive: true });
    fs.copyFileSync(
      path.join(projectRoot, 'images', 'test-harness', 'Dockerfile'),
      path.join(buildDir, 'Dockerfile')
    );
    fs.copyFileSync(
      path.join(projectRoot, 'harness', 'harness-cli.sh'),
      path.join(buildDir, 'harness-cli.sh')
    );
    try {
      execFileSync('docker', ['build', '-t', HARNESS_IMAGE, buildDir], {
        timeout: 150_000,
        stdio: 'pipe',
      });
    } finally {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }

    // Temp directory for mount volumes — project root so Docker Desktop can
    // access it (Windows file sharing).
    tmpDir = path.join(projectRoot, '.test-tmp-harness-usage-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
  }, 180_000); // image build (apt install) can exceed the default hook timeout

  afterAll(async () => {
    for (const id of createdContainers) {
      try {
        const c = docker.getContainer(id);
        try { await c.stop({ t: 1 }); } catch { /* */ }
        await c.remove({ force: true });
      } catch { /* */ }
    }
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

    for (const dir of [taskDir, outputDir, repoDir, base]) {
      fs.chmodSync(dir, 0o777);
    }

    // Init a git repo so checkpoint commits work
    execFileSync('git', ['init', '--initial-branch', 'main', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n');
    fs.chmodSync(path.join(repoDir, 'README.md'), 0o666);
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });

    return { taskDir, outputDir, repoDir };
  }

  async function runHarness(
    dirs: { taskDir: string; outputDir: string; repoDir: string },
    meta: Record<string, unknown>,
    env: string[] = []
  ): Promise<{ exitCode: number }> {
    const metaPath = path.join(dirs.taskDir, 'meta.json');
    const promptPath = path.join(dirs.taskDir, 'prompt.md');
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    fs.writeFileSync(promptPath, '# Test prompt\nDo something.\n');
    // Reproduce production ownership: writeTaskFiles() chowns prompt.md and
    // meta.json to the agent user (uid 1000) so the container (which runs as
    // uid 1000) can append the usage-limit interruption note. Do NOT chmod
    // these world-writable — that masked issue #136, where root-owned mode
    // 0644 prompt.md blocked the append. Chowning to a foreign uid requires
    // the test to run as root, which the docker-gated CI/dev context does.
    fs.chownSync(metaPath, 1000, 1000);
    fs.chownSync(promptPath, 1000, 1000);

    const toDockerPath = (p: string) => p.replace(/\\/g, '/');

    const container = await docker.createContainer({
      Image: HARNESS_IMAGE,
      Env: env,
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

  // Bind-mounted repos are owned by the host user, so git inside the
  // container (uid 1000) trips the dubious-ownership guard without this.
  // Production doesn't need it — the orchestrator creates workspaces as
  // uid 1000 — so it belongs to the scripted agent, not the harness.
  const TRUST_REPO = 'git config --global --add safe.directory /repo >/dev/null 2>&1 || true';

  const USAGE_LIMIT_LINE =
    '{"type":"result","subtype":"error_during_execution","is_error":true,' +
    '"result":"Claude AI usage limit reached|1751234567","num_turns":1,' +
    '"usage":{"input_tokens":10,"output_tokens":5}}';

  const SUCCESS_LINE =
    '{"type":"result","subtype":"success","is_error":false,"result":"done",' +
    '"num_turns":3,"usage":{"input_tokens":100,"output_tokens":50}}';

  it('retries in-container after a usage-limit failure and succeeds on the second run', async () => {
    const dirs = setupDirs('usage-retry-success');

    // First run: leave uncommitted work, emit a usage-limit result, die.
    // Second run (marked by the state file): emit success.
    const agentCommand = [
      TRUST_REPO,
      'if [ -f /output/.mock-second-run ]; then',
      `  echo '${SUCCESS_LINE}'`,
      '  exit 0',
      'fi',
      'touch /output/.mock-second-run',
      'echo "partial work" > /repo/partial.txt',
      `echo '${USAGE_LIMIT_LINE}'`,
      'exit 1',
    ].join('\n');

    const { exitCode } = await runHarness(
      dirs,
      {
        role: 'develop',
        issue_id: 1,
        branch_name: 'main',
        attempt: 1,
        max_runtime_minutes: 5,
        agent_command: agentCommand,
        install_commands: [],
      },
      ['HARNESS_USAGE_RETRY_SECONDS=2']
    );

    expect(exitCode).toBe(0);

    const result = JSON.parse(
      fs.readFileSync(path.join(dirs.outputDir, 'result.json'), 'utf-8')
    );
    expect(result.status).toBe('success');
    // Usage summed across BOTH runs (10+100 in, 5+50 out, 1+3 turns)
    expect(result.usage).toEqual({ num_turns: 4, input_tokens: 110, output_tokens: 55 });

    // Observability: markers for the wait and the relaunch, both runs' output kept
    const log = fs.readFileSync(path.join(dirs.outputDir, 'progress.log'), 'utf-8');
    expect(log).toContain('Provider usage limit detected');
    expect(log).toContain('usage-limit retry 1');
    expect(log).toContain('Usage-limit wait over');
    expect(log).toContain('usage limit reached'); // first run's output preserved

    // Work preservation: uncommitted file was checkpoint-committed before the wait
    const gitLog = execFileSync('git', ['log', '--oneline'], {
      cwd: dirs.repoDir,
      encoding: 'utf-8',
    });
    expect(gitLog).toContain('WIP: auto-checkpoint before usage-limit retry 1');
    expect(fs.existsSync(path.join(dirs.repoDir, 'partial.txt'))).toBe(true);

    // Discovery: the interruption note was appended to the prompt exactly once
    const prompt = fs.readFileSync(path.join(dirs.taskDir, 'prompt.md'), 'utf-8');
    expect(prompt).toContain('Interrupted Earlier Run');
    expect(prompt.match(/usage-limit-interruption-note/g)).toHaveLength(1);
  });

  it('does NOT retry a non-usage failure — exits immediately with the structured error', async () => {
    const dirs = setupDirs('non-usage-failure');

    const errorLine =
      '{"type":"result","subtype":"error_during_execution","is_error":true,' +
      '"api_error_status":404,"result":"model not found: claude-nonexistent","num_turns":1}';

    // Counts runs so we can prove there was exactly one
    const agentCommand = [
      TRUST_REPO,
      'echo run >> /output/.mock-run-count',
      `echo '${errorLine}'`,
      'exit 1',
    ].join('\n');

    const { exitCode } = await runHarness(
      dirs,
      {
        role: 'develop',
        issue_id: 2,
        branch_name: 'main',
        attempt: 1,
        max_runtime_minutes: 5,
        agent_command: agentCommand,
        install_commands: [],
      },
      ['HARNESS_USAGE_RETRY_SECONDS=2']
    );

    expect(exitCode).toBe(0); // harness itself always exits 0

    const result = JSON.parse(
      fs.readFileSync(path.join(dirs.outputDir, 'result.json'), 'utf-8')
    );
    expect(result.status).toBe('failure');
    expect(result.error_message).toContain('[API 404]');
    expect(result.error_message).toContain('model not found');

    const runs = fs.readFileSync(path.join(dirs.outputDir, '.mock-run-count'), 'utf-8');
    expect(runs.trim().split('\n')).toHaveLength(1);

    const log = fs.readFileSync(path.join(dirs.outputDir, 'progress.log'), 'utf-8');
    expect(log).not.toContain('Provider usage limit detected');

    // No note appended for a non-usage failure
    const prompt = fs.readFileSync(path.join(dirs.taskDir, 'prompt.md'), 'utf-8');
    expect(prompt).not.toContain('Interrupted Earlier Run');
  });

  it('gives up (reports failure) when the runtime budget cannot fit another retry', async () => {
    const dirs = setupDirs('budget-exhausted');

    const agentCommand = [
      TRUST_REPO,
      'echo run >> /output/.mock-run-count',
      `echo '${USAGE_LIMIT_LINE}'`,
      'exit 1',
    ].join('\n');

    // 1-minute budget vs. a 600s retry interval: the harness must refuse to
    // sleep and report the usage-limit failure to the orchestrator instead.
    const { exitCode } = await runHarness(dirs, {
      role: 'develop',
      issue_id: 3,
      branch_name: 'main',
      attempt: 1,
      max_runtime_minutes: 1,
      agent_command: agentCommand,
      install_commands: [],
    });

    expect(exitCode).toBe(0);

    const result = JSON.parse(
      fs.readFileSync(path.join(dirs.outputDir, 'result.json'), 'utf-8')
    );
    expect(result.status).toBe('failure');
    expect(result.error_message).toContain('usage limit reached');

    const runs = fs.readFileSync(path.join(dirs.outputDir, '.mock-run-count'), 'utf-8');
    expect(runs.trim().split('\n')).toHaveLength(1);

    const log = fs.readFileSync(path.join(dirs.outputDir, 'progress.log'), 'utf-8');
    expect(log).toContain('runtime budget nearly exhausted');
  });

  it('review role: usage-limit retry works without touching the workspace or prompt', async () => {
    const dirs = setupDirs('review-usage-retry');

    const agentCommand = [
      'if [ -f /output/.mock-second-run ]; then',
      '  echo \'{"verdict":"approved","summary":"ok","feedback":[]}\' > /output/review.json',
      `  echo '${SUCCESS_LINE}'`,
      '  exit 0',
      'fi',
      'touch /output/.mock-second-run',
      `echo '${USAGE_LIMIT_LINE}'`,
      'exit 1',
    ].join('\n');

    const { exitCode } = await runHarness(
      dirs,
      {
        role: 'review',
        issue_id: 4,
        branch_name: 'main',
        attempt: 1,
        max_runtime_minutes: 5,
        agent_command: agentCommand,
        install_commands: [],
      },
      ['HARNESS_USAGE_RETRY_SECONDS=2']
    );

    expect(exitCode).toBe(0);

    const result = JSON.parse(
      fs.readFileSync(path.join(dirs.outputDir, 'result.json'), 'utf-8')
    );
    expect(result.status).toBe('success');

    const review = JSON.parse(
      fs.readFileSync(path.join(dirs.outputDir, 'review.json'), 'utf-8')
    );
    expect(review.verdict).toBe('approved');

    // Review runs never mutate the workspace or the prompt
    const gitLog = execFileSync('git', ['log', '--oneline'], {
      cwd: dirs.repoDir,
      encoding: 'utf-8',
    });
    expect(gitLog).not.toContain('WIP: auto-checkpoint');
    const prompt = fs.readFileSync(path.join(dirs.taskDir, 'prompt.md'), 'utf-8');
    expect(prompt).not.toContain('Interrupted Earlier Run');
  });
});
