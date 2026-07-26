import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Simulated git-host outage against the REAL Scheduler.fillSlots /
// handlePrepFailure paths (#144).
//
// Before this change, a `prepareWorkspace` rejection while Forgejo was
// unreachable requeued the task and the very next tick retried immediately —
// production logs show a task's 2nd and 3rd prep attempts ~300 ms apart — so
// three ticks inside one minute permanently failed it. Eleven queued tasks
// died that way during the 2026-07-23 outage.
//
// These tests drive the outage from the prepareWorkspace mock and assert on
// what the scheduler persists: escalating backoff, tasks that stay queued,
// other tasks that keep launching, unchanged fail-fast for structural
// errors, and automatic recovery once the fake host comes back.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  getRepo: vi.fn(),
  getAgentProfile: vi.fn(),
  getModel: vi.fn(),
  getProvider: vi.fn(),
  getProviders: vi.fn(),
  getSetting: vi.fn(),
  updateTask: vi.fn(),
  insertAttempt: vi.fn(),
  updateAttempt: vi.fn(),
  getRunningAttempt: vi.fn(),
  getLatestAttempt: vi.fn(),
  getActiveAttempt: vi.fn(),
  getTasks: vi.fn(),
  getTasksWithSalvageDue: vi.fn(),
  resolveStageProfileId: vi.fn(),
  countActiveByProvider: vi.fn(),
  canLaunchInPool: vi.fn(),
  limitMapFromProviders: vi.fn(),
  resolveProviderKey: vi.fn(),
  shouldDeferReviewLaunch: vi.fn(),
  createAgentContainer: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  waitForContainer: vi.fn(),
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  getCandidates: vi.fn(),
  getAvailableResources: vi.fn(),
  getTaskResources: vi.fn(),
  fitsInPool: vi.fn(),
  createDependencyPassState: vi.fn(),
  runQueuedDependencyPass: vi.fn(),
  dependencyGateAllows: vi.fn(),
  stripDependencySection: vi.fn(),
  prepareWorkspace: vi.fn(),
  verifyWorkspaceState: vi.fn(),
  getWorkdir: vi.fn(),
  getTaskDir: vi.fn(),
  getOutputDir: vi.fn(),
  getCacheDir: vi.fn(),
  generateBranchName: vi.fn(),
  writeHarnessConfigFiles: vi.fn(),
  getGitHostKey: vi.fn(),
  probeGitRemote: vi.fn(),
  postDevAgent: vi.fn(),
  handleDevFailure: vi.fn(),
  processReviewVerdict: vi.fn(),
  handleReviewFailure: vi.fn(),
  updateTaskWithSync: vi.fn(),
  notifyStreamComplete: vi.fn(),
  recordTaskEvent: vi.fn(),
  getSnapshot: vi.fn(),
  invalidateSnapshot: vi.fn(),
  runOrphanSweep: vi.fn(),
  reapOrphanedContainers: vi.fn(),
  getHarness: vi.fn(),
  buildProviderEnv: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  getTask: mocks.getTask,
  getRepo: mocks.getRepo,
  getAgentProfile: mocks.getAgentProfile,
  getModel: mocks.getModel,
  getProvider: mocks.getProvider,
  getProviders: mocks.getProviders,
  getSetting: mocks.getSetting,
  updateTask: mocks.updateTask,
  insertAttempt: mocks.insertAttempt,
  updateAttempt: mocks.updateAttempt,
  getRunningAttempt: mocks.getRunningAttempt,
  getLatestAttempt: mocks.getLatestAttempt,
  getActiveAttempt: mocks.getActiveAttempt,
  getTasks: mocks.getTasks,
  getTasksWithSalvageDue: mocks.getTasksWithSalvageDue,
  resolveStageProfileId: mocks.resolveStageProfileId,
}));

vi.mock('../../scheduler-pools.js', () => ({
  countActiveByProvider: mocks.countActiveByProvider,
  canLaunchInPool: mocks.canLaunchInPool,
  limitMapFromProviders: mocks.limitMapFromProviders,
  resolveProviderKey: mocks.resolveProviderKey,
  shouldDeferReviewLaunch: mocks.shouldDeferReviewLaunch,
}));

vi.mock('../../forgejo.js', () => ({ ForgejoClient: class {} }));

