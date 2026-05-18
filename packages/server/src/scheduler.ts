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
  getLatestAttempt,
  getActiveAttempt,
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
import {
  DEFAULT_MAX_ATTEMPTS,
  POLL_INTERVAL_SECONDS,
  TIMEOUT_KILL_GRACE_MINUTES,
} from './constants.js';
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

/** Pattern-match a container's log output into a known category +
 *  actionable operator message, for the case where the container
 *  exited without producing result.json. The most common cause we've
 *  observed is the kernel failing to exec the entrypoint because of
 *  CRLF line endings in the shebang (a Windows-host-checkout hazard).
 *  Distinct from `categorizePrepFailure`: that one runs on launch-
 *  side exceptions BEFORE the container starts; this one runs on
 *  COMPLETED containers that just died without writing output.
 *
 *  Exported for unit-test coverage. */
export function categorizeContainerExitFailure(
  containerLogs: string
): { eventType: string; message: string } | null {
  // Kernel-level exec failure on the harness entrypoint. The Docker
  // daemon's wrapper emits "exec /usr/local/bin/harness-cli: no such
  // file or directory" (or similar) into the container's stderr when
  // the script's shebang interpreter can't be found — overwhelmingly
  // caused by CRLF line endings in the script (the kernel reads
  // `#!/bin/bash\r` and looks for an interpreter literally named
  // `/bin/bash\r`).
  if (/exec\s+\/usr\/local\/bin\/harness-[a-z]+.*no such file or directory/i.test(containerLogs)) {
    return {
      eventType: 'harness_entrypoint_exec_failed',
      message:
        "The agent container's harness script failed to exec — almost " +
        "always CRLF line endings in `harness/harness-cli.sh` or " +
        "`harness/harness-sdk.ts` (a Windows-host-checkout hazard). " +
        "Rebuild the agent image with `docker compose build agent-image` " +
        "after pulling the latest changes (the .gitattributes file and " +
        "the Dockerfile's sed normalisation step together prevent this). " +
        "Then reset this task and re-apply `status/queued` in Forgejo.",
    };
  }
  return null;
}

/** Pattern-match a prep-failure error message into a known category +
 *  actionable operator message. Returns null when the message doesn't
 *  match any known structural failure — in that case the caller falls
 *  back to the generic prep-failure log/event flow.
 *
 *  Exported for unit-test coverage. */
