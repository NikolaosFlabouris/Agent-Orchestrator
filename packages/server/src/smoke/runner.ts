import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { HarnessId, Provider } from '@orchestrator/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { HarnessInvocation, HarnessSpec } from '../harnesses/index.js';
import { buildProviderEnv } from '../providers/kinds.js';
import { buildContainerEnv, type TaskMeta } from '../scheduler.js';
import { writeHarnessConfigFiles } from '../workspace.js';
import { decideCost, type SmokeCase } from './cases.js';
import {
  classifyLiveAttempt,
  computePromotable,
  countOutcomes,
  countToolCalls,
  excerpt,
  logShowsUsageLimit,
  makeRedactor,
  type CaseResult,
  type Classification,
  type CliVersions,
  type LiveObservation,
  type SmokeReport,
  type StaticCheckResult,
} from './outcome.js';
import { staticChecksFor } from './static-checks.js';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Harness smoke-test runner. Drives the cases built by cases.ts through the
// orchestrator's own launch path (buildInvocation → meta.json/prompt.md →
// createAgentContainer) against a given agent image. Docker access sits
// behind SmokeDriver so the logic is unit-testable; docker-driver.ts is the
// real implementation.
//
// Never touches the DB beyond the read-only config source the caller built
// the cases from, never calls Forgejo, never uses a real task workspace.
// ---------------------------------------------------------------------------

/** Labels on every smoke container. Deliberately NOT `managed-by=
 *  orchestrator`, so the running orchestrator's reaper, orphan recovery
 *  and host-capacity accounting never see (or kill) them. */
export const SMOKE_LABEL_MANAGED_BY = 'orchestrator-smoke';

export interface RunInImageOptions {
  image: string;
  script: string;
  /** false → no network at all; true → the agent network real tasks use. */
  network: boolean;
  timeoutMs: number;
  env?: string[];
  /** Orchestrator-side path mounted read-only at /repo (working dir). */
  repoDir?: string;
  labels: Record<string, string>;
}

export interface AgentLaunchOptions {
  image: string;
  harnessRuntime: 'sdk' | 'cli';
  workdir: string;
  taskDir: string;
  outputDir: string;
  cacheDir: string;
  env: string[];
  labels: Record<string, string>;
}

export interface AgentHandle {
  /** Resolves with the container's exit code. */
  wait(): Promise<number>;
  /** Stop and remove the container. Idempotent, never throws. */
  dispose(): Promise<void>;
}

export interface SmokeDriver {
  /** Run a bash script in a throwaway container of `image`. exitCode is
   *  null when the timeout fired. */
  runInImage(opts: RunInImageOptions): Promise<{ exitCode: number | null; output: string }>;
  /** Create and start an agent container through createAgentContainer. */
  launchAgent(opts: AgentLaunchOptions): Promise<AgentHandle>;
}

export interface SmokeRunOptions {
  image: string;
  cases: SmokeCase[];
  harnesses: HarnessSpec[];
  driver: SmokeDriver;
  workspacesRoot: string;
  cachesRoot: string;
  caseTimeoutMs: number;
  overallTimeoutMs: number;
  /** Progress lines (already redacted). Defaults to stderr. */
  progress?: (line: string) => void;
  /** Poll interval while an agent runs. */
  pollIntervalMs?: number;
  now?: () => number;
}

/** The fixed live task: calc.add subtracts; the agent must fix it. */
export const CALC_PY = `def add(a, b):
    """Return the sum of a and b."""
    return a - b
`;

export const SMOKE_PROMPT = `The function \`add\` in \`calc.py\` (in the current directory) is
broken: it subtracts instead of adding. Fix it so it returns a + b, then run

    python3 -c "import calc; print(calc.add(2, 3))"

and check that it prints 5. Change nothing else and do not commit.
`;

/** Runner-side check of the fix. Different inputs from the prompt, so a
 *  hard-coded `return 5` doesn't pass. */
export const VERIFY_SCRIPT =
  'python3 -c "import sys, calc; ' +
  'sys.exit(0 if calc.add(2, 3) == 5 and calc.add(-4, 10) == 6 and calc.add(7, 0) == 7 else 1)"';

