/**
 * Git-host outage resilience.
 *
 * The orchestrator talks to a single external Forgejo instance for every
 * clone/fetch/push it performs. When that host goes away (network blip,
 * restart, disk-corruption incident) every one of those operations fails —
 * and before this module existed, each failure was counted as a *task*
 * failure: three retries on consecutive scheduler ticks (~300 ms apart in
 * production logs) and the task was permanently `failed`. A one-minute
 * outage was enough to burn the entire queue.
 *
 * The primitives here let the scheduler treat an outage as a reason to
 * WAIT rather than a reason to FAIL:
 *
 *  - `classifyGitFailure` separates outage-shaped ("infra") errors from
 *    structural ones (bad branch, missing repo, auth misconfiguration).
 *    Only infra-shaped failures get backoff treatment; structural ones
 *    keep failing fast exactly as they did before.
 *  - `computeBackoffMs` spaces retries exponentially with jitter, on a
 *    minutes scale, capped.
 *  - `GitHostHealth` gates prep launches per git host after consecutive
 *    cross-task failures until a cheap liveness probe succeeds, so a
 *    queue of N tasks doesn't each independently hammer a dead host.
 *  - `sanitizeGitError` redacts the credentials the orchestrator embeds
 *    in clone URLs and truncates, so the underlying git text is safe to
 *    persist in a `task_events` row.
 */

import {
  GIT_BACKOFF_BASE_SECONDS,
  GIT_BACKOFF_MAX_SECONDS,
  GIT_BACKOFF_JITTER_RATIO,
  GIT_HOST_FAILURE_THRESHOLD,
  GIT_HOST_PROBE_INTERVAL_SECONDS,
  TASK_EVENT_ERROR_MAX_CHARS,
} from './constants.js';

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Outage-shaped signatures. Every entry here means "the remote (or the
 *  network path to it) is unhealthy right now" — the same operation has a
 *  good chance of succeeding once the host comes back, so the caller should
 *  wait rather than consume a retry budget.
 *
 *  The corruption entries look structural but are not: during the
 *  2026-07-23 incident Forgejo served `remote: fatal: bad tree object <sha>
 *  … aborting due to possible repository corruption on the remote side`
 *  from a half-broken repository that healed on its own once the instance
 *  was repaired. Retrying is the right move; failing the task is not. */
const INFRA_PATTERNS: RegExp[] = [
  // -- Transport / connectivity --
  /connection refused/i,
  /connection reset/i,
  /connection timed out/i,
  /failed to connect to/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /the remote end hung up unexpectedly/i,
  /early eof/i,
  /rpc failed/i,
  /unexpected disconnect/i,
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|EPIPE)\b/,
  /gnutls_handshake|ssl_read|ssl_write/i,
  // -- git's generic "the other side said no" for an unreachable host --
  /could not read from remote repository/i,
  /unable to access '[^']*':/i,
  // -- Remote-side corruption / server errors (transient in practice) --
  /repository corruption on the remote side/i,
  /remote:\s*(fatal:\s*)?bad (tree|blob|commit) object/i,
  /remote error:\s*(internal|unavailable|service unavailable)/i,
  /\b(500 internal server error|502 bad gateway|503 service unavailable|504 gateway time-?out)\b/i,
  // -- Our own timeout wrapper (see workspace.ts `git`) --
  /timed out after \d+s/i,
];

/** Does this message come from a git invocation (as opposed to Docker, the
 *  Forgejo REST client, or the scheduler's own config resolution)? Used to
 *  decide whether a failure should also count against the shared git-host
 *  health gate — a Docker daemon `connection refused` says nothing about
 *  Forgejo's health. */
export function isGitOperationError(errorMsg: string): boolean {
  return /(^|\s)git\s/i.test(errorMsg) || /^\s*(remote|fatal):/im.test(errorMsg);
}

export type GitFailureKind = 'infra' | 'other';

/** Classify a failure message as outage-shaped (`infra`) or not (`other`).
 *  `other` covers both known-structural failures and anything unrecognised;
 *  callers keep their existing fail-fast handling for those. */
export function classifyGitFailure(errorMsg: string): GitFailureKind {
  return INFRA_PATTERNS.some((p) => p.test(errorMsg)) ? 'infra' : 'other';
}

