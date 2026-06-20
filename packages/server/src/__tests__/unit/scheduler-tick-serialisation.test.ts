import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// This suite exercises the REAL Scheduler.tick() / checkCompletedContainers /
// processCompletedContainer / continueToReview paths against mocked module
// dependencies, to prove the concurrency fixes for issue #109:
//
//   1. tick() is serialised — overlapping triggers process an exited
//      container exactly once (no double-dispatch, no duplicate launch).
//   2. processCompletedContainer only nulls container_id when removal
//      genuinely succeeds; a failed removal leaves it set for retry.
//   3. The develop→review and deferred-review transitions each launch /
//      defer exactly once across overlapping ticks.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // db.js
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
  resolveStageProfileId: vi.fn(),
  // scheduler-pools.js
  countActiveByProvider: vi.fn(),
  canLaunchInPool: vi.fn(),
  limitMapFromProviders: vi.fn(),
  resolveProviderKey: vi.fn(),
  shouldDeferReviewLaunch: vi.fn(),
  // docker.js
  createAgentContainer: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  waitForContainer: vi.fn(),
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  // queue.js
  getCandidates: vi.fn(),
  getAvailableResources: vi.fn(),
  getTaskResources: vi.fn(),
  fitsInPool: vi.fn(),
  // dependencies.js
  createDependencyPassState: vi.fn(),
  runQueuedDependencyPass: vi.fn(),
  dependencyGateAllows: vi.fn(),
  stripDependencySection: vi.fn(),
  // workspace.js
  prepareWorkspace: vi.fn(),
  verifyWorkspaceState: vi.fn(),
  getWorkdir: vi.fn(),
  getTaskDir: vi.fn(),
  getOutputDir: vi.fn(),
  getCacheDir: vi.fn(),
  generateBranchName: vi.fn(),
  writeHarnessConfigFiles: vi.fn(),
  // agents
  postDevAgent: vi.fn(),
  handleDevFailure: vi.fn(),
  processReviewVerdict: vi.fn(),
  handleReviewFailure: vi.fn(),
  // state-sync.js
  updateTaskWithSync: vi.fn(),
  notifyStreamComplete: vi.fn(),
  recordTaskEvent: vi.fn(),
  // forgejo-snapshot.js
  getSnapshot: vi.fn(),
  invalidateSnapshot: vi.fn(),
  // orphan-recovery.js
  runOrphanSweep: vi.fn(),
  // container-reaper.js
  reapOrphanedContainers: vi.fn(),
  // harnesses
  getHarness: vi.fn(),
  // providers/kinds.js
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

vi.mock('../../orphan-recovery.js', () => ({
  runOrphanSweep: mocks.runOrphanSweep,
}));

vi.mock('../../container-reaper.js', () => ({
  reapOrphanedContainers: mocks.reapOrphanedContainers,
}));

vi.mock('../../harnesses/index.js', () => ({
  getHarness: mocks.getHarness,
}));

vi.mock('../../providers/kinds.js', () => ({
  buildProviderEnv: mocks.buildProviderEnv,
}));

const { Scheduler } = await import('../../scheduler.js');

// ---------------------------------------------------------------------------
// Fixtures + stateful task store
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