export async function runSmoke(opts: SmokeRunOptions): Promise<SmokeReport> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + opts.overallTimeoutMs;
  const runId = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const labels = { 'managed-by': SMOKE_LABEL_MANAGED_BY, 'smoke-run': runId };

  // Every credential any case could export — scrubbed from everything the
  // runner emits.
  const secrets = new Set<string>();
  for (const c of opts.cases) {
    if (c.provider) for (const v of Object.values(buildProviderEnv(c.provider))) secrets.add(v);
  }
  const redact = makeRedactor(secrets);
  const say = (line: string) =>
    (opts.progress ?? ((l: string) => process.stderr.write(`${l}\n`)))(redact(line));

  // Build every invocation up front: the flags a profile makes a harness
  // emit (e.g. claude's --effort) feed the static help checks.
  const invocations = new Map<string, HarnessInvocation | Error>();
  const extraFlags = new Map<HarnessId, Set<string>>();
  const harnessById = new Map(opts.harnesses.map((h) => [h.id, h]));
  for (const c of opts.cases) {
    if (!c.profile || !c.model || !c.provider) continue;
    const harness = harnessById.get(c.harness_id);
    if (!harness) continue;
    try {
      const inv = harness.buildInvocation({
        profile: c.profile,
        model: c.model,
        provider: c.provider,
        promptFilePath: '/task/prompt.md',
      });
      invocations.set(c.key, inv);
      if (c.harness_id === 'claude-code' && inv.effort_level !== undefined) {
        const s = extraFlags.get(c.harness_id) ?? new Set<string>();
        s.add('--effort');
        extraFlags.set(c.harness_id, s);
      }
    } catch (err) {
      invocations.set(c.key, err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ---- Static checks ------------------------------------------------------
  const versions: CliVersions = {
    'claude-code': null,
    opencode: null,
    pi: null,
    'claude-agent-sdk': null,
  };
  const staticChecks: StaticCheckResult[] = [];
  for (const harness of opts.harnesses) {
    for (const check of staticChecksFor(harness.id, [...(extraFlags.get(harness.id) ?? [])])) {
      say(`[static] ${harness.id}/${check.name} …`);
      let run: { exitCode: number | null; output: string };
      try {
        run = await opts.driver.runInImage({
          image: opts.image,
          script: check.script,
          network: check.network ?? false,
          timeoutMs: check.timeoutMs ?? 60_000,
          labels,
        });
      } catch (err) {
        run = { exitCode: -1, output: String(err) };
      }
      const verdict = check.evaluate(run);
      if (verdict.outcome === 'pass' && verdict.version && check.version) {
        versions[check.version] = redact(verdict.version);
      }
      const result: StaticCheckResult = {
        harness_id: harness.id,
        check: check.name,
        outcome: verdict.outcome,
        reason: verdict.outcome === 'pass' ? null : verdict.reason,
        error_excerpt: verdict.outcome === 'pass' ? null : excerpt(verdict.detail, redact),
      };
      staticChecks.push(result);
      say(`[static] ${harness.id}/${check.name}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
    }
  }

  // ---- Cases --------------------------------------------------------------
  const reachability = new Map<string, boolean>();
  const cases: CaseResult[] = [];
  for (const c of opts.cases) {
    const caseStart = now();
    const base = {
      key: c.key,
      harness_id: c.harness_id,
      profile_ids: c.profile_ids,
      sources: c.sources,
      provider_id: c.provider_id,
      provider_kind: c.provider?.kind ?? null,
      model_id: c.model_id,
    };
    const finish = (live: boolean, cls: Classification, attempts: number): CaseResult => ({
      ...base,
      live_eligible: live,
      outcome: cls.outcome,
      reason: cls.reason,
      error_excerpt: excerpt(cls.detail, redact),
      attempts,
      duration_ms: now() - caseStart,
    });

    if (!c.provider || !c.model || !c.profile) {
      // The built-in config declares its entries as free live routes, so an
      // unresolved one must still count as one — otherwise a renamed local
      // provider would silently drop the harness from the promotable rule.
      cases.push(finish(c.sources.includes('builtin'), { outcome: 'skipped', reason: 'not_configured', detail: c.resolution_error }, 0));
      say(`[case] ${c.key}: skipped (not_configured)`);
      continue;
    }
    const cost = decideCost(c.provider);
    const inv = invocations.get(c.key);
    if (!inv || inv instanceof Error) {
      cases.push(finish(cost.live, { outcome: 'fail', reason: 'invocation_error', detail: inv?.message ?? 'unknown harness' }, 0));
      say(`[case] ${c.key}: fail (invocation_error)`);
      continue;
    }
    if (!cost.live) {
      cases.push(finish(false, { outcome: 'not_live_tested', reason: cost.reason }, 0));
      say(`[case] ${c.key}: not_live_tested (${cost.reason})`);
      continue;
    }

    let reachable = reachability.get(c.provider.id);
    if (reachable === undefined) {
      reachable = await preflight(opts.driver, opts.image, c.provider, labels);
      reachability.set(c.provider.id, reachable);
    }

    // One retry for a failing live case; a skip is final.
    let cls: Classification = { outcome: 'skipped', reason: 'overall_timeout' };
    let attempts = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!reachable) {
        cls = { outcome: 'skipped', reason: 'provider_unreachable' };
        break;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        cls = { outcome: 'skipped', reason: 'overall_timeout' };
        break;
      }
      attempts = attempt;
      say(`[case] ${c.key}: live attempt ${attempt} …`);
      const obs = await runLiveAttempt({
        opts,
        smokeCase: c,
        invocation: inv,
        harness: harnessById.get(c.harness_id)!,
        runId,
        attempt,
        labels,
        timeoutMs: Math.min(opts.caseTimeoutMs, remaining),
        overallLimited: remaining < opts.caseTimeoutMs,
        localProvider: cost.route === 'local',
        now,
      });
      cls = classifyLiveAttempt(obs);
      say(`[case] ${c.key}: attempt ${attempt} → ${cls.outcome}${cls.reason ? ` (${cls.reason})` : ''}`);
      if (cls.outcome !== 'fail') break;
    }
    cases.push(finish(true, cls, attempts));
  }

  const { promotable, blockers } = computePromotable(cases, staticChecks);
  return {
    image: opts.image,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(now()).toISOString(),
    versions,
    promotable,
    promotable_blockers: blockers.map(redact),
    counts: countOutcomes(cases, staticChecks),
    static_checks: staticChecks,
    cases,
  };
}

/** Endpoint probed before launching a live case. Any HTTP response counts
 *  as reachable — this only rules out "the server isn't there". */
export function preflightUrl(provider: Pick<Provider, 'kind' | 'base_url'>): string | null {
  if (provider.kind === 'claude-subscription') return 'https://api.anthropic.com/';
  if (provider.base_url) {
    const base = provider.base_url.replace(/\/+$/, '');
    return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  }
  return null;
}

/** Probe from inside the image under test, on the agent network, so the
 *  check sees exactly the DNS and routes an agent container would. */
async function preflight(
  driver: SmokeDriver,
  image: string,
  provider: Provider,
  labels: Record<string, string>
): Promise<boolean> {
  const url = preflightUrl(provider);
  if (!url) return false;
  try {
    const run = await driver.runInImage({
      image,
      script: 'curl -sS -o /dev/null -m 10 "$SMOKE_PREFLIGHT_URL"',
      env: [`SMOKE_PREFLIGHT_URL=${url}`],
      network: true,
      timeoutMs: 30_000,
      labels,
    });
    return run.exitCode === 0;
  } catch {
    return false;
  }
}

interface LiveAttemptContext {
  opts: SmokeRunOptions;
  smokeCase: SmokeCase;
  invocation: HarnessInvocation;
  harness: HarnessSpec;
  runId: string;
  attempt: number;
  labels: Record<string, string>;
  timeoutMs: number;
  /** The timeout is the overall deadline, not the per-case one. */
  overallLimited: boolean;
  localProvider: boolean;
  now: () => number;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function runLiveAttempt(ctx: LiveAttemptContext): Promise<LiveObservation> {
  const { opts, smokeCase: c, invocation } = ctx;
  const name = `smoke-${ctx.runId}-${slug(`${c.harness_id}-${c.provider_id}-${c.model_id}`)}-a${ctx.attempt}`;
  const root = path.join(opts.workspacesRoot, name);
  const workdir = path.join(root, 'repo');
  const taskDir = path.join(root, 'task');
  const outputDir = path.join(root, 'output');
  const cacheDir = path.join(opts.cachesRoot, name);
  const obs: LiveObservation = {
    reachable: true,
    timedOut: false,
    overallDeadlineHit: false,
    localProvider: ctx.localProvider,
    result: null,
    log: '',
    fixVerified: null,
    toolCalls: null,
  };

  let handle: AgentHandle | null = null;
  try {
    await prepareSmokeWorkspace(workdir, taskDir, outputDir);
    await writeSmokeTaskFiles(taskDir, c, invocation, ctx.harness, ctx.timeoutMs);
    if (invocation.config_files.length > 0) {
      await writeHarnessConfigFiles(
        { id: 0, repo_id: 0, issue_id: 0 },
        invocation.config_files,
        c.harness_id,
        silentLogger,
        workdir
      );
    }
    await chownTree(root);

    try {
      handle = await opts.driver.launchAgent({
        image: opts.image,
        harnessRuntime: ctx.harness.runtime,
        workdir,
        taskDir,
        outputDir,
        cacheDir,
        env: buildContainerEnv(c.provider!, invocation),
        labels: ctx.labels,
      });
    } catch (err) {
      obs.launchError = err instanceof Error ? err.message : String(err);
      return obs;
    }

    const status = await waitForAgent(handle, outputDir, ctx.timeoutMs, opts.pollIntervalMs ?? 3000, ctx.now);
    if (status === 'timeout') {
      obs.timedOut = !ctx.overallLimited;
      obs.overallDeadlineHit = ctx.overallLimited;
    }
    await handle.dispose();
    handle = null;

    obs.log = await readText(path.join(outputDir, 'progress.log'));
    const resultText = await readText(path.join(outputDir, 'result.json'));
    if (resultText) {
      try {
        obs.result = JSON.parse(resultText) as LiveObservation['result'];
      } catch {
        obs.result = { status: 'unparsable', error_message: resultText };
      }
    }
    obs.toolCalls = countToolCalls(c.harness_id, obs.log);

    if (status === 'exited' && obs.result?.status === 'success') {
      try {
        const verify = await opts.driver.runInImage({
          image: opts.image,
          script: VERIFY_SCRIPT,
          network: false,
          timeoutMs: 60_000,
          repoDir: workdir,
          labels: ctx.labels,
        });
        obs.fixVerified = verify.exitCode === null ? null : verify.exitCode === 0;
      } catch {
        obs.fixVerified = null;
      }
    }
    return obs;
  } catch (err) {
    obs.launchError = err instanceof Error ? err.message : String(err);
    return obs;
  } finally {
    if (handle) await handle.dispose();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Wait for the agent to exit, the timeout to fire, or the harness to park
 *  on a usage limit (harness-cli.sh would otherwise sleep until its own
 *  deadline). */
async function waitForAgent(
  handle: AgentHandle,
  outputDir: string,
  timeoutMs: number,
  pollMs: number,
  now: () => number
): Promise<'exited' | 'timeout' | 'usage_limit'> {
  let exited = false;
  const done = handle.wait().then(
    () => { exited = true; },
    () => { exited = true; }
  );
  const end = now() + timeoutMs;
  for (;;) {
    await Promise.race([done, sleep(Math.max(0, Math.min(pollMs, end - now())))]);
    if (exited) return 'exited';
    if (logShowsUsageLimit(await readText(path.join(outputDir, 'progress.log')))) {
      return 'usage_limit';
    }
    if (now() >= end) return 'timeout';
  }
}

async function prepareSmokeWorkspace(workdir: string, taskDir: string, outputDir: string): Promise<void> {
  for (const d of [workdir, taskDir, outputDir]) await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(workdir, 'calc.py'), CALC_PY, 'utf-8');
  const git = (...args: string[]) =>
    execFileP(
      'git',
      ['-c', 'user.email=smoke@orchestrator.local', '-c', 'user.name=Harness Smoke', ...args],
      { cwd: workdir }
    );
  await git('init', '-q', '-b', 'main');
  await git('add', 'calc.py');
  await git('commit', '-q', '-m', 'Add calc.py');
}

/** meta.json / prompt.md in the shape scheduler.writeTaskFiles produces. */
async function writeSmokeTaskFiles(
  taskDir: string,
  c: SmokeCase,
  invocation: HarnessInvocation,
  harness: HarnessSpec,
  timeoutMs: number
): Promise<void> {
  await fsp.writeFile(path.join(taskDir, 'prompt.md'), SMOKE_PROMPT, 'utf-8');
  const meta: TaskMeta = {
    issue_id: 0,
    branch_name: 'main',
    base_branch: 'main',
    // A little past the runner's own timeout, so the runner's timer (which
    // knows about the overall deadline) is what normally fires.
    max_runtime_minutes: Math.ceil(timeoutMs / 60_000) + 2,
    attempt: 1,
    role: 'develop',
    pr_number: null,
    model: invocation.resolved_model,
    harness_id: harness.id,
    agent_profile_id: c.profile!.id,
    install_commands: [],
    agent_command: invocation.agent_command ?? '',
  };
  if (invocation.effort_level !== undefined) meta.effort_level = invocation.effort_level;
  await fsp.writeFile(path.join(taskDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/** chown the throwaway workspace to the agent user (uid 1000), as
 *  prepareWorkspace does for real tasks. Best effort; no-op off Linux. */
async function chownTree(dir: string): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    await fsp.chown(dir, 1000, 1000);
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await chownTree(p);
      else await fsp.chown(p, 1000, 1000).catch(() => undefined);
    }
  } catch {
    /* best effort — not root (tests) or dir vanished */
  }
}

async function readText(p: string): Promise<string> {
  try {
    return await fsp.readFile(p, 'utf-8');
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const noop = () => undefined;
/** writeHarnessConfigFiles wants a Fastify logger; its lines (paths only)
 *  aren't useful in the smoke output. */
const silentLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;
