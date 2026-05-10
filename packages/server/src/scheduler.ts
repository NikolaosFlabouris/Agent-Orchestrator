import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  Task,
  Repo,
  Provider,
  Model,
  AgentProfile,
} from '@orchestrator/shared';
import {
  getTask,
  getRepo,
  getAgentProfile,
  getModel,
  getProvider,
  getProviders,
  getSetting,
  updateTask,
  insertAttempt,
  updateAttempt,
  getRunningAttempt,
  getTasks,
} from './db.js';
import {
  countActiveByProvider,
  canLaunchInPool,
  limitMapFromProviders,
  resolveProviderKey,
} from './scheduler-pools.js';
import { ForgejoClient } from './forgejo.js';
import {
  createAgentContainer,
  startContainer,
  stopContainer,
  removeContainer,
  waitForContainer,
  listContainers,
  getContainer,
} from './docker.js';
import {
  getCandidates,
  getAvailableResources,
  getTaskResources,
  fitsInPool,
  checkDependenciesMet,
  type TaskResources,
} from './queue.js';
import {
  prepareWorkspace,
  verifyWorkspaceState,
  getWorkdir,
  getTaskDir,
  getOutputDir,
  getCacheDir,
  generateBranchName,
  writeHarnessConfigFiles,
} from './workspace.js';
import { postDevAgent, handleDevFailure } from './agents/develop.js';
import {
  processReviewVerdict,
  handleReviewFailure,
} from './agents/review.js';
import { updateTaskWithSync, notifyStreamComplete, recordTaskEvent } from './state-sync.js';
import { getSnapshot, invalidateSnapshot } from './forgejo-snapshot.js';
import { runOrphanSweep } from './orphan-recovery.js';
import { DEFAULT_MAX_ATTEMPTS, POLL_INTERVAL_SECONDS } from './constants.js';
import { INSTALL_STEP_COMMANDS } from './install-steps.js';
import { getHarness, type HarnessSpec, type HarnessInvocation } from './harnesses/index.js';
import { buildProviderEnv } from './providers/kinds.js';
import type { FastifyBaseLogger } from 'fastify';

// ---------------------------------------------------------------------------
// Result / meta types (read from container output files)
// ---------------------------------------------------------------------------

interface AgentResult {
  status: 'success' | 'failure' | 'timeout';
  exit_code?: number;
  error_message?: string;
}

interface TaskMeta {
  issue_id: number;
  branch_name: string;
  base_branch: string;
  max_runtime_minutes: number;
  attempt: number;
  role: 'develop' | 'review';
  pr_number: number | null;
  /** Resolved model identifier the harness invocation will pass to its
   *  inference endpoint. For SDK harnesses the in-container script reads
   *  this and passes it to the SDK call. For CLI harnesses the value is
   *  audit-only — the model is already baked into `agent_command`. */
  model: string;
  /** Snapshot of the harness id at attempt-launch time. Audit field —
   *  the harness implementation is selected at task-launch by the
   *  scheduler, not by this string. */
  harness_id: string;
  /** Snapshot of the agent profile id at attempt-launch time. Audit. */
  agent_profile_id: string;
  /** Resolved install commands the harness runs sequentially under flock
   *  before the agent. Each entry is the literal shell command to exec.
   *  The orchestrator builds these from the repo's typed install_steps so
   *  the harness never sees free-text input from the operator. */
  install_commands: InstallCommand[];
  /** Literal shell command for CLI harnesses. Empty string for SDK
   *  harnesses (the SDK script reads `meta.model` and runs the SDK call
   *  directly). */
  agent_command: string;
}

interface InstallCommand {
  /** Literal shell command (e.g. `npm ci`) or `bash <path>` for script
   *  steps. Always built by the orchestrator from a typed step. */
  command: string;
  /** Working directory (absolute path inside the container) the harness
   *  should run the command in. Defaults to /repo. */
  cwd: string;
}

/** Resolve a repo's typed install_steps into the literal command strings the
 *  harness will exec. Script steps were already gated by allow_script_steps
 *  at validation time; here we just translate { kind: 'script', path } into
 *  `bash <path>`. cwd is anchored under /repo. */