vi.mock('../../docker.js', () => ({
  createAgentContainer: mocks.createAgentContainer,
  startContainer: mocks.startContainer,
  stopContainer: mocks.stopContainer,
  removeContainer: mocks.removeContainer,
  waitForContainer: mocks.waitForContainer,
  listContainers: mocks.listContainers,
  getContainer: mocks.getContainer,
}));

vi.mock('../../queue.js', () => ({
  getCandidates: mocks.getCandidates,
  getAvailableResources: mocks.getAvailableResources,
  getTaskResources: mocks.getTaskResources,
  fitsInPool: mocks.fitsInPool,
}));

vi.mock('../../dependencies.js', () => ({
  createDependencyPassState: mocks.createDependencyPassState,
  runQueuedDependencyPass: mocks.runQueuedDependencyPass,
  dependencyGateAllows: mocks.dependencyGateAllows,
  stripDependencySection: mocks.stripDependencySection,
}));

vi.mock('../../workspace.js', () => ({
  prepareWorkspace: mocks.prepareWorkspace,
  verifyWorkspaceState: mocks.verifyWorkspaceState,
  getWorkdir: mocks.getWorkdir,
  getTaskDir: mocks.getTaskDir,
  getOutputDir: mocks.getOutputDir,
  getCacheDir: mocks.getCacheDir,
  generateBranchName: mocks.generateBranchName,
  writeHarnessConfigFiles: mocks.writeHarnessConfigFiles,
  getGitHostKey: mocks.getGitHostKey,
  probeGitRemote: mocks.probeGitRemote,
}));

vi.mock('../../agents/develop.js', () => ({
  postDevAgent: mocks.postDevAgent,
  handleDevFailure: mocks.handleDevFailure,
}));

vi.mock('../../agents/review.js', () => ({
  processReviewVerdict: mocks.processReviewVerdict,
  handleReviewFailure: mocks.handleReviewFailure,
}));

vi.mock('../../state-sync.js', () => ({
  updateTaskWithSync: mocks.updateTaskWithSync,
  notifyStreamComplete: mocks.notifyStreamComplete,
  recordTaskEvent: mocks.recordTaskEvent,
}));

vi.mock('../../forgejo-snapshot.js', () => ({
  getSnapshot: mocks.getSnapshot,
  invalidateSnapshot: mocks.invalidateSnapshot,
}));

vi.mock('../../orphan-recovery.js', () => ({ runOrphanSweep: mocks.runOrphanSweep }));
vi.mock('../../container-reaper.js', () => ({
  reapOrphanedContainers: mocks.reapOrphanedContainers,
}));
vi.mock('../../harnesses/index.js', () => ({ getHarness: mocks.getHarness }));
vi.mock('../../providers/kinds.js', () => ({ buildProviderEnv: mocks.buildProviderEnv }));

const { Scheduler } = await import('../../scheduler.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
} as any;

const fakeForgejo = {
  getIssue: vi.fn().mockResolvedValue({ title: 'Issue', body: 'body', labels: [] }),
  getBranch: vi.fn().mockResolvedValue({ commit: { id: 'sha123' } }),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
} as any;

/** The exact stderr Forgejo produced during the 2026-07-23 outage. */
const OUTAGE_ERROR =
  'git fetch failed: fatal: Could not read from remote repository.';
const CORRUPTION_ERROR =
  'git fetch failed: remote: fatal: bad tree object 4c1f0a9 remote: aborting due to possible repository corruption on the remote side';
/** A structural failure the categorizer already knows about. */
const STRUCTURAL_ERROR =
  '(HTTP code 404) no such container - No such image: orchestrator-agent:latest';
/** Mirrors the scheduler's module-local PREP_FAILURE_LIMIT — the shared
 *  budget of distinct prep incidents (structural failures and outage
 *  windows alike). */
const PREP_FAILURE_LIMIT = 3;

let store: Task[] = [];
let tmpDir: string;

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 1,
    issue_title: 'Test issue',
    repo_id: 1,
    branch_name: 'agent/issue-1-x',
    pr_number: null,
    status: 'queued',
    queue_position: 1,
    attempt: 1,
    max_attempts: 3,
    prep_failure_count: 0,
    prep_backoff_level: 0,
    prep_next_attempt_at: null,
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-07-23T00:00:00Z',
    ...overrides,
  };
}