/** Convenience predicate over `classifyGitFailure`. */
export function isInfraGitFailure(errorMsg: string): boolean {
  return classifyGitFailure(errorMsg) === 'infra';
}

// ---------------------------------------------------------------------------
// Error text for task events
// ---------------------------------------------------------------------------

/** Strip `//user:token@host` credentials out of any URL in the text. The
 *  orchestrator clones over `http://agent:<FORGEJO_AGENT_TOKEN>@host/...`,
 *  and Node puts the full command line into an execFile error message — so
 *  without this the agent token would land in a task_events row that the
 *  Task Detail page renders verbatim. */
export function redactCredentials(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]+(?::[^/@\s]*)?@/g, '$1***@');
}

/** Prepare a raw git/launch error for storage in a task_events row:
 *  credentials redacted, whitespace collapsed, truncated to a sane length.
 *  The full text still goes to the structured log; this is the copy that
 *  survives container recreation (pino logs rotate away with the
 *  container — that's precisely why the event row exists). */
export function sanitizeGitError(
  errorMsg: string,
  maxChars = TASK_EVENT_ERROR_MAX_CHARS
): string {
  const clean = redactCredentials(errorMsg).replace(/\s+/g, ' ').trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars)}…`;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Delay for level 1, in ms. Doubles per level. */
  baseMs?: number;
  /** Ceiling for the pre-jitter delay, in ms. */
  maxMs?: number;
  /** Jitter as a fraction of the delay, applied as ±ratio. 0 disables. */
  jitterRatio?: number;
  /** Injectable RNG for deterministic tests. Must return [0, 1). */
  random?: () => number;
}

/**
 * Exponential backoff with jitter for the Nth consecutive infra failure.
 *
 * `level` is 1-based: the first failure schedules the base delay, the
 * second twice that, and so on until the cap. Jitter (±20% by default)
 * de-synchronises the queue so N tasks waiting out the same outage don't
 * all retry in the same instant when it ends.
 */
export function computeBackoffMs(
  level: number,
  opts: BackoffOptions = {}
): number {
  const baseMs = opts.baseMs ?? GIT_BACKOFF_BASE_SECONDS * 1000;
  const maxMs = opts.maxMs ?? GIT_BACKOFF_MAX_SECONDS * 1000;
  const jitterRatio = opts.jitterRatio ?? GIT_BACKOFF_JITTER_RATIO;
  const random = opts.random ?? Math.random;

  const safeLevel = Math.max(1, Math.floor(level));
  // Cap the exponent before computing the power so a runaway level can't
  // overflow into Infinity on the way to Math.min.
  const exponent = Math.min(safeLevel - 1, 30);
  const raw = Math.min(baseMs * 2 ** exponent, maxMs);
  const jitter = raw * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

/** ISO timestamp for the next attempt after `level` consecutive infra
 *  failures. Stored in `tasks.prep_next_attempt_at` /
 *  `tasks.salvage_next_attempt_at`. */
export function nextAttemptAt(
  level: number,
  opts: BackoffOptions & { now?: number } = {}
): string {
  const now = opts.now ?? Date.now();
  return new Date(now + computeBackoffMs(level, opts)).toISOString();
}

/** Whether a persisted next-attempt timestamp has come due. An unparsable
 *  value is treated as due — a corrupt timestamp must never strand a task
 *  in the queue forever. */
export function backoffElapsed(
  nextAttemptIso: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!nextAttemptIso) return true;
  const ms = Date.parse(nextAttemptIso);
  if (Number.isNaN(ms)) return true;
  return ms <= now;
}

/** Human-readable delay for task-event messages ("2m 30s"). */
export function formatDelay(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

// ---------------------------------------------------------------------------
// Per-host health gate
// ---------------------------------------------------------------------------

interface HostState {
  /** Consecutive infra-shaped failures across ALL tasks on this host. */
  consecutiveFailures: number;
  /** True once the threshold is crossed; cleared by a successful probe or
   *  a successful real operation. */
  gated: boolean;
  /** Epoch ms of the last probe attempt (successful or not). */
  lastProbeAt: number | null;
}

export interface GitHostHealthOptions {
  /** Consecutive cross-task failures before the host is gated. */
  failureThreshold?: number;
  /** Minimum spacing between liveness probes of a gated host, in ms. */
  probeIntervalMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Cross-task circuit breaker for a git host.
 *
 * Per-task backoff alone still lets a queue of 11 tasks each independently
 * discover that the host is down. Once `failureThreshold` consecutive
 * infra-shaped failures have been observed for a host — regardless of which
 * task hit them — prep launches for that host are gated until a cheap
 * liveness probe (`git ls-remote`) succeeds. Gated tasks stay `queued`; they
 * never enter `preparing`, so they consume no attempt budget and no host
 * resources while they wait.
 *
 * Purely in-memory: a restarted orchestrator simply re-learns the host is
 * down on its first failed prep, and the persisted per-task backoff
 * (`tasks.prep_next_attempt_at`) carries the durable part of the state.
 */
export class GitHostHealth {
  private readonly states = new Map<string, HostState>();
  private readonly failureThreshold: number;
  private readonly probeIntervalMs: number;
  private readonly now: () => number;
  /** Hosts with a probe in flight — keeps overlapping ticks from firing
   *  duplicate probes at an already-struggling host. */
  private readonly probing = new Set<string>();

  constructor(opts: GitHostHealthOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? GIT_HOST_FAILURE_THRESHOLD;
    this.probeIntervalMs =
      opts.probeIntervalMs ?? GIT_HOST_PROBE_INTERVAL_SECONDS * 1000;
    this.now = opts.now ?? Date.now;
  }

  private stateFor(host: string): HostState {
    let state = this.states.get(host);
    if (!state) {
      state = { consecutiveFailures: 0, gated: false, lastProbeAt: null };
      this.states.set(host, state);
    }
    return state;
  }

  /** Record an infra-shaped failure against a host. Returns true if this
   *  failure is the one that closed the gate (so the caller can log the
   *  transition exactly once). */
  recordFailure(host: string): boolean {
    const state = this.stateFor(host);
    state.consecutiveFailures += 1;
    if (!state.gated && state.consecutiveFailures >= this.failureThreshold) {
      state.gated = true;
      // Leave lastProbeAt null so the first refresh() probes immediately
      // rather than waiting out a full probe interval.
      state.lastProbeAt = null;
      return true;
    }
    return false;
  }

  /** Record a successful git operation (or probe) against a host: the
   *  outage is over. Returns true if this cleared an active gate. */
  recordSuccess(host: string): boolean {
    const state = this.states.get(host);
    if (!state) return false;
    const wasGated = state.gated;
    state.consecutiveFailures = 0;
    state.gated = false;
    state.lastProbeAt = null;
    return wasGated;
  }

  /** Are prep launches for this host currently gated? */
  isGated(host: string): boolean {
    return this.states.get(host)?.gated ?? false;
  }

  /** Hosts currently gated. */
  gatedHosts(): string[] {
    return [...this.states.entries()]
      .filter(([, s]) => s.gated)
      .map(([host]) => host);
  }

  consecutiveFailures(host: string): number {
    return this.states.get(host)?.consecutiveFailures ?? 0;
  }

  /**
   * Probe every gated host whose probe interval has elapsed. `probe`
   * resolves true when the host is healthy again, which clears the gate.
   * A probe that throws is treated as "still down".
   *
   * Returns the hosts that recovered on this pass.
   */
  async refresh(probe: (host: string) => Promise<boolean>): Promise<string[]> {
    const recovered: string[] = [];
    for (const host of this.gatedHosts()) {
      const state = this.stateFor(host);
      if (this.probing.has(host)) continue;
      if (
        state.lastProbeAt !== null &&
        this.now() - state.lastProbeAt < this.probeIntervalMs
      ) {
        continue;
      }
      this.probing.add(host);
      state.lastProbeAt = this.now();
      let healthy = false;
      try {
        healthy = await probe(host);
      } catch {
        healthy = false;
      } finally {
        this.probing.delete(host);
      }
      if (healthy) {
        this.recordSuccess(host);
        recovered.push(host);
      }
    }
    return recovered;
  }
}
