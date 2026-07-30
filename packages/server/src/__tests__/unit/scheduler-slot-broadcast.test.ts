/**
 * Slot-transition `status_changed` broadcasts (issue #149).
 *
 * The dashboard's host-pool gauge and queue depth used to move only when
 * each open tab's 5-second `GET /api/status` poll came round — that poll
 * existed almost entirely for this. The scheduler now pushes a
 * `status_changed` frame when a tick actually takes or gives back a
 * resource slot, and — importantly — stays silent otherwise, so slowing the
 * poll to a backstop cadence costs nothing.
 *
 * The whole scheduler dependency graph is mocked (same harness style as
 * scheduler-tick-serialisation.test.ts); `getActiveResources` /
 * `getQueuedTasks` are computed from the same task store the rest of the
 * tick mutates, so a launch or a completion moves them exactly as it would
 * against a real DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '@orchestrator/shared';

const mocks = vi.hoisted(() => ({
  // db.js
  getTask: vi.fn(),
  getRepo: vi.fn(),
  getAgentProfile: vi.fn(),
  getModel: vi.fn(),
  getProvider: vi.fn(),
  getProviders: vi.fn(),
  getSetting: vi.fn(),
  updateTaskRaw: vi.fn(),
  insertAttempt: vi.fn(),
  updateAttempt: vi.fn(),
  getRunningAttempt: vi.fn(),
  getLatestAttempt: vi.fn(),
  getActiveAttempt: vi.fn(),
  getTasks: vi.fn(),
  getQueuedTasks: vi.fn(),
  getTasksWithSalvageDue: vi.fn(),
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
  getActiveResources: vi.fn(),
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
  getGitHostKey: vi.fn(),
  probeGitRemote: vi.fn(),
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
  // ws/dashboard.js — the subject of this suite
  broadcastStatusChanged: vi.fn(),
}));

vi.mock('../../db.js', () => ({
  getTask: mocks.getTask,
  getRepo: mocks.getRepo,
  getAgentProfile: mocks.getAgentProfile,
  getModel: mocks.getModel,
  getProvider: mocks.getProvider,
  getProviders: mocks.getProviders,
  getSetting: mocks.getSetting,
  updateTaskRaw: mocks.updateTaskRaw,
  insertAttempt: mocks.insertAttempt,
  updateAttempt: mocks.updateAttempt,
  getRunningAttempt: mocks.getRunningAttempt,
  getLatestAttempt: mocks.getLatestAttempt,
  getActiveAttempt: mocks.getActiveAttempt,
  getTasks: mocks.getTasks,
  getQueuedTasks: mocks.getQueuedTasks,
  getTasksWithSalvageDue: mocks.getTasksWithSalvageDue,
  resolveStageProfileId: mocks.resolveStageProfileId,
}));

vi.mock('../../ws/dashboard.js', () => ({
  broadcastStatusChanged: mocks.broadcastStatusChanged,
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
  getActiveResources: mocks.getActiveResources,
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

vi.mock('../../orphan-recovery.js', () => ({
  runOrphanSweep: mocks.runOrphanSweep,
}));

vi.mock('../../container-reaper.js', () => ({
  reapOrphanedContainers: mocks.reapOrphanedContainers,
}));

vi.mock('../../harnesses/index.js', () => ({ getHarness: mocks.getHarness }));

vi.mock('../../providers/kinds.js', () => ({
  buildProviderEnv: mocks.buildProviderEnv,
}));

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

/** Footprint of one container, as the fake pool accounts for it. */
const TASK_MEMORY_MB = 2048;
const TASK_CPU_CORES = 2;
const POOL_MEMORY_MB = 8192;
const POOL_CPU_CORES = 8;

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
    prep_backoff_level: 0,
    prep_next_attempt_at: null,
    salvage_backoff_level: 0,
    salvage_next_attempt_at: null,
    agent_profile_id: null,
    review_agent_profile_id: null,
    container_id: 'c1',
    started_at: '2026-06-20T00:00:00Z',
    completed_at: null,
    created_at: '2026-06-20T00:00:00Z',
    ...overrides,
  };
}