function buildInstallCommands(repo: Repo): InstallCommand[] {
  const out: InstallCommand[] = [];
  for (const step of repo.install_steps) {
    const cwd = step.cwd ? `/repo/${step.cwd}` : '/repo';
    if (step.kind === 'script') {
      out.push({ command: `bash ${step.path}`, cwd });
    } else {
      out.push({ command: INSTALL_STEP_COMMANDS[step.kind], cwd });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory state per active task (not persisted — lost on restart)
// ---------------------------------------------------------------------------

interface ActiveTaskState {
  currentAttemptId: number;
  preReviewSha?: string;
  reviewRetryCount: number;
}

const activeState = new Map<number, ActiveTaskState>();

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private forgejo: ForgejoClient;
  private log: FastifyBaseLogger;
  private paused = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // tick() can fire concurrently from the 60s timer, webhook triggers, and
  // container-wait callbacks. The orphan sweep must not re-enter itself —
  // a second sweep could double-finalise attempts. This flag serialises it.
  private orphanSweepInFlight = false;
  // fillSlots is now async (workspace prep is async), so two concurrent ticks
  // could both pick the same candidate from a stale DB read. Serialise it.
  // Held only for the duration of the candidate-selection + launch loop, NOT
  // for the rest of the tick (reconcileOrphans / checkCompletedContainers can
  // still run in parallel with each other because they target disjoint task
  // states from fillSlots).
  private fillSlotsInFlight = false;

  constructor(forgejo: ForgejoClient, log: FastifyBaseLogger) {
    this.forgejo = forgejo;
    this.log = log;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;

    // Fallback reconciliation tick. Webhooks drive the real-time path; this
    // interval is the safety net for missed events. See constants.ts.
    const pollInterval = POLL_INTERVAL_SECONDS * 1000;
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error({ event: 'tick_error', err }, 'Scheduler tick failed');
      });
    }, pollInterval);

    // Run initial tick
    this.tick().catch((err) => {
      this.log.error({ event: 'tick_error', err }, 'Initial scheduler tick failed');
    });

    this.log.info({ event: 'scheduler_started' }, 'Scheduler started');
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info({ event: 'scheduler_stopped' }, 'Scheduler stopped');
  }

  pause(): void {
    this.paused = true;
    this.log.info({ event: 'scheduler_paused' }, 'Scheduler paused');
  }

  resume(): void {
    this.paused = false;
    this.log.info({ event: 'scheduler_resumed' }, 'Scheduler resumed');
    // Trigger immediate tick on resume
    this.tick().catch((err) => {
      this.log.error({ event: 'tick_error', err }, 'Resume tick failed');
    });
  }

  isPaused(): boolean {
    return this.paused;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Trigger an immediate tick (e.g., from webhook). */
  triggerTick(): void {
    if (!this.running) return;
    this.tick().catch((err) => {
      this.log.error({ event: 'tick_error', err }, 'Triggered tick failed');
    });
  }

  /**
   * Process a completed task given pre-read result and role.
   * Used by shutdown drain and startup recovery when they've already
   * read result.json and meta.json themselves.
   */
  async processCompletedTask(
    task: Task,
    result: AgentResult,
    role: 'develop' | 'review'
  ): Promise<void> {
    if (role === 'develop') {
      await this.onDevAgentComplete(task, result);
    } else {
      await this.onReviewAgentComplete(task, result);
    }
  }

  // ---- Main tick ----

  async tick(): Promise<void> {
    // `paused` only gates NEW task launches (fillSlots). Reconciliation,
    // completed-container processing, and the external poller (separate
    // class) continue so the DB stays in sync with Forgejo/Docker state.
    // A paused orchestrator should still notice that an issue was closed
    // on Forgejo or that an agent container finished — it just won't
    // start the next thing.

    // Step 0: Reconcile orphaned tasks (container disappeared or
    // container_id got nulled without finalising the attempt row).
    // Runs before checkCompletedContainers so a just-nulled container_id
    // from the previous tick gets caught on the same pass.
    await this.reconcileOrphans();

    // Step 1: Check for completed containers
    await this.checkCompletedContainers();

    // Step 2: Fill empty slots
    await this.fillSlots();
  }

  private async reconcileOrphans(): Promise<void> {
    if (this.orphanSweepInFlight) return;
    this.orphanSweepInFlight = true;
    try {
      await runOrphanSweep(this.forgejo, this, this.log);
    } catch (err) {
      this.log.error(
        { event: 'orphan_sweep_error', err },
        'Orphan sweep failed'
      );
    } finally {
      this.orphanSweepInFlight = false;
    }
  }

  // ---- Step 1: Check completed containers ----

  private async checkCompletedContainers(): Promise<void> {
    const activeTasks = [
      ...getTasks({ status: 'in-progress' }),
      ...getTasks({ status: 'in-review' }),
      ...getTasks({ status: 'changes-needed' }),
    ].filter((t) => t.container_id);

    for (const task of activeTasks) {
      try {
        const container = getContainer(task.container_id!);
        const info = await container.inspect();

        if (info.State.Status === 'exited') {
          this.log.info(
            { event: 'container_exited', task_id: task.id, exit_code: info.State.ExitCode },
            'Agent container exited'
          );
          await this.processCompletedContainer(task);
        }
      } catch (err: unknown) {
        // Container not found — may have been cleaned up externally
        if (isNotFoundError(err)) {
          this.log.warn(
            { event: 'container_not_found', task_id: task.id, container_id: task.container_id },
            'Container not found'
          );
          updateTask(task.id, { container_id: null });
        } else {
          this.log.error(
            { event: 'container_inspect_error', task_id: task.id, err },
            'Failed to inspect container'
          );
        }
      }
    }
  }

  private async processCompletedContainer(task: Task): Promise<void> {
    const workdir = getWorkdir(task);
    const outputDir = getOutputDir(task);
    const taskDir = getTaskDir(task);

    // Read result.json
    let result: AgentResult;
    const resultPath = path.join(outputDir, 'result.json');
    try {
      const raw = await fsp.readFile(resultPath, 'utf-8');
      result = JSON.parse(raw) as AgentResult;
    } catch {
      this.log.warn(
        { event: 'result_missing', task_id: task.id },
        'result.json not found or invalid — treating as failure'
      );
      result = { status: 'failure', error_message: 'No result.json produced by agent' };
    }

    // Read role from meta.json
    let role: 'develop' | 'review' = 'develop';
    const metaPath = path.join(taskDir, 'meta.json');
    try {
      const raw = await fsp.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as TaskMeta;
      role = meta.role;
    } catch {
      this.log.warn(
        { event: 'meta_missing', task_id: task.id },
        'meta.json not found — assuming develop role'
      );
    }

    // Record container exit event
    recordTaskEvent(task.id, 'container_exited', `Container exited (${result.status})`);

    // Signal stream completion to WebSocket clients
    notifyStreamComplete(task.id);

    // Remove container
    try {
      const container = getContainer(task.container_id!);
      await removeContainer(container);
    } catch {
      // Best effort
    }
    updateTask(task.id, { container_id: null });

    // Dispatch to appropriate handler
    if (role === 'develop') {
      await this.onDevAgentComplete(task, result);
    } else {
      await this.onReviewAgentComplete(task, result);
    }
  }

  // ---- Step 2: Fill slots ----

  private async fillSlots(): Promise<void> {
    if (this.paused) return;
    // Re-entry guard: a webhook-triggered tick that arrives mid-launch would
    // otherwise read the same DB snapshot and pick the same candidate before
    // the in-flight launch's updateTask has bumped the active count. Skipping
    // is correct — the in-flight call will pick up any newly-queued work on
    // its next pass, and the trailing tick can run on the next event.
    if (this.fillSlotsInFlight) return;
    this.fillSlotsInFlight = true;
    try {
      await this._fillSlotsInner();
    } finally {
      this.fillSlotsInFlight = false;
    }
  }

  private async _fillSlotsInner(): Promise<void> {
    // Two layers gate every launch:
    //   1. Host resource pool — sums active container memory/CPU and
    //      refuses launch if the candidate would exceed the pool. The
    //      pool sits in settings.max_agent_memory_mb / max_agent_cpu_cores;
    //      candidate footprint comes from the task's repo
    //      (container_memory_mb / container_cpu_cores) or the
    //      DEFAULT_CONTAINER_* constants.
    //   2. Per-provider concurrency_limit — addresses upstream LLM
    //      provider constraints (Ollama can really only do 1 at a time;
    //      Anthropic API has rate limits). Independent of host capacity.
    let availableResources: TaskResources = getAvailableResources();
    // Early exit if the host pool is fully saturated on either dimension.
    // Realistic per-task footprints are always > 0, so a 0-headroom pool
    // can't fit anything.
    if (availableResources.memoryMb <= 0 || availableResources.cpuCores <= 0) return;

    const active = [
      ...getTasks({ status: 'preparing' }),
      ...getTasks({ status: 'in-progress' }),
      ...getTasks({ status: 'in-review' }),
    ].filter((t) => t.container_id !== null);

    const activeByProvider = countActiveByProvider(active, (t) =>
      this.providerIdForTask(t)
    );
    const limitByProvider = limitMapFromProviders(getProviders());

    const candidates = getCandidates();

    for (const candidate of candidates) {
      if (availableResources.memoryMb <= 0 || availableResources.cpuCores <= 0) break;

      // Re-read task to get fresh state
      const task = getTask(candidate.id);
      if (!task) continue;

      // Skip if task is no longer in a fillable state
      if (
        task.status !== 'queued' &&
        task.status !== 'in-review' &&
        task.status !== 'changes-needed'
      ) {
        continue;
      }

      // Host resource fit check — does this candidate's footprint fit in
      // the remaining pool? We don't "break" on a miss: a later, smaller
      // candidate could still fit (e.g. preferred FIFO order is task A
      // (8 GB) → task B (1 GB), pool has 4 GB left → A skips, B launches).
      const need = getTaskResources(task);
      if (!fitsInPool(need, availableResources)) {
        continue;
      }

      // Provider pool check — skip if this candidate's pool is saturated.
      // A later candidate on a different (idle) provider can still launch.
      const providerKey = resolveProviderKey(task, this.providerIdForTask(task));
      if (!canLaunchInPool(providerKey, activeByProvider, limitByProvider)) {
        continue;
      }

      // For queued tasks: check dependency gate
      if (task.status === 'queued') {
        const depsMet = await checkDependenciesMet(
          this.forgejo,
          task,
          this.log
        );
        if (!depsMet) continue;
      }

      // Respect Forgejo-side closure: if the human closed the issue since
      // the task was queued (or while it's been sitting), don't start work.
      // Mark the task cancelled so it leaves the queue — derivation would
      // show it as cancelled on read anyway, but we need to release the
      // slot and stop re-picking it up here. Best-effort — a snapshot
      // fetch failure falls through and the task launches normally.
      try {
        const snapshot = await getSnapshot(task, this.forgejo);
        if (snapshot && snapshot.issue.state === 'closed' && !snapshot.pr?.merged) {
          updateTaskWithSync(task.id, {
            status: 'cancelled',
            completed_at: new Date().toISOString(),
          });
          recordTaskEvent(
            task.id,
            'skipped_issue_closed',
            `Skipped: issue #${task.issue_id} closed on Forgejo before task launch`
          );
          invalidateSnapshot(task.id);
          this.log.info(
            { event: 'scheduler_skip_closed', task_id: task.id },
            'Skipping task — Forgejo issue is closed'
          );
          continue;
        }
      } catch {
        // Snapshot fetch failed — proceed with launch.
      }

      // Launch appropriate container
      try {
        if (task.status === 'in-review') {
          // Recovery: need to start review container
          await this.launchReviewContainer(task);
        } else if (task.status === 'changes-needed') {
          // Orphaned rework: start dev container
          await this.launchDevContainer(task);
        } else {
          // Queued: fresh task
          await this.launchDevContainer(task);
        }
        // Accounting: claim resources from the host pool and bump the
        // provider counter so a subsequent candidate sees fresh state.
        availableResources = {
          memoryMb: availableResources.memoryMb - need.memoryMb,
          cpuCores: availableResources.cpuCores - need.cpuCores,
        };
        activeByProvider.set(
          providerKey,
          (activeByProvider.get(providerKey) ?? 0) + 1
        );
      } catch (err) {
        this.log.error(
          { event: 'launch_failed', task_id: task.id, err },
          'Failed to launch container'
        );
        await this.handlePrepFailure(task, err);
      }
    }
  }

  // ---- Container launch helpers ----

  async launchDevContainer(
    task: Task,
    feedback: string | null = null
  ): Promise<void> {
    const repo = getRepo(task.repo_id);
    if (!repo) throw new Error(`Repo not found for task ${task.id}`);

    const ctx = this.resolveLaunchContext(task, repo);
    let issue: { title: string; body: string };
    try {
      issue = await this.forgejo.getIssue(repo, task.issue_id);
    } catch {
      issue = { title: `Issue #${task.issue_id}`, body: '' };
    }

    const workdir = getWorkdir(task);
    const taskDir = getTaskDir(task);
    const outputDir = getOutputDir(task);
    const cacheDir = getCacheDir(repo.owner, repo.name);

    // Generate branch name on first attempt if not set
    if (!task.branch_name) {
      const branchName = generateBranchName(task.issue_id, issue.title);
      updateTask(task.id, { branch_name: branchName });
      task = getTask(task.id)!;
    }

    // Archive previous output
    await this.archivePreviousOutput(task);

    // Verify workspace state
    await verifyWorkspaceState(task, this.log);

    // Update status to preparing
    updateTaskWithSync(task.id, { status: 'preparing' });

    // Prepare workspace
    await prepareWorkspace(task, this.log);

    // Write task files
    await this.writeTaskFiles(task, repo, ctx, issue, feedback);

    // Write harness-generated config files (e.g. opencode.json) into /repo
    await writeHarnessConfigFiles(task, ctx.invocation.config_files, ctx.harness.id, this.log);

    // Create and start container
    const env = this.buildEnv(ctx.provider, ctx.invocation);
    const container = await createAgentContainer({
      task,
      repo,
      harnessRuntime: ctx.harness.runtime,
      workdir,
      taskDir,
      outputDir,
      cacheDir,
      env,
    });

    await startContainer(container);
    updateTaskWithSync(task.id, {
      container_id: container.id,
      started_at: new Date().toISOString(),
      status: 'in-progress',
    });

    try {
      const repo = getRepo(task.repo_id);
      if (repo) {
        await this.forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Dev agent starting (attempt ${task.attempt}/${task.max_attempts ?? DEFAULT_MAX_ATTEMPTS}).`
        );
      }
    } catch {
      /* best effort */
    }

    // Record attempt with snapshot of harness + model used
    const attempt = insertAttempt({
      task_id: task.id,
      attempt_number: task.attempt,
      role: 'develop',
      status: 'running',
      model_id: ctx.invocation.resolved_model,
      harness_id: ctx.harness.id,
    });
    activeState.set(task.id, {
      currentAttemptId: attempt.id,
      reviewRetryCount: 0,
    });

    // Set up container completion callback
    this.watchContainer(container, task.id);

    recordTaskEvent(task.id, 'container_started', `Dev container started (attempt ${task.attempt})`);

    this.log.info(
      { event: 'dev_container_started', task_id: task.id, attempt: task.attempt },
      'Dev container started'
    );
  }

  async launchReviewContainer(task: Task): Promise<void> {
    const repo = getRepo(task.repo_id);
    if (!repo) throw new Error(`Repo not found for task ${task.id}`);

    const ctx = this.resolveLaunchContext(task, repo);
    let issue: { title: string; body: string };
    try {
      issue = await this.forgejo.getIssue(repo, task.issue_id);
    } catch {
      issue = { title: `Issue #${task.issue_id}`, body: '' };
    }

    const workdir = getWorkdir(task);
    const taskDir = getTaskDir(task);
    const outputDir = getOutputDir(task);
    const cacheDir = getCacheDir(repo.owner, repo.name);

    // Archive previous output
    await this.archivePreviousOutput(task);

    // Record pre-review SHA
    let preReviewSha: string | undefined;
    try {
      const branch = await this.forgejo.getBranch(repo, task.branch_name!);
      preReviewSha = branch.commit.id;
    } catch {
      this.log.warn(
        { event: 'pre_review_sha_missing', task_id: task.id },
        'Could not get pre-review SHA'
      );
    }

    // Write task files
    await this.writeTaskFiles(task, repo, ctx, issue, null, 'review');

    // Write harness-generated config files (e.g. opencode.json) into /repo
    await writeHarnessConfigFiles(task, ctx.invocation.config_files, ctx.harness.id, this.log);

    // Create and start container
    const env = this.buildEnv(ctx.provider, ctx.invocation);
    const container = await createAgentContainer({
      task,
      repo,
      harnessRuntime: ctx.harness.runtime,
      workdir,
      taskDir,
      outputDir,
      cacheDir,
      env,
    });

    await startContainer(container);
    updateTaskWithSync(task.id, {
      container_id: container.id,
      status: 'in-review',
    });

    try {
      const repo = getRepo(task.repo_id);
      if (repo) {
        await this.forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Review agent starting (attempt ${task.attempt}/${task.max_attempts ?? DEFAULT_MAX_ATTEMPTS}).`
        );
      }
    } catch {
      /* best effort */
    }

    // Record attempt with snapshot of harness + model used
    const attempt = insertAttempt({
      task_id: task.id,
      attempt_number: task.attempt,
      role: 'review',
      status: 'running',
      model_id: ctx.invocation.resolved_model,
      harness_id: ctx.harness.id,
    });
    const state = activeState.get(task.id) ?? {
      currentAttemptId: 0,
      reviewRetryCount: 0,
    };
    state.currentAttemptId = attempt.id;
    if (preReviewSha) state.preReviewSha = preReviewSha;
    activeState.set(task.id, state);

    // Set up container completion callback
    this.watchContainer(container, task.id);

    recordTaskEvent(task.id, 'container_started', `Review container started (attempt ${task.attempt})`);

    this.log.info(
      { event: 'review_container_started', task_id: task.id, attempt: task.attempt },
      'Review container started'
    );
  }

  // ---- Continue to review ----

  private async continueToReview(task: Task): Promise<void> {
    const repo = getRepo(task.repo_id);
    if (!repo) return;

    // Check for human-review label
    let hasHumanReview = false;
    try {
      const issue = await this.forgejo.getIssue(repo, task.issue_id);
      hasHumanReview = issue.labels.some(
        (l) => l.name === 'human-review'
      );
    } catch {
      // Best effort
    }

    if (hasHumanReview) {
      updateTaskWithSync(task.id, {
        status: 'awaiting-human-review',
        completed_at: new Date().toISOString(),
      });
      try {
        await this.forgejo.commentOnIssue(
          repo,
          task.issue_id,
          `Implementation complete. PR ready for human review (human-review label detected).`
        );
      } catch { /* best effort */ }
      activeState.delete(task.id);
      this.log.info(
        { event: 'awaiting_human_review', task_id: task.id },
        'Awaiting human review'
      );
    } else {
      // Start review immediately in the same slot
      const freshTask = getTask(task.id)!;
      await this.launchReviewContainer(freshTask);
    }
  }

  // ---- Container watch (completion detection via container.wait()) ----

  private watchContainer(
    container: { id: string; wait: () => Promise<{ StatusCode: number }> },
    taskId: number
  ): void {
    waitForContainer(container as any).then(() => {
      this.log.info(
        { event: 'container_wait_resolved', task_id: taskId },
        'Container wait callback fired'
      );
      // Trigger a tick to process the completed container
      this.triggerTick();
    }).catch((err) => {
      this.log.error(
        { event: 'container_wait_error', task_id: taskId, err },
        'Container wait failed'
      );
    });
  }

  // ---- Post-agent flows ----

  private async onDevAgentComplete(
    task: Task,
    result: AgentResult
  ): Promise<void> {
    await this.completeAttempt(task, result);

    if (result.status === 'success') {
      const ready = await postDevAgent(task, this.forgejo, this.log);
      if (ready) {
        try {
          const repo = getRepo(task.repo_id);
          if (repo) {
            await this.forgejo.commentOnIssue(
              repo,
              task.issue_id,
              `Implementation complete (attempt ${task.attempt}).`
            );
          }
        } catch { /* best effort */ }
        await this.continueToReview(task);
      } else {
        // postDevAgent marked the task as failed and freed the slot
        activeState.delete(task.id);
      }
    } else if (result.status === 'timeout') {
      // Check if the agent produced usable work before timing out
      const ready = await postDevAgent(task, this.forgejo, this.log);
      if (ready) {
        try {
          const repo = getRepo(task.repo_id);
          if (repo) {
            await this.forgejo.commentOnIssue(
              repo,
              task.issue_id,
              `Agent timed out but partial work was salvaged (attempt ${task.attempt}).`
            );
          }
        } catch { /* best effort */ }
        await this.continueToReview(task);
      } else {
        // Check if postDevAgent already marked as failed
        const freshTask = getTask(task.id)!;
        if (freshTask.status !== 'failed') {
          await handleDevFailure(
            task,
            'Agent timed out with no salvageable work',
            this.forgejo,
            this.log,
            (t, fb) => this.launchDevContainer(t, fb)
          );
        } else {
          activeState.delete(task.id);
        }
      }
    } else {
      // Failure
      await handleDevFailure(
        task,
        result.error_message || `Agent exited with failure status (exit code ${result.exit_code})`,
        this.forgejo,
        this.log,
        (t, fb) => this.launchDevContainer(t, fb)
      );
    }
  }

  private async onReviewAgentComplete(
    task: Task,
    result: AgentResult
  ): Promise<void> {
    await this.completeAttempt(task, result);

    const state = activeState.get(task.id);
    const reviewRetryCount = state?.reviewRetryCount ?? 0;

    if (result.status !== 'success') {
      // Review agent itself failed — retry or escalate
      const { shouldRetry, newRetryCount } = await handleReviewFailure(
        task,
        reviewRetryCount,
        this.forgejo,
        this.log,
        (t) => this.launchReviewContainer(t)
      );
      if (shouldRetry && state) {
        state.reviewRetryCount = newRetryCount;
      } else {
        activeState.delete(task.id);
      }
      return;
    }

    // Reset review retry count on success
    if (state) state.reviewRetryCount = 0;

    // Read review.json
    const outputDir = getOutputDir(task);
    const reviewPath = path.join(outputDir, 'review.json');
    let review: { verdict: 'approved' | 'changes_needed' | 'unclear'; summary?: string; feedback?: any };
    try {
      const raw = await fsp.readFile(reviewPath, 'utf-8');
      review = JSON.parse(raw);
      if (!review.verdict) throw new Error('No verdict field');
    } catch {
      // No valid review.json — treat as failure
      const { shouldRetry, newRetryCount } = await handleReviewFailure(
        task,
        reviewRetryCount,
        this.forgejo,
        this.log,
        (t) => this.launchReviewContainer(t)
      );
      if (shouldRetry && state) {
        state.reviewRetryCount = newRetryCount;
      } else {
        activeState.delete(task.id);
      }
      return;
    }

    await processReviewVerdict(
      task,
      review,
      state?.preReviewSha,
      reviewRetryCount,
      this.forgejo,
      this.log,
      (t, fb) => this.launchDevContainer(t, fb),
      (t) => this.launchReviewContainer(t)
    );

    // Check if task ended up in a terminal state
    const freshTask = getTask(task.id);
    if (freshTask && (
      freshTask.status === 'merged' ||
      freshTask.status === 'failed' ||
      freshTask.status === 'awaiting-human-merge' ||
      freshTask.status === 'awaiting-human-review' ||
      freshTask.status === 'needs-human-review'
    )) {
      activeState.delete(task.id);
    }
  }

  // ---- Attempt tracking ----

  private async completeAttempt(task: Task, result: AgentResult): Promise<void> {
    let attemptId: number;
    const state = activeState.get(task.id);

    if (state) {
      attemptId = state.currentAttemptId;
    } else {
      // Recovery path: activeState is empty after restart.
      // Look up the attempt row by composite key, or create a new one.
      const metaPath = path.join(getTaskDir(task), 'meta.json');
      let role: 'develop' | 'review' = 'develop';
      try {
        const raw = await fsp.readFile(metaPath, 'utf-8');
        role = JSON.parse(raw).role ?? 'develop';
      } catch { /* default to develop */ }

      const existing = getRunningAttempt(task.id, task.attempt, role);
      if (existing) {
        attemptId = existing.id;
      } else {
        // Orchestrator crashed before creating the attempt row — create one now
        const newAttempt = insertAttempt({
          task_id: task.id,
          attempt_number: task.attempt,
          role,
          status: 'running',
        });
        attemptId = newAttempt.id;
      }
    }

    // Read review verdict if present
    let verdict: string | null = null;
    let feedback: string | null = null;
    const outputDir = getOutputDir(task);
    const reviewPath = path.join(outputDir, 'review.json');
    try {
      const raw = await fsp.readFile(reviewPath, 'utf-8');
      const review = JSON.parse(raw);
      verdict = review.verdict ?? null;
      feedback = review.feedback ? JSON.stringify(review.feedback) : null;
    } catch {
      // File missing or unreadable — leave verdict/feedback null.
    }

    // Map agent result status to attempt status
    let attemptStatus: string;
    if (result.status === 'success') attemptStatus = 'completed';
    else if (result.status === 'timeout') attemptStatus = 'timeout';
    else attemptStatus = 'failed';

    updateAttempt(attemptId, {
      status: attemptStatus as any,
      completed_at: new Date().toISOString(),
      verdict,
      log_path: path.join(getOutputDir(task), 'progress.log'),
      feedback,
    });
  }

  // ---- Prep failure handling ----

  private async handlePrepFailure(task: Task, err: unknown): Promise<void> {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const freshTask = getTask(task.id)!;
    const newCount = freshTask.prep_failure_count + 1;

    if (newCount >= 3) {
      // Permanent failure
      updateTaskWithSync(task.id, {
        status: 'failed',
        prep_failure_count: newCount,
        completed_at: new Date().toISOString(),
      });
      this.log.error(
        { event: 'prep_failed_permanent', task_id: task.id, error: errorMsg },
        'Workspace preparation failed permanently'
      );
    } else {
      // Transient failure — return to queue
      updateTaskWithSync(task.id, {
        status: 'queued',
        prep_failure_count: newCount,
      });
      this.log.warn(
        { event: 'prep_failed_transient', task_id: task.id, error: errorMsg, retry: newCount },
        'Workspace preparation failed, returning to queue'
      );
    }
  }

  // ---- Config resolution helpers ----

  /** Resolve the agent profile for a task. Chain:
   *    task.agent_profile_id → repo.agent_profile_id → settings.default_agent_profile_id
   *  Throws with a clear message if every level is null/missing. */
  private resolveProfile(task: Task, repo: Repo): AgentProfile {
    const profileId =
      task.agent_profile_id ??
      repo.agent_profile_id ??
      getSetting('default_agent_profile_id');
    if (!profileId) {
      throw new Error(
        `Cannot launch task ${task.id}: no agent profile configured. ` +
        `Task, repo (${repo.owner}/${repo.name}), and settings.default_agent_profile_id are all unset.`
      );
    }
    const profile = getAgentProfile(profileId);
    if (!profile) {
      throw new Error(
        `Agent profile '${profileId}' not found (referenced by ` +
        `${task.agent_profile_id ? `task ${task.id}` : repo.agent_profile_id ? `repo ${repo.owner}/${repo.name}` : 'settings.default_agent_profile_id'}). ` +
        `The profile may have been deleted; reconfigure or restore.`
      );
    }
    return profile;
  }

  /** Build the full (profile, harness, model, provider, invocation)
   *  bundle for a task launch. Throws on missing rows or harness mismatch
   *  (the harness's buildInvocation throws if its supported_provider_kinds
   *  doesn't include the resolved provider's kind). */
  private resolveLaunchContext(
    task: Task,
    repo: Repo
  ): {
    profile: AgentProfile;
    harness: HarnessSpec;
    model: Model;
    provider: Provider;
    invocation: HarnessInvocation;
  } {
    const profile = this.resolveProfile(task, repo);
    const model = getModel(profile.model_pk);
    if (!model) {
      throw new Error(
        `Model with id ${profile.model_pk} (referenced by profile '${profile.id}') not found. ` +
        `It may have been deleted; reconfigure the profile.`
      );
    }
    const provider = getProvider(model.provider_id);
    if (!provider) {
      throw new Error(
        `Provider '${model.provider_id}' (referenced by model id ${model.id}) not found. ` +
        `It may have been deleted; reconfigure the provider or pick a different model.`
      );
    }
    const harness = getHarness(profile.harness_id);
    const invocation = harness.buildInvocation({
      profile,
      model,
      provider,
      promptFilePath: '/task/prompt.md',
    });
    return { profile, harness, model, provider, invocation };
  }

  /** Best-effort profile lookup for a task, for bookkeeping paths that
   *  should not throw when a profile/repo is missing. Returns undefined
   *  if any link in the chain is broken. */
  private profileForTask(task: Task): AgentProfile | undefined {
    const repo = getRepo(task.repo_id);
    if (!repo) return undefined;
    const profileId =
      task.agent_profile_id ??
      repo.agent_profile_id ??
      getSetting('default_agent_profile_id');
    if (!profileId) return undefined;
    return getAgentProfile(profileId);
  }

  /** Best-effort provider-id lookup for a task, used by the scheduler
   *  pool gating. Walks task → profile → model → provider_id. Returns
   *  null if any link is missing — the scheduler treats these as
   *  unconstrained-by-provider (host pool still gates). */
  private providerIdForTask(task: Task): string | null {
    const profile = this.profileForTask(task);
    if (!profile) return null;
    const model = getModel(profile.model_pk);
    if (!model) return null;
    return model.provider_id;
  }

  /** Build the env-var array for a Docker container launch. Combines the
   *  provider's resolved credential (under the kind's standard name, via
   *  buildProviderEnv) with any harness-specific extras. */
  private buildEnv(provider: Provider, invocation: HarnessInvocation): string[] {
    const env: string[] = [];
    // Provider credential under the standard env-var name for its kind
    // (e.g. ANTHROPIC_API_KEY for kind=anthropic). May be empty if the
    // provider is self-hosted with no auth or if the configured env-var
    // pointer isn't set in the orchestrator's environment.
    const providerEnv = buildProviderEnv(provider);
    for (const [k, v] of Object.entries(providerEnv)) {
      env.push(`${k}=${v}`);
    }
    // Harness-specific extras (typically empty).
    for (const [k, v] of Object.entries(invocation.extra_env)) {
      env.push(`${k}=${v}`);
    }
    return env;
  }

  private async writeTaskFiles(
    task: Task,
    repo: Repo,
    ctx: {
      profile: AgentProfile;
      harness: HarnessSpec;
      model: Model;
      provider: Provider;
      invocation: HarnessInvocation;
    },
    issue: { title: string; body: string },
    feedback: string | null = null,
    role: 'develop' | 'review' = 'develop'
  ): Promise<void> {
    const taskDir = getTaskDir(task);
    await fsp.mkdir(taskDir, { recursive: true });

    // Write prompt.md using templates from doc 04
    const promptPath = path.join(taskDir, 'prompt.md');
    let prompt: string;
    if (role === 'develop') {
      prompt = buildDevPrompt(task, repo, issue, feedback);
    } else {
      prompt = buildReviewPrompt(task, repo, issue);
    }
    await fsp.writeFile(promptPath, prompt, 'utf-8');

    // Write meta.json
    const metaPath = path.join(taskDir, 'meta.json');
    const meta: TaskMeta = {
      issue_id: task.issue_id,
      branch_name: task.branch_name!,
      base_branch: repo.base_branch,
      max_runtime_minutes: ctx.profile.timeout_minutes,
      attempt: task.attempt,
      role,
      pr_number: task.pr_number,
      model: ctx.invocation.resolved_model,
      harness_id: ctx.harness.id,
      agent_profile_id: ctx.profile.id,
      install_commands: buildInstallCommands(repo),
      agent_command: ctx.invocation.agent_command ?? '',
    };
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }

  private async archivePreviousOutput(task: Task): Promise<void> {
    const outputDir = getOutputDir(task);
    const resultPath = path.join(outputDir, 'result.json');

    // Cheap single-stat early-return: nothing to archive if no prior result.
    if (!fs.existsSync(resultPath)) return;

    // Find archive dir name from attempt data
    const archiveBase = path.join(outputDir, 'archive');
    const archiveName = `attempt-${task.attempt}-${task.status === 'in-review' ? 'review' : 'develop'}`;
    const archiveDir = path.join(archiveBase, archiveName);

    try {
      await fsp.mkdir(archiveDir, { recursive: true });

      // Move files
      for (const file of ['result.json', 'progress.log', 'review.json']) {
        const src = path.join(outputDir, file);
        try {
          await fsp.rename(src, path.join(archiveDir, file));
        } catch (err: unknown) {
          // ENOENT — file was never produced this attempt; skip silently.
          // Anything else propagates to the outer catch.
          const code = (err as { code?: string } | null)?.code;
          if (code !== 'ENOENT') throw err;
        }
      }
    } catch (err) {
      this.log.warn(
        { event: 'archive_failed', task_id: task.id, err },
        'Failed to archive previous output'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    (err as { statusCode: number }).statusCode === 404
  );
}

// ---------------------------------------------------------------------------
// Prompt templates (from doc 04)
// ---------------------------------------------------------------------------

export function buildDevPrompt(
  task: Task,
  repo: Repo,
  issue: { title: string; body: string },
  feedback: string | null
): string {
  let prompt = `## Task

${issue.body}

## Context

- Repository: ${repo.owner}/${repo.name}
- Branch: ${task.branch_name}
- Base branch: ${repo.base_branch}
- Working directory: /repo

## Instructions

1. Fetch the latest base branch and rebase your work onto it:
   git fetch origin ${repo.base_branch}
   git rebase origin/${repo.base_branch}
   If there are conflicts, resolve them before proceeding.
2. Read and understand the task above
3. Explore the relevant codebase to understand existing patterns
4. Implement the changes described in the task
5. Run any existing tests to verify your changes don't break anything
6. Ensure your changes are complete and ready for review
7. Commit your changes and push:
   git add -A
   git commit -m "feat: <concise description>"
   git push origin ${task.branch_name}
   If pre-commit hooks fail, fix the issues and commit again.
   Do not skip or bypass pre-commit hooks.

## Constraints

- Follow the existing code style and conventions in the repo
- Do not modify files unrelated to the task
- If the task is unclear, make reasonable assumptions and document them
- Always push your work before exiting
- If the repo has pre-commit hooks, all hooks must pass before pushing
`;

  if (feedback) {
    prompt += `
## Review Feedback (Attempt ${task.attempt})

${feedback}

Address all feedback items while preserving the working parts of the implementation.
`;
  }

  return prompt;
}

export function buildReviewPrompt(
  task: Task,
  repo: Repo,
  issue: { title: string; body: string }
): string {
  return `## Review Task

Review the changes on the current branch against the base branch (${repo.base_branch}).

## Original Task Description

${issue.body}

## Instructions

1. Fetch the latest base branch to ensure an up-to-date comparison:
   git fetch origin ${repo.base_branch}
2. Run: git diff origin/${repo.base_branch}...HEAD to see all changes
3. Run: git diff origin/${repo.base_branch}...HEAD --name-only for a summary of affected files
4. Read and understand every changed file
5. Run the test suite if one exists
6. Evaluate against the task requirements
7. Check for bugs, security issues, and code quality problems

## Output

Create a file at /output/review.json with this exact structure:

{
  "verdict": "approved" or "changes_needed",
  "summary": "Brief overall assessment in 1-2 sentences",
  "feedback": [
    {"file": "path/to/file.ts", "line": 42, "comment": "description of issue"}
  ]
}

Set verdict to "approved" only if:
- All task requirements are met
- Tests pass (or no test suite exists)
- No bugs or security issues found
- Code quality is acceptable

Set verdict to "changes_needed" if any concrete issues exist.
Include specific, actionable feedback for every issue found.
`;
}
