/**
 * Compile-time constants for orchestrator behaviour that doesn't earn a
 * runtime knob. Settings live in the DB only when operators legitimately
 * tune them across deployments; everything else is a constant here so the
 * Global Settings tab stays focused.
 */

/** Fallback poll interval (seconds) for the Forgejo poller and the
 *  scheduler's reconciliation tick. Webhooks drive the real-time path; this
 *  is the safety net for missed events. 60s is the right tradeoff between
 *  recovery latency and Forgejo API load — lowering hammers the API,
 *  raising just delays missed-webhook recovery. */
export const POLL_INTERVAL_SECONDS = 60;

/** Default cap on dev/review cycles before a task transitions to `failed`.
 *  Per-task override is settable at task creation and editable from the
 *  Task Detail page (within `attempt..∞`). */
export const DEFAULT_MAX_ATTEMPTS = 7;

/** Floor between full dependency-evaluation passes over the queue. Every
 *  scheduler tick wants to re-derive queued tasks' dependencies from their
 *  issue bodies, but ticks also fire on every webhook — without a floor, a
 *  webhook burst (bulk label edits, batch issue updates) would multiply
 *  into a Forgejo fetch storm of queue-length × burst-size. Tasks that have
 *  never been evaluated bypass the floor so a freshly-queued task is never
 *  gated on stale (absent) rows. */
export const DEP_EVAL_MIN_INTERVAL_SECONDS = 15;

/** How long workspaces stick around after a task hits a terminal state
 *  (`merged`, `failed`, `cancelled`, `reset`, `awaiting-human-*`,
 *  `needs-human-review`). After expiry, the per-task workspace at
 *  /workspaces/issue-N/ is deleted. The same window is applied to orphan
 *  workspaces — directories with no corresponding task row in the DB —
 *  using the directory's mtime as the reference, with the buffer ensuring
 *  no race against task launch (workspaces are mkdir'd after the task row
 *  is inserted, so even a brand-new workspace already has a task to
 *  protect it). Per-repo dependency caches under /caches/ are NOT subject
 *  to this — they're shared across tasks and persist. */
export const WORKSPACE_RETENTION_DAYS = 7;

/** Cap on how long the orchestrator's graceful shutdown will wait for
 *  in-flight agent containers to finish. Schema v17 dropped the global
 *  `agent_timeout_minutes` setting that this previously tracked, and
 *  per-tool timeouts now go up to 2880 min (48 h) for free local tools —
 *  waiting that long on `docker compose down` would be unacceptable. So
 *  the drain is capped here. Mid-flight long-running agents get SIGKILL'd
 *  at the cap; startup recovery handles them on the next boot.
 *
 *  Must align with `stop_grace_period` in docker-compose.yml (set to
 *  `35m` to give this 30-minute drain a small buffer). If you raise this,
 *  raise `stop_grace_period` to match (`(this + 5)m`). */
export const DRAIN_TIMEOUT_MINUTES = 30;

/** Multiplier on a task's per-tool timeout above which the alerts pass
 *  flags the task as stuck. e.g. with the seeded paid-tool timeout of
 *  120 min, a task is flagged when it's been running for 240 min. */
export const STUCK_TASK_TIMEOUT_MULTIPLIER = 2;

/** Grace period (minutes) the orchestrator adds to `profile.timeout_minutes`
 *  before SIGKILLing the agent container itself. The agent's in-container
 *  wrapper (harness-cli.sh `timeout` / harness-sdk.ts `setTimeout`)
 *  enforces the configured timeout from inside; this scheduler-side kill
 *  is the safety net for the case where the wrapper crashed before its
 *  timer armed, or where the agent process disowned itself. Five minutes
 *  is enough for a normal wrapper to finalise its result.json after the
 *  in-container timer fires, while still capping runaway containers
 *  inside one alert window (`STUCK_TASK_TIMEOUT_MULTIPLIER × timeout`).
 *
 *  See `Scheduler.enforceTimeouts()` for the call site. */
export const TIMEOUT_KILL_GRACE_MINUTES = 5;

/** Default Docker memory limit (MB) for an agent container when a repo
 *  doesn't override it. The agent process itself is light (~100–500 MB);
 *  these defaults exist for the tool commands the agent runs (npm ci,
 *  pytest, tsc, etc.). 4 GB / 2 cores covers small-to-medium projects.
 *  Heavy workloads (Rust workspaces, large Next.js builds, Bazel) need
 *  more — set per-repo via `repos.container_memory_mb` /
 *  `repos.container_cpu_cores`. Schema v18 dropped the two corresponding
 *  global settings since operators rarely tuned them in practice; the
 *  per-repo override is the load-bearing knob. */
export const DEFAULT_CONTAINER_MEMORY_MB = 4096;
export const DEFAULT_CONTAINER_CPU_CORES = 2;

/** In-container roots for per-task workspaces and per-repo dependency caches.
 *  These are bind-mounted from the host at the same paths (see
 *  docker-compose.yml). The orchestrator passes its in-container path as the
 *  source of agent-container bind mounts; the Docker daemon interprets that
 *  as a HOST path, so in-container path MUST equal host path for sibling
 *  bind mounts to resolve. Treat as deployment-layout invariants — if you
 *  ever change them, change the compose bind mounts in the same commit. */
export const WORKSPACES_ROOT = '/workspaces';
export const CACHES_ROOT = '/caches';

/** Default look-back window (days) for the Reports API when a request
 *  omits explicit `from`/`to` bounds. 90 days is a pragmatic default for
 *  a model/harness/repo performance gauge: long enough to accumulate a
 *  meaningful sample on a single-machine orchestrator, short enough that
 *  stale profile/model assignments don't dominate the aggregates. The
 *  report endpoints treat `from` as inclusive and `to` as exclusive. */
export const DEFAULT_REPORT_WINDOW_DAYS = 90;

/** Minimum number of distinct tasks a (repo, model, harness) combination must
 *  have in-window before the Create-Task performance gauge treats its rates as
 *  trustworthy. Below this the gauge still returns the raw numbers but flags
 *  `insufficient_data` so the UI shows an explicit low-confidence state rather
 *  than a misleading rate read off a tiny sample. */
export const GAUGE_MIN_SAMPLE = 5;