export function categorizePrepFailure(
  errorMsg: string
): { eventType: string; message: string } | null {
  // Docker reports "no such image: orchestrator-agent:latest" (case-
  // insensitive, may have surrounding whitespace) when the image hasn't
  // been built in the local image store. By far the most common
  // bring-up failure — operator forgot the build script, or pruned
  // local images, or ran `docker compose up` before the agent-image
  // service finished building.
  if (/no such image:?\s*orchestrator-agent/i.test(errorMsg)) {
    return {
      eventType: 'agent_image_missing',
      message:
        "The agent container image 'orchestrator-agent:latest' is missing " +
        "from this Docker host. Build it by running " +
        "`docker compose up -d --build` (the build runs as part of the " +
        "`agent-image` service in docker-compose.yml), or " +
        "`./scripts/build-agent-images.sh` to rebuild without restarting " +
        "the orchestrator. Once the image is present, reset this task and " +
        "re-apply `status/queued` in Forgejo to retry — or open a new " +
        "issue from scratch.",
    };
  }
  return null;
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
  // Timeout-kill sweep must not re-enter — back-to-back ticks during a
  // slow `docker stop` (10s SIGTERM grace) would otherwise double-kill
  // and double-write the same result.json. Same flag-serialisation
  // pattern as `orphanSweepInFlight`.
  private timeoutSweepInFlight = false;

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

    // Step 0.5: Hard-kill containers that have exceeded
    // profile.timeout_minutes (+ grace). The in-container harness
    // wrapper enforces the timeout from the inside, so this should
    // almost never fire — it's the orchestrator-side safety net for
    // the case where the wrapper crashed before its timer armed, or
    // disowned the agent process. Runs BEFORE checkCompletedContainers
    // on the same tick so a just-killed container goes through the
    // normal completion path on this pass instead of waiting another
    // poll interval (~60s).
    await this.enforceTimeouts();

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

  /** Hard-kill active containers whose elapsed runtime has exceeded the
   *  resolved `profile.timeout_minutes + TIMEOUT_KILL_GRACE_MINUTES` (H4).
   *
   *  The agent's in-container wrapper (harness-cli.sh `timeout` /
   *  harness-sdk.ts `setTimeout`) is the primary enforcement point —
   *  it terminates the process, writes a timeout result.json, and
   *  exits the container normally. The wrapper is robust under normal
   *  conditions, but if it crashes before the timer arms (e.g. an
   *  early jq parse failure) or the agent disowns its own process tree,
   *  the wall-clock timeout has no effect from inside the container.
   *  Before this safety net, such a container could run indefinitely
   *  with the dashboard reporting "running" forever.
   *
   *  Threshold sourcing mirrors `alerts.checkAlerts` (H5a): use the
   *  `attempts.timeout_minutes_snapshot` first, fall back to a live
   *  profile read for legacy/pre-v22 attempt rows.
   *
   *  Mechanism: pre-write result.json with `status: 'timeout'` so the
   *  next tick's `checkCompletedContainers` dispatches through the
   *  normal completion path (which reads result.json) rather than
   *  bottoming out at the "no result.json produced" generic-failure
   *  branch. Then `stopContainer` issues SIGTERM with a 10s grace
   *  before SIGKILL.
   *
   *  The sweep is serialised by `timeoutSweepInFlight` so a 10s `docker
   *  stop` blocking the tick doesn't let a webhook-triggered re-tick
   *  double-kill or race the pre-written result.json.
   */
  private async enforceTimeouts(): Promise<void> {
    if (this.timeoutSweepInFlight) return;
    this.timeoutSweepInFlight = true;
    try {
      const activeTasks = [
        ...getTasks({ status: 'in-progress' }),
        ...getTasks({ status: 'in-review' }),
      ].filter((t) => t.container_id);

      for (const task of activeTasks) {
        try {
          await this.enforceTimeoutForTask(task);
        } catch (err) {
          this.log.error(
            { event: 'timeout_enforce_task_error', task_id: task.id, err },
            'Timeout enforcement failed for task'
          );
        }
      }
    } catch (err) {
      this.log.error(
        { event: 'timeout_sweep_error', err },
        'Timeout sweep failed'
      );
    } finally {
      this.timeoutSweepInFlight = false;
    }
  }

  private async enforceTimeoutForTask(task: Task): Promise<void> {
    // `getActiveAttempt` filters to status='running' at the SQL level
    // (M3), eliminating the gap window where a completed dev attempt
    // would otherwise be returned by getLatestAttempt between dev
    // completion and review-attempt insertion.
    const latest = getActiveAttempt(task.id);
    if (!latest || !latest.started_at) {
      // No running attempt for this task. Either the attempt row hasn't
      // been inserted yet (race during launch — the next tick will
      // retry) or it's between roles (the dev attempt has completed
      // but review hasn't been inserted yet; the next tick will pick
      // up the review attempt once it's launched).
      return;
    }

    // Resolve the timeout threshold. Same chain as alerts.checkAlerts:
    // snapshot first (H5a), then a live profile read for legacy rows.
    let timeoutMinutes: number | null = null;
    if (
      typeof latest.timeout_minutes_snapshot === 'number' &&
      latest.timeout_minutes_snapshot > 0
    ) {
      timeoutMinutes = latest.timeout_minutes_snapshot;
    } else {
      const repo = getRepo(task.repo_id);
      const profileId =
        task.agent_profile_id ??
        repo?.agent_profile_id ??
        getSetting('default_agent_profile_id');
      const profile = profileId ? getAgentProfile(profileId) : undefined;
      if (profile) timeoutMinutes = profile.timeout_minutes;
    }
    if (!timeoutMinutes || timeoutMinutes <= 0) return;

    const startedAtMs = new Date(latest.started_at).getTime();
    if (!Number.isFinite(startedAtMs)) return;
    const elapsedMs = Date.now() - startedAtMs;
    const killAtMs =
      (timeoutMinutes + TIMEOUT_KILL_GRACE_MINUTES) * 60 * 1000;
    if (elapsedMs <= killAtMs) return;

    this.log.warn(
      {
        event: 'timeout_kill',
        task_id: task.id,
        attempt_id: latest.id,
        elapsed_minutes: Math.floor(elapsedMs / 60000),
        timeout_minutes: timeoutMinutes,
        grace_minutes: TIMEOUT_KILL_GRACE_MINUTES,
      },
      'Agent container exceeded timeout + grace; orchestrator-side kill'
    );
    recordTaskEvent(
      task.id,
      'container_timeout_kill',
      `Killed container after ${Math.floor(elapsedMs / 60000)}m ` +
        `(timeout ${timeoutMinutes}m + ${TIMEOUT_KILL_GRACE_MINUTES}m grace)`
    );

    // Pre-write result.json so processCompletedContainer dispatches as
    // a clean timeout instead of "result.json missing" generic failure.
    // Best-effort: if the directory is gone or the write fails, the
    // kill still proceeds and the normal "no result.json" fallback
    // produces a (less specific) failure record.
    const outputDir = getOutputDir(task);
    try {
      await fsp.mkdir(outputDir, { recursive: true });
      await fsp.writeFile(
        path.join(outputDir, 'result.json'),
        JSON.stringify({
          status: 'timeout',
          exit_code: 124,
          error_message:
            `Agent exceeded timeout of ${timeoutMinutes} minutes ` +
            `(orchestrator-side kill after ${TIMEOUT_KILL_GRACE_MINUTES}min grace; ` +
            `the in-container wrapper failed to enforce the timeout itself).`,
        })
      );
    } catch (err) {
      this.log.error(
        { event: 'timeout_result_write_failed', task_id: task.id, err },
        'Failed to pre-write timeout result.json — kill will fall back to generic failure'
      );
    }

    try {
      const container = getContainer(task.container_id!);
      await stopContainer(container);
    } catch (err) {
      this.log.warn(
        { event: 'timeout_kill_failed', task_id: task.id, err },
        'Container stop failed during timeout enforcement; will retry on next sweep'
      );
      // Don't remove/finalise here — let the next tick try again, or
      // checkCompletedContainers pick it up if the container did exit.
    }
    // Intentionally do NOT remove the container or run completion logic
    // here. The next `checkCompletedContainers` step (this same tick)
    // sees the exited container, reads the pre-written result.json,
    // and dispatches through the normal develop/review completion path.
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

      // The harness wrapper never wrote result.json. The most useful
      // diagnostic at this point is the container's own log buffer —
      // the kernel exec failure ("no such file or directory" for a
      // CRLF-shebang script) and similar early failures show up there
      // but never make it to /output/result.json or progress.log
      // because the wrapper never started. Pattern-match a small tail
      // of logs into a categorized task_event when we recognise the
      // failure mode; the UI's StructuralFailureBanner picks it up.
      try {
        const container = getContainer(task.container_id!);
        const logBuf = await container.logs({
          stdout: true,
          stderr: true,
          tail: 200,
        });
        const logText =
          typeof logBuf === 'string'
            ? logBuf
            : Buffer.isBuffer(logBuf)
              ? logBuf.toString('utf-8')
              : '';
        const category = categorizeContainerExitFailure(logText);
        if (category) {
          recordTaskEvent(task.id, category.eventType, category.message);
        }
      } catch {
        // Best effort — if the container's gone or logs API errors,
        // fall through to the generic "no result.json" failure.
      }
    }

    // Read role from the latest attempt row. The attempts table is the
    // authoritative record of what kind of run this was; meta.json on
    // disk is a stale on-orchestrator-restart-rebuilt artifact and can
    // be missing entirely on the recovery path. Falling back to
    // meta.json is a last-resort heuristic for the case where the
    // attempt row insert was somehow skipped.
    let role: 'develop' | 'review' = 'develop';
    const latestAttempt = getLatestAttempt(task.id);
    if (latestAttempt) {
      role = latestAttempt.role as 'develop' | 'review';
    } else {
      const metaPath = path.join(taskDir, 'meta.json');
      try {
        const raw = await fsp.readFile(metaPath, 'utf-8');
        const meta = JSON.parse(raw) as TaskMeta;
        role = meta.role;
        this.log.warn(
          { event: 'role_fallback_meta', task_id: task.id },
          'No attempt row for task — recovered role from meta.json'
        );
      } catch {
        this.log.warn(
          { event: 'meta_missing', task_id: task.id },
          'meta.json not found and no attempt row — assuming develop role'
        );
      }
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
    // `paused` is checked only here, at fillSlots entry — not mid-loop.
    // Intentional: a pause() call during an in-flight fillSlots will
    // let the current candidate selection complete (so we don't strand
    // a partially-launched task), and the NEXT tick's fillSlots will
    // bail at this guard. Reconciliation and completed-container
    // handling continue regardless of pause state (see tick() docstring).
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

    // Snapshot provider resolution once per tick keyed by task id. Both
    // the active-task accounting AND the per-candidate pool gate read
    // through this cache so they cannot disagree if settings or
    // profiles change mid-tick (e.g. the operator points
    // default_agent_profile_id at a different provider between the
    // accounting build and the candidate loop). The same task id always
    // bucket-counts and gate-checks against the same provider key.
    const providerIdCache = new Map<number, string | null>();
    const cachedProviderIdForTask = (t: Task): string | null => {
      if (!providerIdCache.has(t.id)) {
        providerIdCache.set(t.id, this.providerIdForTask(t));
      }
      return providerIdCache.get(t.id) ?? null;
    };

    const activeByProvider = countActiveByProvider(active, cachedProviderIdForTask);
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
      const providerKey = resolveProviderKey(task, cachedProviderIdForTask(task));
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

    // Record attempt with a snapshot of the profile/harness/model
    // resolved at this exact launch moment. Captured here — not at
    // queue time and not deferred to later reads — because this is
    // the single queued→in-progress transition for this attempt and
    // operator edits to the profile after this point must not change
    // what this attempt audits as having run with (H5).
    const attempt = insertAttempt({
      task_id: task.id,
      attempt_number: task.attempt,
      role: 'develop',
      status: 'running',
      model_id: ctx.invocation.resolved_model,
      harness_id: ctx.harness.id,
      timeout_minutes_snapshot: ctx.profile.timeout_minutes,
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

    // Record attempt with snapshot of harness + model + timeout used.
    // Same snapshot policy as launchDevContainer — review attempts are
    // also a queued→in-progress transition for the review run.
    const attempt = insertAttempt({
      task_id: task.id,
      attempt_number: task.attempt,
      role: 'review',
      status: 'running',
      model_id: ctx.invocation.resolved_model,
      harness_id: ctx.harness.id,
      timeout_minutes_snapshot: ctx.profile.timeout_minutes,
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
    waitForContainer(container).then(() => {
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
      // Recovery path: activeState is empty after restart. Pull role
      // AND the resolved harness/model snapshot from meta.json so the
      // late-created attempt row carries the same audit trail it would
      // have had on the happy path. meta.json is written by
      // writeTaskFiles at launch time so it's the closest thing we have
      // to a captured launch context after an orchestrator crash.
      const metaPath = path.join(getTaskDir(task), 'meta.json');
      let role: 'develop' | 'review' = 'develop';
      let modelSnapshot: string | null = null;
      let harnessSnapshot: string | null = null;
      let timeoutSnapshot: number | null = null;
      try {
        const raw = await fsp.readFile(metaPath, 'utf-8');
        // Cast to TaskMeta so a typo like `meta.harnes_id` would
        // surface as a TS error instead of silently producing null.
        // The `Partial<>` reflects that on-disk meta.json can be from
        // a different orchestrator version with a different field set.
        const meta = JSON.parse(raw) as Partial<TaskMeta>;
        role = meta.role ?? 'develop';
        modelSnapshot =
          typeof meta.model === 'string' && meta.model.length > 0
            ? meta.model
            : null;
        harnessSnapshot =
          typeof meta.harness_id === 'string' && meta.harness_id.length > 0
            ? meta.harness_id
            : null;
        // meta.max_runtime_minutes was written from profile.timeout_minutes
        // at launch time (see writeTaskFiles). It's the same value the
        // happy-path insertAttempt would have snapshotted, so the
        // recovered attempt carries an audit-equivalent row.
        timeoutSnapshot =
          typeof meta.max_runtime_minutes === 'number' &&
          Number.isFinite(meta.max_runtime_minutes) &&
          meta.max_runtime_minutes > 0
            ? meta.max_runtime_minutes
            : null;
      } catch { /* default to develop, no snapshots */ }

      const existing = getRunningAttempt(task.id, task.attempt, role);
      if (existing) {
        attemptId = existing.id;
      } else {
        // Orchestrator crashed before creating the attempt row — create
        // one now with whatever snapshot fields we could recover from
        // meta.json. Missing snapshots stay null (the original launch's
        // context is lost; null is still better than fabricating
        // values).
        const newAttempt = insertAttempt({
          task_id: task.id,
          attempt_number: task.attempt,
          role,
          status: 'running',
          model_id: modelSnapshot,
          harness_id: harnessSnapshot,
          timeout_minutes_snapshot: timeoutSnapshot,
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

    // Categorize known structural failures BEFORE the generic prep-failure
    // bookkeeping. Categorized failures get a dedicated task_event row
    // with an actionable message — the UI's Task Detail page renders a
    // banner for these so operators don't have to grep docker logs to
    // figure out what to fix. The generic prep-failure log line still
    // fires below regardless.
    const category = categorizePrepFailure(errorMsg);
    if (category) {
      recordTaskEvent(task.id, category.eventType, category.message);
    }

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
  // On rework cycles the self-review must also be checked against the
  // accumulated review feedback (appended in the section below), not just
  // the original task. Kept as a single extra sub-point so the step stays
  // concise on the initial (feedback === null) attempt.
  const selfReviewFeedbackPoint = feedback
    ? `\n   - Also re-check your diff against the "Review Feedback" section below and confirm every feedback item is fully addressed.`
    : '';

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
6. Self-review before committing — critique your own work; do not rely solely on the downstream review:
   - Re-read the task requirements and acceptance criteria above.
   - Compare them against your working tree (git status / git diff).
   - Explicitly enumerate any unmet requirements, bugs, missing tests, or unrelated/incidental changes.${selfReviewFeedbackPoint}
   - Fix every gap you found, then continue.
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