let store: Task[] = [];
let tmpDir: string;

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    issue_id: 1,
    issue_title: 'Test issue',
    repo_id: 1,
    branch_name: 'feat/x',
    pr_number: 7,
    status: 'in-progress',
    queue_position: null,
    attempt: 1,
    max_attempts: 3,
    prep_failure_count: 0,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: 'c1',
    started_at: '2026-06-20T00:00:00Z',
    completed_at: null,
    created_at: '2026-06-20T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));

  // --- stateful db mocks over `store` ---
  mocks.getTasks.mockImplementation(({ status }: { status: string }) =>
    store.filter((t) => t.status === status)
  );
  mocks.getTask.mockImplementation((id: number) =>
    store.find((t) => t.id === id)
  );
  const applyPatch = (id: number, patch: Partial<Task>) => {
    const t = store.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  };
  mocks.updateTask.mockImplementation(applyPatch);
  mocks.updateTaskWithSync.mockImplementation(applyPatch);

  // enforceTimeouts → getActiveAttempt(null) → early return (no kill).
  mocks.getActiveAttempt.mockReturnValue(null);
  // completeAttempt recovery path.
  mocks.getRunningAttempt.mockReturnValue(undefined);
  mocks.insertAttempt.mockReturnValue({ id: 999 });
  mocks.getLatestAttempt.mockReturnValue({ id: 5, role: 'develop' });

  // tick sub-steps that should be inert.
  mocks.runOrphanSweep.mockResolvedValue(undefined);
  mocks.reapOrphanedContainers.mockResolvedValue(undefined);
  mocks.runQueuedDependencyPass.mockResolvedValue(undefined);
  mocks.createDependencyPassState.mockReturnValue({});
  // fillSlots early-return: no host capacity.
  mocks.getAvailableResources.mockReturnValue({ memoryMb: 0, cpuCores: 0 });
  mocks.getProviders.mockReturnValue([]);
  mocks.limitMapFromProviders.mockReturnValue(new Map());
  mocks.stripDependencySection.mockImplementation((s: string) => s ?? '');

  // workspace dir resolvers → real temp dir so file reads/writes are sandboxed.
  mocks.getWorkdir.mockReturnValue(tmpDir);
  mocks.getTaskDir.mockReturnValue(tmpDir);
  mocks.getOutputDir.mockReturnValue(tmpDir);
  mocks.getCacheDir.mockReturnValue(tmpDir);
  mocks.writeHarnessConfigFiles.mockResolvedValue(undefined);

  // docker: exited only for 'c1'; everything else (e.g. a freshly-launched
  // review container) is 'running'.
  mocks.getContainer.mockImplementation((id: string) => ({
    id,
    inspect: async () => ({
      State: { Status: id === 'c1' ? 'exited' : 'running', ExitCode: 0 },
    }),
    logs: async () => Buffer.from(''),
    remove: async () => {},
  }));
  mocks.removeContainer.mockResolvedValue(undefined);
  mocks.startContainer.mockResolvedValue(undefined);
  mocks.stopContainer.mockResolvedValue(undefined);
  // wait callback never fires — avoids re-triggering ticks during the test.
  mocks.waitForContainer.mockReturnValue(new Promise(() => {}));
  mocks.createAgentContainer.mockResolvedValue({ id: 'rev1' });

  // handlers
  mocks.handleDevFailure.mockResolvedValue(undefined);
  mocks.handleReviewFailure.mockResolvedValue({ shouldRetry: false, newRetryCount: 0 });
  mocks.processReviewVerdict.mockResolvedValue(undefined);

  // launch-context resolution (used by the success/launch paths).
  mocks.getRepo.mockReturnValue({
    id: 1,
    owner: 'o',
    name: 'r',
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

function writeResult(status: 'success' | 'failure'): void {
  fs.writeFileSync(path.join(tmpDir, 'result.json'), JSON.stringify({ status }));
}

// ---------------------------------------------------------------------------
// 1. Serialisation: overlapping ticks process an exited container once
// ---------------------------------------------------------------------------

describe('tick() serialisation', () => {
  it('processes a single exited container exactly once under overlapping ticks', async () => {
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'c1' })];
    // No result.json → failure path, no downstream launch.
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    // Fire four overlapping ticks. With the re-entrancy guard, one runs and
    // exactly one trailing tick follows; the trailing tick sees container_id
    // already nulled and does nothing.
    await Promise.all([
      scheduler.tick(),
      scheduler.tick(),
      scheduler.tick(),
      scheduler.tick(),
    ]);

    // notifyStreamComplete fires once per processCompletedContainer call.
    expect(mocks.notifyStreamComplete).toHaveBeenCalledTimes(1);
    expect(mocks.handleDevFailure).toHaveBeenCalledTimes(1);
    // container_id nulled after the successful removal.
    expect(store[0].container_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Conditional container_id nulling
// ---------------------------------------------------------------------------

describe('processCompletedContainer container_id handling', () => {
  it('keeps container_id set when removal fails, and retries on a later tick', async () => {
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'c1' })];
    // Removal genuinely errors (not a 404) on the first attempt.
    mocks.removeContainer.mockRejectedValueOnce(new Error('daemon error'));
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    // container_id is preserved — the DB must not forget the lingering
    // container.
    expect(store[0].container_id).toBe('c1');
    expect(mocks.updateTask).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ container_id: null })
    );

    // A later tick retries removal; this time it succeeds and clears the id.
    mocks.removeContainer.mockResolvedValue(undefined);
    await scheduler.tick();
    expect(store[0].container_id).toBeNull();
  });

  it('nulls container_id when removal succeeds (incl. a 404 "already gone")', async () => {
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'c1' })];
    // The real docker.removeContainer swallows a 404 and resolves — model
    // that here as a plain resolve.
    mocks.removeContainer.mockResolvedValue(undefined);
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].container_id).toBeNull();
    expect(mocks.updateTask).toHaveBeenCalledWith(1, { container_id: null });
  });
});

// ---------------------------------------------------------------------------
// 3. No duplicate launch across overlapping ticks
// ---------------------------------------------------------------------------

describe('develop→review transition under overlapping ticks', () => {
  it('launches exactly one review container', async () => {
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'c1' })];
    writeResult('success');
    mocks.postDevAgent.mockResolvedValue(true); // dev produced a PR → review
    mocks.shouldDeferReviewLaunch.mockReturnValue(false); // launch immediately
    mocks.getModel.mockReturnValue({ id: 1, provider_id: 'prov' });

    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await Promise.all([
      scheduler.tick(),
      scheduler.tick(),
      scheduler.tick(),
    ]);

    // Exactly one review container created despite three overlapping ticks.
    expect(mocks.createAgentContainer).toHaveBeenCalledTimes(1);
    expect(mocks.notifyStreamComplete).toHaveBeenCalledTimes(1);
    // Task transitioned to in-review with the new container.
    expect(store[0].status).toBe('in-review');
    expect(store[0].container_id).toBe('rev1');
  });
});