/** Tasks holding a container, i.e. occupying host resources. */
function activeTasks(): Task[] {
  return store.filter(
    (t) =>
      ['preparing', 'in-progress', 'in-review'].includes(t.status) &&
      t.container_id !== null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-slot-test-'));

  mocks.getTasks.mockImplementation(({ status }: { status: string }) =>
    store.filter((t) => t.status === status)
  );
  mocks.getQueuedTasks.mockImplementation(() =>
    store.filter((t) => t.status === 'queued')
  );
  mocks.getTask.mockImplementation((id: number) => store.find((t) => t.id === id));
  const applyPatch = (id: number, patch: Partial<Task>) => {
    const t = store.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  };
  mocks.updateTaskRaw.mockImplementation(applyPatch);
  mocks.updateTaskWithSync.mockImplementation(applyPatch);

  // Host pool derived from the same store the tick mutates — a launch or a
  // completion moves it exactly as it would against the real queue.ts.
  mocks.getActiveResources.mockImplementation(() => ({
    memoryMb: activeTasks().length * TASK_MEMORY_MB,
    cpuCores: activeTasks().length * TASK_CPU_CORES,
  }));
  mocks.getAvailableResources.mockImplementation(() => ({
    memoryMb: POOL_MEMORY_MB - activeTasks().length * TASK_MEMORY_MB,
    cpuCores: POOL_CPU_CORES - activeTasks().length * TASK_CPU_CORES,
  }));
  mocks.getTaskResources.mockReturnValue({
    memoryMb: TASK_MEMORY_MB,
    cpuCores: TASK_CPU_CORES,
  });
  mocks.fitsInPool.mockImplementation(
    (need: { memoryMb: number; cpuCores: number }, avail: { memoryMb: number; cpuCores: number }) =>
      need.memoryMb <= avail.memoryMb && need.cpuCores <= avail.cpuCores
  );

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

  // Candidate gating: everything allowed, so a queued task launches.
  mocks.getCandidates.mockImplementation(() =>
    store.filter((t) => t.status === 'queued')
  );
  mocks.dependencyGateAllows.mockReturnValue(true);
  mocks.canLaunchInPool.mockReturnValue(true);
  mocks.countActiveByProvider.mockReturnValue(new Map());
  mocks.limitMapFromProviders.mockReturnValue(new Map());
  mocks.resolveProviderKey.mockReturnValue('prov');
  mocks.getProviders.mockReturnValue([]);
  mocks.getSnapshot.mockResolvedValue(null);

  mocks.getWorkdir.mockReturnValue(tmpDir);
  mocks.getTaskDir.mockReturnValue(tmpDir);
  mocks.getOutputDir.mockReturnValue(tmpDir);
  mocks.getCacheDir.mockReturnValue(tmpDir);
  mocks.writeHarnessConfigFiles.mockResolvedValue(undefined);
  mocks.prepareWorkspace.mockResolvedValue(undefined);
  mocks.generateBranchName.mockReturnValue('feat/x');
  mocks.getGitHostKey.mockReturnValue('forgejo:3000');
  mocks.probeGitRemote.mockResolvedValue(true);

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
  mocks.waitForContainer.mockReturnValue(new Promise(() => {}));
  mocks.createAgentContainer.mockResolvedValue({ id: 'dev1' });

  mocks.handleDevFailure.mockResolvedValue(undefined);
  mocks.handleReviewFailure.mockResolvedValue({ shouldRetry: false, newRetryCount: 0 });
  mocks.processReviewVerdict.mockResolvedValue(undefined);
  mocks.postDevAgent.mockResolvedValue(false);

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

describe('slot-transition status_changed broadcast', () => {
  it('broadcasts when a tick acquires a slot', async () => {
    store = [
      mkTask({ id: 1, status: 'queued', container_id: null, queue_position: 1 }),
    ];
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    // The launch claimed a container, so the pool moved.
    expect(store[0].container_id).toBe('dev1');
    expect(mocks.broadcastStatusChanged).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastStatusChanged).toHaveBeenCalledWith(false);
  });

  it('broadcasts when a tick releases a slot', async () => {
    // A finished container: completion nulls container_id, freeing the pool.
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'c1' })];
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();

    expect(store[0].container_id).toBeNull();
    expect(mocks.broadcastStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast on a tick that changes no slots', async () => {
    // One container still running and nothing queued: reconciliation runs,
    // nothing is taken or given back.
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'running-1' })];
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();
    await scheduler.tick();

    expect(store[0].container_id).toBe('running-1');
    expect(mocks.broadcastStatusChanged).not.toHaveBeenCalled();
  });

  it('goes quiet again after the transition it announced', async () => {
    store = [
      mkTask({ id: 1, status: 'queued', container_id: null, queue_position: 1 }),
    ];
    const scheduler = new Scheduler(fakeForgejo, silentLog);

    await scheduler.tick();
    expect(mocks.broadcastStatusChanged).toHaveBeenCalledTimes(1);

    // Nothing left to launch and the container is still running — no second
    // frame. This is what makes a per-tick broadcast safe to leave in.
    mocks.getContainer.mockImplementation((id: string) => ({
      id,
      inspect: async () => ({ State: { Status: 'running', ExitCode: 0 } }),
      logs: async () => Buffer.from(''),
      remove: async () => {},
    }));
    await scheduler.tick();
    expect(mocks.broadcastStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('reports the paused flag with the transition', async () => {
    store = [mkTask({ id: 1, status: 'in-progress', container_id: 'c1' })];
    const scheduler = new Scheduler(fakeForgejo, silentLog);
    scheduler.pause();

    // Pause gates launches only — a completion still frees its slot.
    await scheduler.tick();

    expect(mocks.broadcastStatusChanged).toHaveBeenCalledWith(true);
  });
});