function eventsOfType(type: string): string[] {
  return mocks.recordTaskEvent.mock.calls
    .filter((c) => c[1] === type)
    .map((c) => c[2] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-backoff-'));

  mocks.getTasks.mockImplementation(({ status }: { status: string }) =>
    store.filter((t) => t.status === status)
  );
  mocks.getTask.mockImplementation((id: number) => store.find((t) => t.id === id));
  const applyPatch = (id: number, patch: Partial<Task>) => {
    const t = store.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  };
  mocks.updateTask.mockImplementation(applyPatch);
  mocks.updateTaskWithSync.mockImplementation(applyPatch);

  // Inert tick sub-steps.
  mocks.getActiveAttempt.mockReturnValue(null);
  mocks.getRunningAttempt.mockReturnValue(undefined);
  mocks.insertAttempt.mockReturnValue({ id: 999 });
  mocks.getLatestAttempt.mockReturnValue({ id: 5, role: 'develop' });
  mocks.runOrphanSweep.mockResolvedValue(undefined);
  mocks.reapOrphanedContainers.mockResolvedValue(undefined);
  mocks.runQueuedDependencyPass.mockResolvedValue(undefined);
  mocks.createDependencyPassState.mockReturnValue({});
  mocks.getTasksWithSalvageDue.mockReturnValue([]);
  mocks.stripDependencySection.mockImplementation((s: string) => s ?? '');

  // Roomy host pool + unconstrained provider pools: the only thing that can
  // stop a launch in these tests is the outage gate under test.
  mocks.getAvailableResources.mockReturnValue({ memoryMb: 65536, cpuCores: 32 });
  mocks.getTaskResources.mockReturnValue({ memoryMb: 1024, cpuCores: 1 });
  mocks.fitsInPool.mockReturnValue(true);
  mocks.getProviders.mockReturnValue([]);
  mocks.limitMapFromProviders.mockReturnValue(new Map());
  mocks.countActiveByProvider.mockReturnValue(new Map());
  mocks.canLaunchInPool.mockReturnValue(true);
  mocks.resolveProviderKey.mockReturnValue('prov');
  mocks.dependencyGateAllows.mockReturnValue(true);
  mocks.getSnapshot.mockResolvedValue(null);
  mocks.getCandidates.mockImplementation(() =>
    store.filter((t) => t.status === 'queued')
  );

  // Workspace + docker plumbing.
  mocks.getWorkdir.mockReturnValue(tmpDir);
  mocks.getTaskDir.mockReturnValue(tmpDir);
  mocks.getOutputDir.mockReturnValue(tmpDir);
  mocks.getCacheDir.mockReturnValue(tmpDir);
  mocks.writeHarnessConfigFiles.mockResolvedValue(undefined);
  mocks.verifyWorkspaceState.mockResolvedValue(undefined);
  mocks.prepareWorkspace.mockResolvedValue(undefined);
  mocks.getGitHostKey.mockReturnValue('forgejo:3000');
  mocks.probeGitRemote.mockResolvedValue(false);
  mocks.createAgentContainer.mockResolvedValue({ id: 'dev1' });
  mocks.startContainer.mockResolvedValue(undefined);
  mocks.stopContainer.mockResolvedValue(undefined);
  mocks.removeContainer.mockResolvedValue(undefined);
  mocks.waitForContainer.mockReturnValue(new Promise(() => {}));
  mocks.getContainer.mockImplementation((id: string) => ({
    id,
    inspect: async () => ({ State: { Status: 'running', ExitCode: 0 } }),
    logs: async () => Buffer.from(''),
  }));

  // Launch-context resolution.
  mocks.getRepo.mockReturnValue({
    id: 1,
    owner: 'nik',
    name: 'agent-orchestrator',
    base_branch: 'main',
    install_steps: [],
    container_memory_mb: null,
    container_cpu_cores: null,
  });
  mocks.resolveStageProfileId.mockReturnValue({ id: 'prof', source: 'task' });
  mocks.getAgentProfile.mockReturnValue({
    id: 'prof',
    model_pk: 1,
    harness_id: 'h',
    timeout_minutes: 30,
  });
  mocks.getModel.mockReturnValue({ id: 1, provider_id: 'prov' });
  mocks.getProvider.mockReturnValue({ id: 'prov', kind: 'anthropic' });
  mocks.getHarness.mockReturnValue({
    id: 'h',
    runtime: 'cli',
    buildInvocation: () => ({
      resolved_model: 'model-x',
      extra_env: {},
      config_files: [],
      agent_command: 'run',
    }),
  });
  mocks.buildProviderEnv.mockReturnValue({});
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// 1. A simulated outage backs off instead of failing
// ---------------------------------------------------------------------------

describe('workspace-prep backoff under a simulated git-host outage', () => {
  it('parks the task with an escalating, minutes-scale backoff instead of failing it', async () => {
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    // The host answers `ls-remote` but real fetches still fail (the shape of
    // the corruption half of the incident). This isolates the per-task
    // backoff from the cross-task host gate, which is covered separately.
    mocks.probeGitRemote.mockResolvedValue(true);
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    const delays: number[] = [];
    // Six back-to-back ticks, as if the poll timer (and a couple of
    // webhooks) fired during the outage. Between ticks we rewind the
    // persisted next-attempt time so the backoff is *allowed* to elapse —
    // the spacing itself is asserted from the scheduled delay.
    for (let i = 0; i < 6; i++) {
      await scheduler.tick();
      const t = store[0];
      expect(t.status).toBe('queued');
      delays.push(Date.parse(t.prep_next_attempt_at!) - Date.now());
      t.prep_next_attempt_at = null; // pretend the wait elapsed
    }

    // Escalating: each wait is materially longer than the previous one
    // (jitter is ±20%, doubling is +100%, so strict growth holds).
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    // Minutes-scale from the very first retry — this is the regression:
    // the old code retried on the next tick, ~300 ms later.
    expect(delays[0]).toBeGreaterThan(30_000);
    // Capped so a long outage stays responsive when it ends. The cap is
    // applied before jitter, so the observed ceiling is cap ± the jitter band.
    expect(Math.max(...delays)).toBeLessThanOrEqual(30 * 60 * 1000 * 1.2);

    // Six failed prep attempts, and the task is STILL alive and queued.
    expect(store[0].status).toBe('queued');
    expect(store[0].completed_at).toBeNull();
    expect(store[0].prep_backoff_level).toBe(6);
  });

  it('charges the permanent-failure budget once per outage window, not per retry', async () => {
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error(CORRUPTION_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    for (let i = 0; i < 5; i++) {
      await scheduler.tick();
      store[0].prep_next_attempt_at = null;
    }

    // Five retries inside ONE outage = one unit of budget. Under the old
    // semantics this task would have been permanently failed after three.
    expect(store[0].prep_failure_count).toBe(1);
    expect(store[0].status).toBe('queued');
  });

  it('keeps waiting inside an open window even once the budget is spent', async () => {
    // The budget counts prep INCIDENTS, and it is only tested when one
    // starts. A task already backing off has nothing more to charge, so a
    // host that stays down for days keeps it queued rather than failing it —
    // the whole point of #144.
    store = [
      mkTask({
        id: 1,
        prep_failure_count: PREP_FAILURE_LIMIT,
        prep_backoff_level: 2,
        prep_next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      }),
    ];
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    mocks.probeGitRemote.mockResolvedValue(true);
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].status).toBe('queued');
    expect(store[0].completed_at).toBeNull();
    expect(store[0].prep_backoff_level).toBe(3);
    expect(store[0].prep_failure_count).toBe(PREP_FAILURE_LIMIT);
  });

  it('fails a task whose earlier, separate incidents already spent the budget', async () => {
    // The flip side of the shared budget: an outage window is a prep incident
    // like any other, so the third one is terminal (docs/02-task-state-machine).
    store = [
      mkTask({ id: 1, prep_failure_count: PREP_FAILURE_LIMIT - 1, prep_backoff_level: 0 }),
    ];
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    mocks.probeGitRemote.mockResolvedValue(true);
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].status).toBe('failed');
    expect(store[0].prep_failure_count).toBe(PREP_FAILURE_LIMIT);
    // No stale backoff state left behind on a terminal task.
    expect(store[0].prep_backoff_level).toBe(0);
    expect(store[0].prep_next_attempt_at).toBeNull();
    // The cause is still on the timeline, not just in the container logs.
    expect(eventsOfType('prep_failed')[0]).toContain('Could not read from remote repository');
  });

  it('leaves the task queued while the backoff is unexpired, and does not launch', async () => {
    store = [
      mkTask({
        id: 1,
        prep_backoff_level: 2,
        prep_next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    ];
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(mocks.prepareWorkspace).not.toHaveBeenCalled();
    expect(mocks.createAgentContainer).not.toHaveBeenCalled();
    expect(store[0].status).toBe('queued');
  });

  it('does not block other runnable tasks while one is backing off', async () => {
    store = [
      mkTask({
        id: 1,
        queue_position: 1,
        prep_backoff_level: 1,
        prep_next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
      mkTask({ id: 2, issue_id: 2, queue_position: 2, branch_name: 'agent/issue-2-y' }),
    ];
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    // The healthy task launched even though it sits behind the backing-off
    // one in FIFO order.
    expect(mocks.createAgentContainer).toHaveBeenCalledTimes(1);
    expect(store[0].status).toBe('queued');
    expect(store[1].status).toBe('in-progress');
  });

  it('records the underlying git error on the timeline', async () => {
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error(CORRUPTION_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    const prepFailed = eventsOfType('prep_failed');
    expect(prepFailed).toHaveLength(1);
    expect(prepFailed[0]).toContain('bad tree object');
    expect(prepFailed[0]).toContain('repository corruption on the remote side');

    // …and an operator-facing note about when it will be retried.
    const backoff = eventsOfType('prep_backoff');
    expect(backoff).toHaveLength(1);
    expect(backoff[0]).toMatch(/retry 1 scheduled in/i);
  });

  it('classifies on the full git stderr, not the truncated event text', async () => {
    // The outage signature sits past the 500-char event limit. Classifying
    // the truncated copy would read this as structural and start counting
    // the task down to a permanent failure.
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(
      new Error(
        `git fetch failed: ${'remote: Enumerating objects\n'.repeat(40)}fatal: Could not read from remote repository.`
      )
    );
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].prep_next_attempt_at).not.toBeNull();
    expect(eventsOfType('prep_backoff')).toHaveLength(1);
    // …and the recorded copy IS truncated, so the timeline stays readable.
    expect(eventsOfType('prep_failed')[0].length).toBeLessThan(600);
  });

  it('never writes an agent token into the timeline', async () => {
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(
      new Error(
        "git clone failed: fatal: unable to access 'http://agent:s3cr3t@forgejo:3000/nik/r.git/': Connection refused"
      )
    );
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    for (const message of eventsOfType('prep_failed')) {
      expect(message).not.toContain('s3cr3t');
      expect(message).toContain('***@forgejo:3000');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-task host gate + recovery
// ---------------------------------------------------------------------------

describe('git-host gate across tasks', () => {
  it('stops walking the queue into a dead host after consecutive failures', async () => {
    store = [
      mkTask({ id: 1, issue_id: 1, queue_position: 1 }),
      mkTask({ id: 2, issue_id: 2, queue_position: 2 }),
      mkTask({ id: 3, issue_id: 3, queue_position: 3 }),
      mkTask({ id: 4, issue_id: 4, queue_position: 4 }),
      mkTask({ id: 5, issue_id: 5, queue_position: 5 }),
    ];
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    // Three failures gate the host; tasks 4 and 5 were never even attempted.
    expect(mocks.prepareWorkspace).toHaveBeenCalledTimes(3);
    expect(store.every((t) => t.status === 'queued')).toBe(true);
    expect(store[3].prep_failure_count).toBe(0);
    expect(store[4].prep_failure_count).toBe(0);
  });

  it('holds the gate closed while the liveness probe keeps failing', async () => {
    store = [mkTask({ id: 1 }), mkTask({ id: 2, issue_id: 2 }), mkTask({ id: 3, issue_id: 3 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick(); // gates the host
    mocks.prepareWorkspace.mockClear();
    // Clear the per-task backoff so ONLY the host gate can hold them back.
    for (const t of store) t.prep_next_attempt_at = null;

    await scheduler.tick();

    expect(mocks.probeGitRemote).toHaveBeenCalled();
    expect(mocks.prepareWorkspace).not.toHaveBeenCalled();
  });

  it('resumes without operator intervention once the host comes back', async () => {
    store = [mkTask({ id: 1 }), mkTask({ id: 2, issue_id: 2 }), mkTask({ id: 3, issue_id: 3 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();
    expect(store.every((t) => t.status === 'queued')).toBe(true);

    // The fake host recovers: the probe succeeds and prep works again.
    mocks.probeGitRemote.mockResolvedValue(true);
    mocks.prepareWorkspace.mockResolvedValue(undefined);
    for (const t of store) t.prep_next_attempt_at = null;

    await scheduler.tick();

    expect(store.every((t) => t.status === 'in-progress')).toBe(true);
    // Backoff state cleared, and the recovery is visible on the timeline.
    expect(store.every((t) => t.prep_backoff_level === 0)).toBe(true);
    expect(store.every((t) => t.prep_next_attempt_at === null)).toBe(true);
    expect(eventsOfType('prep_recovered').length).toBe(3);
  });

  it('does not gate the host on a non-git failure (e.g. an unreachable Docker daemon)', async () => {
    store = [
      mkTask({ id: 1, issue_id: 1 }),
      mkTask({ id: 2, issue_id: 2 }),
      mkTask({ id: 3, issue_id: 3 }),
      mkTask({ id: 4, issue_id: 4 }),
    ];
    mocks.createAgentContainer.mockRejectedValue(
      new Error('connect ECONNREFUSED /var/run/docker.sock')
    );
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    // Every task was attempted — the Docker outage backs each task off
    // individually but says nothing about the git host's health.
    expect(mocks.prepareWorkspace).toHaveBeenCalledTimes(4);
    expect(mocks.probeGitRemote).not.toHaveBeenCalled();
    expect(store.every((t) => t.status === 'queued')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Structural failures keep failing fast
// ---------------------------------------------------------------------------

describe('structural prep failures (unchanged behaviour)', () => {
  it('retries immediately — no backoff timestamp is written', async () => {
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error(STRUCTURAL_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].status).toBe('queued');
    expect(store[0].prep_failure_count).toBe(1);
    expect(store[0].prep_next_attempt_at).toBeNull();
    expect(store[0].prep_backoff_level).toBe(0);
    expect(eventsOfType('prep_backoff')).toHaveLength(0);
    // The actionable operator message is still recorded.
    expect(eventsOfType('agent_image_missing')).toHaveLength(1);
  });

  it('permanently fails on the third failure, exactly as before', async () => {
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error(STRUCTURAL_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();
    await scheduler.tick();
    expect(store[0].status).toBe('queued');
    await scheduler.tick();

    expect(store[0].status).toBe('failed');
    expect(store[0].prep_failure_count).toBe(3);
    expect(store[0].completed_at).not.toBeNull();
  });

  it('fails fast for an unrecognised (neither structural nor infra) error', async () => {
    store = [mkTask({ id: 1 })];
    mocks.prepareWorkspace.mockRejectedValue(new Error('something entirely new'));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(store[0].status).toBe('failed');
    // The cause is still on the timeline instead of only in container logs.
    expect(eventsOfType('prep_failed').at(-1)).toContain('something entirely new');
  });

  it('a structural failure after an outage window clears the backoff state', async () => {
    store = [
      mkTask({
        id: 1,
        prep_backoff_level: 3,
        prep_next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      }),
    ];
    mocks.prepareWorkspace.mockRejectedValue(new Error(STRUCTURAL_ERROR));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].prep_backoff_level).toBe(0);
    expect(store[0].prep_next_attempt_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Deferred-salvage retry sweep
// ---------------------------------------------------------------------------

describe('deferred-salvage retry sweep', () => {
  it('re-runs postDevAgent for a due task and continues to review on success', async () => {
    const deferred = mkTask({
      id: 7,
      status: 'in-progress',
      salvage_backoff_level: 2,
      salvage_next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    });
    store = [deferred];
    mocks.getTasksWithSalvageDue.mockReturnValue([deferred]);
    mocks.postDevAgent.mockResolvedValue(true);
    mocks.shouldDeferReviewLaunch.mockReturnValue(false);
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(mocks.postDevAgent).toHaveBeenCalledTimes(1);
    // The rescued task goes straight to review, no operator involvement.
    expect(mocks.createAgentContainer).toHaveBeenCalledTimes(1);
    expect(store[0].status).toBe('in-review');
  });

  it('leaves the task alone while the git host is still gated', async () => {
    const deferred = mkTask({
      id: 7,
      status: 'in-progress',
      salvage_next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    });
    // Three queued tasks fail prep first, closing the host gate on this tick.
    store = [
      mkTask({ id: 1, issue_id: 1 }),
      mkTask({ id: 2, issue_id: 2 }),
      mkTask({ id: 3, issue_id: 3 }),
      deferred,
    ];
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    mocks.getTasksWithSalvageDue.mockReturnValue([deferred]);
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick(); // gates the host
    mocks.postDevAgent.mockClear();
    await scheduler.tick(); // sweep must not push into a dead host

    expect(mocks.postDevAgent).not.toHaveBeenCalled();
  });

  it('re-arms the backoff when the retry breaks before reaching the push', async () => {
    // postDevAgent handles push failures itself; a throw means the re-run
    // broke earlier (corrupt workspace, I/O error). The due timestamp is
    // already in the past, so without re-arming, the sweep would re-run the
    // same failing re-attempt on every tick, seconds apart, forever.
    const deferred = mkTask({
      id: 7,
      status: 'in-progress',
      salvage_backoff_level: 2,
      salvage_next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    });
    store = [deferred];
    mocks.getTasksWithSalvageDue.mockReturnValue([deferred]);
    mocks.postDevAgent.mockRejectedValue(new Error('EIO: i/o error, stat /workspaces/7'));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].salvage_backoff_level).toBe(3);
    // Spaced by the same escalating backoff a failed push earns, not retried
    // on the next tick.
    const delay = Date.parse(store[0].salvage_next_attempt_at!) - Date.now();
    expect(delay).toBeGreaterThan(60_000);
    // Still deferred, not failed — the work stays on disk.
    expect(store[0].status).toBe('in-progress');
    const events = eventsOfType('salvage_deferred');
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('EIO');
  });

  it('does not re-arm salvage when the push succeeded and the follow-on failed', async () => {
    // A successful re-run clears the deferral; if continueToReview is what
    // threw, re-arming would drag the task back through a salvage it has
    // already completed.
    const deferred = mkTask({
      id: 7,
      status: 'in-progress',
      salvage_backoff_level: 2,
      salvage_next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    });
    store = [deferred];
    mocks.getTasksWithSalvageDue.mockReturnValue([deferred]);
    mocks.postDevAgent.mockImplementation(async () => {
      // What the real postDevAgent does once the push lands.
      store[0].salvage_backoff_level = 0;
      store[0].salvage_next_attempt_at = null;
      return true;
    });
    mocks.shouldDeferReviewLaunch.mockReturnValue(false);
    mocks.createAgentContainer.mockRejectedValue(new Error('docker daemon unreachable'));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].salvage_next_attempt_at).toBeNull();
    expect(store[0].salvage_backoff_level).toBe(0);
    expect(eventsOfType('salvage_deferred')).toHaveLength(0);
  });

  it('does not turn a deferred salvage into a fresh dev attempt', async () => {
    // Dev container exited with a timeout; postDevAgent defers the salvage
    // (returns false) but leaves the task alive. handleDevFailure would
    // relaunch an agent on top of the very work being preserved.
    store = [
      mkTask({
        id: 1,
        status: 'in-progress',
        container_id: 'c1',
        salvage_backoff_level: 1,
        salvage_next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    ];
    fs.writeFileSync(
      path.join(tmpDir, 'result.json'),
      JSON.stringify({ status: 'timeout' })
    );
    mocks.getContainer.mockImplementation((id: string) => ({
      id,
      inspect: async () => ({ State: { Status: 'exited', ExitCode: 124 } }),
      logs: async () => Buffer.from(''),
    }));
    mocks.postDevAgent.mockResolvedValue(false);
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(mocks.handleDevFailure).not.toHaveBeenCalled();
    expect(store[0].status).toBe('in-progress');
  });
});

// ---------------------------------------------------------------------------
// 5. Recovery bookkeeping
// ---------------------------------------------------------------------------

describe('prep recovery bookkeeping', () => {
  it('clears backoff state on the first successful prepare and opens a fresh window next time', async () => {
    store = [
      mkTask({
        id: 1,
        prep_failure_count: 1,
        prep_backoff_level: 4,
        prep_next_attempt_at: new Date(Date.now() - 1000).toISOString(),
      }),
    ];
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].status).toBe('in-progress');
    expect(store[0].prep_backoff_level).toBe(0);
    expect(store[0].prep_next_attempt_at).toBeNull();
    // prep_failure_count is an audit counter (the reliability roll-up reads
    // it) — recovery clears the backoff, not the history.
    expect(store[0].prep_failure_count).toBe(1);

    // A later, separate outage opens a NEW window and charges the budget again.
    store[0].status = 'queued';
    store[0].container_id = null;
    mocks.prepareWorkspace.mockRejectedValue(new Error(OUTAGE_ERROR));
    await scheduler.tick();
    expect(store[0].prep_failure_count).toBe(2);
    expect(store[0].prep_backoff_level).toBe(1);
  });
});