// ---------------------------------------------------------------------------
// 4. Launch-failure cleanup: a partially-successful launch must not leak the
//    just-created container (issue #111).
// ---------------------------------------------------------------------------

describe('launchDevContainer failure cleanup', () => {
  it('stops+removes the created container when startContainer throws, then rethrows', async () => {
    const task = mkTask({
      id: 1,
      status: 'queued',
      container_id: null,
      branch_name: 'feat/x',
    });
    store = [task];
    mocks.getModel.mockReturnValue({ id: 1, provider_id: 'prov' });
    mocks.createAgentContainer.mockResolvedValue({ id: 'dev1' });
    mocks.startContainer.mockRejectedValue(new Error('start boom'));

    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await expect(scheduler.launchDevContainer(task)).rejects.toThrow('start boom');

    // The just-created container is reaped before the error propagates.
    expect(mocks.stopContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dev1' })
    );
    expect(mocks.removeContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dev1' })
    );
    // No untracked container left behind: container_id was never persisted.
    expect(store[0].container_id).toBeNull();
  });

  it('reaps the container when the container_id persist throws', async () => {
    const task = mkTask({
      id: 1,
      status: 'queued',
      container_id: null,
      branch_name: 'feat/x',
    });
    store = [task];
    mocks.getModel.mockReturnValue({ id: 1, provider_id: 'prov' });
    mocks.createAgentContainer.mockResolvedValue({ id: 'dev1' });
    mocks.startContainer.mockResolvedValue(undefined);
    // Throw only on the container_id persist; other updateTaskWithSync calls
    // (e.g. status:'preparing') still mutate the store.
    mocks.updateTaskWithSync.mockImplementation((id: number, patch: Partial<Task>) => {
      if (patch.container_id) throw new Error('persist boom');
      const t = store.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });

    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await expect(scheduler.launchDevContainer(task)).rejects.toThrow('persist boom');

    expect(mocks.removeContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dev1' })
    );
  });

  it('still surfaces the original launch error when cleanup removal fails (non-404)', async () => {
    const task = mkTask({
      id: 1,
      status: 'queued',
      container_id: null,
      branch_name: 'feat/x',
    });
    store = [task];
    mocks.getModel.mockReturnValue({ id: 1, provider_id: 'prov' });
    mocks.createAgentContainer.mockResolvedValue({ id: 'dev1' });
    mocks.startContainer.mockRejectedValue(new Error('start boom'));
    // Cleanup itself errors with a non-404 — must be swallowed, original error wins.
    mocks.removeContainer.mockRejectedValue(new Error('daemon error'));

    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await expect(scheduler.launchDevContainer(task)).rejects.toThrow('start boom');
    expect(mocks.removeContainer).toHaveBeenCalled();
  });
});

describe('launchReviewContainer failure cleanup', () => {
  it('stops+removes the created container when startContainer throws, then rethrows', async () => {
    const task = mkTask({
      id: 1,
      status: 'in-review',
      container_id: null,
      branch_name: 'feat/x',
    });
    store = [task];
    mocks.getModel.mockReturnValue({ id: 1, provider_id: 'prov' });
    mocks.createAgentContainer.mockResolvedValue({ id: 'rev1' });
    mocks.startContainer.mockRejectedValue(new Error('start boom'));

    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await expect(scheduler.launchReviewContainer(task)).rejects.toThrow('start boom');

    expect(mocks.stopContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rev1' })
    );
    expect(mocks.removeContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rev1' })
    );
    expect(store[0].container_id).toBeNull();
  });
});

describe('deferred-review transition under overlapping ticks', () => {
  it('defers the review exactly once and launches nothing', async () => {
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'c1' })];
    writeResult('success');
    mocks.postDevAgent.mockResolvedValue(true);
    mocks.shouldDeferReviewLaunch.mockReturnValue(true); // provider saturated
    mocks.getModel.mockReturnValue({ id: 1, provider_id: 'prov' });

    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await Promise.all([
      scheduler.tick(),
      scheduler.tick(),
      scheduler.tick(),
    ]);

    // Deferred: parked as in-review with NO container, exactly one event.
    expect(mocks.createAgentContainer).not.toHaveBeenCalled();
    const deferEvents = mocks.recordTaskEvent.mock.calls.filter(
      (c) => c[1] === 'review_deferred'
    );
    expect(deferEvents).toHaveLength(1);
    expect(store[0].status).toBe('in-review');
    expect(store[0].container_id).toBeNull();
  });
});
