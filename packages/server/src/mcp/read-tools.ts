/**
 * Read-only MCP tools: the orchestrator's telemetry, exposed to an agent.
 *
 * `create_task` (server.ts) lets an MCP client put work INTO the
 * orchestrator. These five tools let it read the results back out, so a
 * session can answer questions like "which model merges the most tasks in
 * this repo?", "how long does review take with harness X?", "why did
 * attempt 3 of task #42 fail?" without a browser, a database file, or a
 * Forgejo token.
 *
 *   - `list_tasks`     — the task table, filtered + paginated.
 *   - `get_task`       — one task with its attempts and event log.
 *   - `get_task_log`   — the tail of a task's agent progress log.
 *   - `query_attempts` — row-level attempt history (the export rows).
 *   - `get_report`     — the pre-aggregated report the UI's Reports page
 *                        renders, by kind.
 *
 * Every one is a thin wrapper: the queries are `db.ts`'s (`getTasks`,
 * `getReport*`, `iterateAttemptsExport`), the task-detail assembly is the
 * one `GET /api/tasks/:id` uses (`services/task-detail.ts`), the log lookup
 * is the archive-aware reader (`archive.ts`), and the `repos`/`from`/`to`
 * parsing is the reports routes' own `parseFilter`. Nothing here
 * re-implements a query, so an MCP answer can never disagree with the
 * dashboard or the REST API.
 *
 * Authorization: none here, exactly like the tools in server.ts. Bearer-JWT
 * validation happens in `routes/mcp.ts` before a tool callback runs, and a
 * valid MCP token grants the same surface a UI cookie session does. These
 * tools are strictly read-only and side-effect free.
 *
 * A note on input validation. The bounds and enumerations below are checked
 * inside the handlers rather than expressed as `z.enum()` / `.max()` in the
 * input schema ON PURPOSE: the SDK rejects a schema violation with its own
 * "Input validation error: …" text, and the tool contract these tools
 * document is that a bad argument comes back with the `Invalid input:` /
 * `Not found:` prefixes the other tools use. The allowed values are spelled
 * out in each `.describe()` so a client still knows what to send.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FastifyBaseLogger } from 'fastify';
import {
  TASK_STATUSES,
  type AttemptRole,
  type AttemptStatus,
  type DurationGroupBy,
  type DurationMetric,
  type ExportAttemptRow,
  type ExportAttemptsFilter,
  type HeatmapMetric,
  type LeaderboardGroupBy,
  type Repo,
  type Task,
  type TaskStatus,
} from '@orchestrator/shared';
import {
  getRepo,
  getRepos,
  getReportDurations,
  getReportFunnel,
  getReportHeatmap,
  getReportLeaderboard,
  getReportOverview,
  getReportReliability,
  getReportTimeseries,
  getTask,
  getTasks,
  iterateAttemptsExport,
} from '../db.js';
import { readTaskLogTail } from '../archive.js';
import { DEFAULT_REPORT_WINDOW_DAYS } from '../constants.js';
import type { ForgejoClient } from '../forgejo.js';
import { parseFilter } from '../routes/reports.js';
import { buildTaskDetail } from '../services/task-detail.js';

// ---------------------------------------------------------------------------
// Bounds — enforced server-side so a careless client can't pull the whole
// history through MCP in one call.
// ---------------------------------------------------------------------------

const LIST_TASKS_LIMIT_DEFAULT = 50;
const LIST_TASKS_LIMIT_MAX = 200;
const ATTEMPTS_LIMIT_DEFAULT = 200;
const ATTEMPTS_LIMIT_MAX = 2000;
const TAIL_LINES_DEFAULT = 500;
const TAIL_LINES_MAX = 5000;

/** Rows rendered into the text-content fallback before it degrades to a
 *  "…and N more" note. structuredContent always carries every row. */
const TEXT_PREVIEW_ROWS = 50;

export interface McpReadToolDeps {
  forgejo: ForgejoClient;
  log?: FastifyBaseLogger;
}

/** Used when the caller supplied no logger (unit tests, mostly). The only
 *  logging on these paths is the Docker-unavailable warning. */
const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as FastifyBaseLogger;

// ---------------------------------------------------------------------------
// Shared description fragments
// ---------------------------------------------------------------------------
//
// Written for an AI consumer, not a human skimming a reference: they say
// what the numbers mean, what null means, and which tool answers which
// question, because the model choosing a tool has nothing else to go on.

const UNITS_NOTE =
  'Units and conventions: every *_seconds field is wall-clock SECONDS; ' +
  'token counts (input_tokens, output_tokens) and num_turns/tool_calls are ' +
  'RAW counts and NO dollar cost is derived anywhere in the orchestrator — ' +
  'look up provider pricing yourself if you need money. null ALWAYS means ' +
  '"unknown / not reported" and NEVER 0: a null input_tokens is a harness ' +
  'that reported no usage, not a free run. Timestamps are ISO-8601 UTC.';

const ROUTING_NOTE =
  'Choosing a tool: use `get_report kind=leaderboard group_by=model` (or ' +
  'group_by=harness / group_by=repo) to COMPARE models, harnesses or repos ' +
  'on success rate and effort; `get_report kind=durations` for how long ' +
  'runs take, `kind=funnel` for where tasks drop out of the lifecycle, ' +
  '`kind=reliability` for the orchestrator\'s OWN failure incidents (as ' +
  'opposed to the agents\'), `kind=timeseries`/`kind=heatmap` for trends ' +
  'over time. Use `query_attempts` for row-level analysis when an ' +
  'aggregate is not enough (per-attempt tokens, verdicts, error messages). ' +
  'Use `list_tasks` to find a task, `get_task` for its full state plus ' +
  'attempts and events, and `get_task_log` to inspect WHY a specific ' +
  'attempt failed.';

const WINDOW_NOTE =
  `Date window: \`from\` (inclusive) / \`to\` (exclusive) are ISO-8601. ` +
  `Omitting them defaults to the last ${DEFAULT_REPORT_WINDOW_DAYS} days ` +
  `(DEFAULT_REPORT_WINDOW_DAYS) — the same default the Reports page uses. ` +
  `\`query_attempts\` deliberately does NOT default to a window: omit both ` +
  `bounds there and you get ALL history.`;

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

// A type alias, not an interface: the SDK's result type has an index
// signature, and only object-literal TYPES get an implicit one.
type ToolErrorResult = {
  content: { type: 'text'; text: string }[];
  isError: true;
};

/** Same two prefixes `create_task` maps its service errors onto, so a
 *  client can pattern-match one taxonomy across the whole tool surface. */
function invalidInput(message: string): ToolErrorResult {
  return { content: [{ type: 'text', text: `Invalid input: ${message}` }], isError: true };
}

function notFound(message: string): ToolErrorResult {
  return { content: [{ type: 'text', text: `Not found: ${message}` }], isError: true };
}

type Bounded =
  | { ok: true; value: number }
  | { ok: false; error: ToolErrorResult };

/** Clamp-by-rejection: an out-of-range bound is an error, not a silent
 *  clamp, so a client asking for 10000 rows learns it can't have them
 *  instead of silently analysing a truncated set. */
function bounded(
  raw: number | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number
): Bounded {
  if (raw === undefined) return { ok: true, value: fallback };
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    return {
      ok: false,
      error: invalidInput(`${name} must be an integer between ${min} and ${max} (got ${raw})`),
    };
  }
  return { ok: true, value: raw };
}

/** Validate an optional ISO-8601 bound. */
function isoBound(
  raw: string | undefined,
  name: string
): { ok: true; value: number | null } | { ok: false; error: ToolErrorResult } {
  if (raw === undefined) return { ok: true, value: null };
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      error: invalidInput(`${name} must be an ISO-8601 date/time (got "${raw}")`),
    };
  }
  return { ok: true, value: parsed };
}

/** Build the `repos`/`from`/`to` query object `parseFilter` expects. Going
 *  through the reports parser (rather than constructing a ReportFilter here)
 *  is what guarantees an MCP report and the matching REST report are
 *  computed over exactly the same window. */
function filterQuery(args: {
  repos?: number[];
  from?: string;
  to?: string;
}): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (args.repos && args.repos.length > 0) query.repos = args.repos.join(',');
  if (args.from !== undefined) query.from = args.from;
  if (args.to !== undefined) query.to = args.to;
  return query;
}

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------
//
// Loose objects: the declared keys are the ones a consumer can rely on, and
// the rest of the row rides along unvalidated. That keeps the schema from
// silently drifting out of sync with the DB row shape (which would surface
// to clients as an "Output validation error" rather than as data).

const ATTEMPT_SCHEMA = z.looseObject({
  id: z.number().int(),
  task_id: z.number().int(),
  attempt_number: z.number().int().nullable(),
  role: z.string(),
  status: z.string(),
  verdict: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  model_id: z.string().nullable(),
  harness_id: z.string().nullable(),
  num_turns: z.number().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  tool_calls: z.number().nullable(),
  changed_files: z.number().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  exit_code: z.number().nullable(),
  error_message: z.string().nullable(),
});

const TASK_EVENT_SCHEMA = z.looseObject({
  id: z.number().int(),
  task_id: z.number().int(),
  event_type: z.string(),
  message: z.string(),
  created_at: z.string(),
});

const REPO_REF_SCHEMA = z
  .object({
    id: z.number().int(),
    owner: z.string(),
    name: z.string(),
  })
  .nullable();

const TASK_ROW_SCHEMA = z.object({
  id: z.number().int(),
  issue_id: z.number().int(),
  issue_title: z.string().nullable(),
  repo: REPO_REF_SCHEMA,
  status: z.string(),
  attempt: z.number().int(),
  max_attempts: z.number().int(),
  pr_number: z.number().int().nullable(),
  agent_profile_id: z.string().nullable(),
  review_agent_profile_id: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

const TASK_VIEW_SCHEMA = z.looseObject({
  id: z.number().int(),
  issue_id: z.number().int(),
  issue_title: z.string(),
  repo_id: z.number().int(),
  repo: REPO_REF_SCHEMA,
  status: z.string(),
  runtime_status: z.string(),
  attempt: z.number().int(),
  max_attempts: z.number().int(),
  pr_number: z.number().int().nullable(),
  branch_name: z.string().nullable(),
  health: z.string(),
  blocked: z.boolean(),
  blocked_by: z.array(z.number().int()),
  agent_profile_id: z.string().nullable(),
  review_agent_profile_id: z.string().nullable(),
  effective_agent_profile_id: z.string().nullable(),
  effective_review_agent_profile_id: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

const EXPORT_ROW_SCHEMA = z.looseObject({
  attempt_id: z.number().int(),
  task_id: z.number().int(),
  role: z.string(),
  status: z.string(),
  duration_seconds: z.number().nullable(),
  model_id: z.string().nullable(),
  harness_id: z.string().nullable(),
  verdict: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  issue_id: z.number().int(),
  task_status: z.string(),
  repo_id: z.number().int(),
  repo_owner: z.string().nullable(),
  repo_name: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// get_report — kind → accepted options
// ---------------------------------------------------------------------------

const REPORT_KINDS = [
  'overview',
  'timeseries',
  'leaderboard',
  'durations',
  'funnel',
  'reliability',
  'heatmap',
] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

interface KindSpec {
  /** Accepts `bucket` (day|week, default day). */
  bucket: boolean;
  /** Allowed `group_by` values; null = the option is not accepted. When
   *  non-null the option is REQUIRED (mirrors the REST routes, which 400 on
   *  a missing groupBy). */
  groupBy: readonly string[] | null;
  /** Allowed `metric` values; null = not accepted. `fallback` present makes
   *  it optional, matching the REST route's default. */
  metric: { values: readonly string[]; fallback?: string } | null;
}

const REPORT_SPECS: Record<ReportKind, KindSpec> = {
  overview: { bucket: false, groupBy: null, metric: null },
  timeseries: { bucket: true, groupBy: null, metric: null },
  leaderboard: { bucket: false, groupBy: ['model', 'harness', 'repo'], metric: null },
  durations: {
    bucket: false,
    groupBy: ['model', 'harness'],
    metric: { values: ['implementation', 'review'] },
  },
  funnel: { bucket: false, groupBy: null, metric: null },
  reliability: { bucket: true, groupBy: null, metric: null },
  heatmap: {
    bucket: false,
    groupBy: null,
    metric: { values: ['created', 'merged'], fallback: 'created' },
  },
};

const KINDS_ACCEPTING_BUCKET = REPORT_KINDS.filter((k) => REPORT_SPECS[k].bucket);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the read-only analysis tools on an McpServer. Called from
 * `createMcpServer` — split out only to keep one file per concern (the
 * write surface vs. the read surface).
 */
export function registerReadTools(server: McpServer, deps: McpReadToolDeps): void {
  const log = deps.log ?? SILENT_LOG;

  // ─── list_tasks ──────────────────────────────────────────────────────
  server.registerTool(
    'list_tasks',
    {
      title: 'List orchestrator tasks',
      description:
        'Lists tasks the orchestrator knows about, newest first (descending ' +
        'task id, which is creation order), with the repo they belong to, ' +
        'their lifecycle status, how many implementation attempts they have ' +
        'consumed out of their cap, the PR number once one exists, and the ' +
        'per-task agent-profile overrides (null = inherited from the repo / ' +
        'global default, NOT "no profile"). `status` here is the STORED ' +
        'orchestrator status; `get_task` additionally overlays the ' +
        'Forgejo-derived status. Bounded on purpose: at most ' +
        `${LIST_TASKS_LIMIT_MAX} rows per call — page with \`offset\`, and ` +
        'read `total` to see how many rows match. Unlike the report tools ' +
        'this applies NO date window: it covers all history. ' +
        UNITS_NOTE +
        ' ' +
        ROUTING_NOTE,
      inputSchema: {
        repo_id: z
          .number()
          .int()
          .optional()
          .describe('Narrow to one orchestrator repo id (see list_repos).'),
        status: z
          .string()
          .optional()
          .describe(
            `Narrow to one task status. One of: ${TASK_STATUSES.join(', ')}.`
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `Max rows to return. Default ${LIST_TASKS_LIMIT_DEFAULT}, max ${LIST_TASKS_LIMIT_MAX}.`
          ),
        offset: z
          .number()
          .int()
          .optional()
          .describe('Rows to skip for pagination. Default 0.'),
      },
      outputSchema: {
        tasks: z.array(TASK_ROW_SCHEMA),
        /** Rows in THIS response. */
        count: z.number().int(),
        /** Rows matching the filter across all pages. */
        total: z.number().int(),
        limit: z.number().int(),
        offset: z.number().int(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (
        args.status !== undefined &&
        !TASK_STATUSES.includes(args.status as TaskStatus)
      ) {
        return invalidInput(
          `status must be one of: ${TASK_STATUSES.join(', ')} (got "${args.status}")`
        );
      }
      const limit = bounded(args.limit, 'limit', LIST_TASKS_LIMIT_DEFAULT, 1, LIST_TASKS_LIMIT_MAX);
      if (!limit.ok) return limit.error;
      const offset = bounded(args.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
      if (!offset.ok) return offset.error;
      if (args.repo_id !== undefined && !getRepo(args.repo_id)) {
        return notFound(`No repo with id ${args.repo_id}. Call list_repos for the registered ones.`);
      }

      // Reuses the same `getTasks` the REST list endpoint uses and pages in
      // memory: the response is what has to stay bounded, and pushing
      // LIMIT/OFFSET into SQL would mean a second, near-duplicate query for
      // a table the orchestrator already reads whole on every dashboard
      // refresh.
      const matching = getTasks({
        status: args.status as TaskStatus | undefined,
        repo_id: args.repo_id,
      });
      // getTasks orders by queue position (the scheduler's view); the
      // analysis view wants newest first.
      const ordered = [...matching].sort((a, b) => b.id - a.id);
      const page = ordered.slice(offset.value, offset.value + limit.value);
      const repos = new Map(getRepos().map((r) => [r.id, r]));
      const tasks = page.map((t) => taskRow(t, repos.get(t.repo_id)));

      return {
        content: [
          {
            type: 'text',
            text:
              tasks.length === 0
                ? 'No tasks match that filter.'
                : [
                    ...tasks.map(formatTaskLine),
                    `(${tasks.length} of ${ordered.length} matching task(s), offset ${offset.value})`,
                  ].join('\n'),
          },
        ],
        structuredContent: {
          tasks,
          count: tasks.length,
          total: ordered.length,
          limit: limit.value,
          offset: offset.value,
        },
      };
    }
  );

  // ─── get_task ────────────────────────────────────────────────────────
  server.registerTool(
    'get_task',
    {
      title: 'Get one task with its attempts and events',
      description:
        'Everything the orchestrator knows about one task: the enriched ' +
        'task object (identical to what the dashboard renders — same code ' +
        'path as GET /api/tasks/:id), every attempt ever run for it, the ' +
        'task event log, and Forgejo deep links. `task.status` is the ' +
        'Forgejo-DERIVED status (what a human sees; e.g. a task whose issue ' +
        'was closed by hand reads as cancelled) while ' +
        '`task.runtime_status` is the stored orchestrator state — compare ' +
        'them when a task looks stuck. Each attempt carries role ' +
        '(develop|review), status, verdict, the model/harness snapshot ' +
        'taken at launch, per-run usage, and `error_message`/`exit_code` ' +
        'for a failure. ' +
        UNITS_NOTE +
        ' Attempts are ordered oldest first, so the last element is the ' +
        'most recent run. To read the agent output itself, call ' +
        '`get_task_log`. ' +
        ROUTING_NOTE,
      inputSchema: {
        task_id: z
          .number()
          .int()
          .describe('Orchestrator task id (NOT the Forgejo issue number — see list_tasks).'),
      },
      outputSchema: {
        task: TASK_VIEW_SCHEMA,
        attempts: z.array(ATTEMPT_SCHEMA),
        events: z.array(TASK_EVENT_SCHEMA),
        forgejo_links: z.record(z.string(), z.string()),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const task = getTask(args.task_id);
      if (!task) return notFound(`No task with id ${args.task_id}`);

      const detail = await buildTaskDetail(task, { forgejo: deps.forgejo, log });
      const { attempts, events, forgejo_links, ...view } = detail;

      const summary = [
        `Task #${view.id} — ${view.repo ? `${view.repo.owner}/${view.repo.name}` : 'repo?'} ` +
          `issue #${view.issue_id} "${view.issue_title}"`,
        `status: ${view.status} (stored: ${view.runtime_status}), health: ${view.health}, ` +
          `attempt ${view.attempt}/${view.max_attempts}` +
          (view.pr_number ? `, PR #${view.pr_number}` : ''),
        `attempts recorded: ${attempts.length}, events: ${events.length}`,
        ...attempts.map(formatAttemptLine),
      ].join('\n');

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { task: view, attempts, events, forgejo_links },
      };
    }
  );

  // ─── get_task_log ────────────────────────────────────────────────────
  server.registerTool(
    'get_task_log',
    {
      title: "Read the tail of a task's agent log",
      description:
        "The task's `progress.log` — the raw output the agent container " +
        'produced while working on it. This is where you find out WHY an ' +
        'attempt failed (harness errors, test output, timeouts). Read from ' +
        'the live workspace while it exists and transparently from the ' +
        'gzipped archive afterwards, so old tasks stay inspectable long ' +
        'after their workspace was swept. One log per task, shared by all ' +
        "of its attempts, so a retried task's log covers every run. Only " +
        `the LAST \`tail_lines\` lines are returned (default ` +
        `${TAIL_LINES_DEFAULT}, max ${TAIL_LINES_MAX}); \`total_lines\` and ` +
        '`truncated` tell you whether there is more above what you got — ' +
        'if `truncated` is true and you need earlier context, call again ' +
        'with a larger `tail_lines`. Failures are usually reported at the ' +
        'END of the log, which is why the tail is what you get. ' +
        ROUTING_NOTE,
      inputSchema: {
        task_id: z.number().int().describe('Orchestrator task id (see list_tasks).'),
        tail_lines: z
          .number()
          .int()
          .optional()
          .describe(
            `How many trailing lines to return. Default ${TAIL_LINES_DEFAULT}, max ${TAIL_LINES_MAX}.`
          ),
      },
      outputSchema: {
        task_id: z.number().int(),
        /** The returned lines joined by "\n". */
        log: z.string(),
        /** Lines in the WHOLE log, not just the returned tail. */
        total_lines: z.number().int(),
        returned_lines: z.number().int(),
        /** True when earlier lines were dropped to honour tail_lines. */
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const task = getTask(args.task_id);
      if (!task) return notFound(`No task with id ${args.task_id}`);

      const tail = bounded(args.tail_lines, 'tail_lines', TAIL_LINES_DEFAULT, 1, TAIL_LINES_MAX);
      if (!tail.ok) return tail.error;

      let result;
      try {
        result = await readTaskLogTail(task, tail.value);
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not read the log for task ${args.task_id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ],
          isError: true as const,
        };
      }
      if (!result) {
        return notFound(
          `No log for task ${args.task_id} — neither its workspace nor its archive holds a progress.log ` +
            '(the task may never have launched an agent).'
        );
      }

      const text = result.lines.join('\n');
      const header =
        `progress.log for task #${task.id} (issue #${task.issue_id}) — ` +
        `${result.lines.length} of ${result.total_lines} line(s)` +
        (result.truncated ? `, earlier lines truncated` : '') +
        '\n';
      return {
        content: [{ type: 'text', text: header + text }],
        structuredContent: {
          task_id: task.id,
          log: text,
          total_lines: result.total_lines,
          returned_lines: result.lines.length,
          truncated: result.truncated,
        },
      };
    }
  );

  // ─── query_attempts ──────────────────────────────────────────────────
  server.registerTool(
    'query_attempts',
    {
      title: 'Query the raw attempt history',
      description:
        'Row-level attempt history: one flat, denormalised record per agent ' +
        'run, joined with its task, repo and model. This is the raw data ' +
        'behind every report — reach for it when an aggregate is not ' +
        'enough (e.g. "show me every failed review attempt for model X ' +
        'with its error_message", "how many turns did the runs that ' +
        'eventually merged take?"). Each row carries role (develop|review), ' +
        'status (running|completed|failed|timeout), verdict, ' +
        'duration_seconds, the model/harness snapshot taken at launch time ' +
        '(NOT the profile\'s current model — attempts are immutable ' +
        'history), per-run usage, PR churn, and the parent task\'s status ' +
        'and timestamps. ' +
        UNITS_NOTE +
        ' IMPORTANT — no default window: omit `from`/`to` and you get ALL ' +
        'history (unlike `get_report`, which defaults to the last ' +
        `${DEFAULT_REPORT_WINDOW_DAYS} days). Results are ordered by ` +
        `attempt_id ascending and capped at ${ATTEMPTS_LIMIT_MAX} rows per ` +
        'call; page with `offset`. For a full-history bulk pull (a ' +
        'notebook, a spreadsheet, an offline analysis) do NOT page through ' +
        'this tool — the REST endpoint `GET ' +
        '/api/export/attempts?format=jsonl` streams the same rows unpaged ' +
        'and is the right tool for that job. ' +
        ROUTING_NOTE,
      inputSchema: {
        repos: z
          .array(z.number().int())
          .optional()
          .describe('Orchestrator repo ids to include. Omit for all repos.'),
        from: z
          .string()
          .optional()
          .describe(
            'Inclusive ISO-8601 lower bound on the attempt\'s start time ' +
              '(falling back to its task\'s creation for an attempt that ' +
              'never started). Omit for no lower bound.'
          ),
        to: z
          .string()
          .optional()
          .describe('Exclusive ISO-8601 upper bound. Omit for no upper bound.'),
        model: z
          .string()
          .optional()
          .describe('Exact match on the attempt\'s launch-time model_id (e.g. "claude-sonnet-4-6").'),
        harness: z
          .string()
          .optional()
          .describe('Exact match on the attempt\'s launch-time harness_id (e.g. "claude-sdk").'),
        role: z
          .string()
          .optional()
          .describe('Narrow to one attempt role: develop or review.'),
        status: z
          .string()
          .optional()
          .describe('Narrow to one attempt status: running, completed, failed, or timeout.'),
        include_feedback: z
          .boolean()
          .optional()
          .describe(
            'Include each review attempt\'s full feedback blob. Off by ' +
              'default because it is large; turn it on only when you need ' +
              'to read the reviewer\'s actual words.'
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `Max rows to return. Default ${ATTEMPTS_LIMIT_DEFAULT}, max ${ATTEMPTS_LIMIT_MAX}.`
          ),
        offset: z
          .number()
          .int()
          .optional()
          .describe('Rows to skip for pagination. Default 0.'),
      },
      outputSchema: {
        rows: z.array(EXPORT_ROW_SCHEMA),
        /** Rows in THIS response; equal to `limit` means there are probably more. */
        count: z.number().int(),
        limit: z.number().int(),
        offset: z.number().int(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const ROLES: AttemptRole[] = ['develop', 'review'];
      const STATUSES: AttemptStatus[] = ['running', 'completed', 'failed', 'timeout'];

      if (args.role !== undefined && !ROLES.includes(args.role as AttemptRole)) {
        return invalidInput(`role must be one of: ${ROLES.join(', ')} (got "${args.role}")`);
      }
      if (args.status !== undefined && !STATUSES.includes(args.status as AttemptStatus)) {
        return invalidInput(`status must be one of: ${STATUSES.join(', ')} (got "${args.status}")`);
      }
      const from = isoBound(args.from, 'from');
      if (!from.ok) return from.error;
      const to = isoBound(args.to, 'to');
      if (!to.ok) return to.error;
      if (from.value !== null && to.value !== null && from.value > to.value) {
        return invalidInput('from must not be later than to');
      }
      const limit = bounded(args.limit, 'limit', ATTEMPTS_LIMIT_DEFAULT, 1, ATTEMPTS_LIMIT_MAX);
      if (!limit.ok) return limit.error;
      const offset = bounded(args.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
      if (!offset.ok) return offset.error;

      // Same construction GET /api/export/attempts uses: run the shared
      // reports parser, then drop the bounds the caller never supplied so
      // the export stays open-ended instead of inheriting the reports
      // default window.
      const base = parseFilter(filterQuery(args));
      const filter: ExportAttemptsFilter = {
        repos: base.repos,
        from: from.value === null ? null : base.from,
        to: to.value === null ? null : base.to,
        model: args.model?.trim() ? args.model.trim() : null,
        harness: args.harness?.trim() ? args.harness.trim() : null,
        role: (args.role as AttemptRole | undefined) ?? null,
        status: (args.status as AttemptStatus | undefined) ?? null,
      };

      // Pull one page off the generator rather than materialising the whole
      // history and slicing it — the point of the cap is bounded memory and
      // a bounded response.
      const rows: ExportAttemptRow[] = [];
      let skipped = 0;
      for (const row of iterateAttemptsExport(filter, {
        includeFeedback: args.include_feedback === true,
      })) {
        if (skipped < offset.value) {
          skipped += 1;
          continue;
        }
        rows.push(row);
        if (rows.length >= limit.value) break;
      }

      const preview = rows.slice(0, TEXT_PREVIEW_ROWS).map(formatExportRowLine);
      if (rows.length > TEXT_PREVIEW_ROWS) {
        preview.push(
          `… and ${rows.length - TEXT_PREVIEW_ROWS} more row(s) — read structuredContent.rows for the full set.`
        );
      }
      return {
        content: [
          {
            type: 'text',
            text:
              rows.length === 0
                ? 'No attempts match that filter.'
                : preview.join('\n'),
          },
        ],
        structuredContent: {
          rows,
          count: rows.length,
          limit: limit.value,
          offset: offset.value,
        },
      };
    }
  );

  // ─── get_report ──────────────────────────────────────────────────────
  server.registerTool(
    'get_report',
    {
      title: 'Get an aggregated orchestrator report',
      description:
        'The pre-aggregated reports the orchestrator\'s Reports page ' +
        'renders, computed in SQL over the task/attempt/event history. ' +
        'Pick one with `kind`:\n' +
        '- `overview`: KPI roll-up for the window (task counts by status, ' +
        'merge rate, attempt/duration averages).\n' +
        '- `timeseries`: tasks created vs merged per bucket (`bucket`=day ' +
        'or week) — trend over time.\n' +
        '- `leaderboard`: per-group success/effort stats ' +
        '(`group_by`=model|harness|repo). THE tool for "which model is ' +
        'doing best".\n' +
        '- `durations`: p50/p90/p99 + min/max/avg run duration per group ' +
        '(`group_by`=model|harness, `metric`=implementation|review).\n' +
        '- `funnel`: created → preparing → in-progress → in-review → merged ' +
        'conversion, i.e. where tasks fall out.\n' +
        '- `reliability`: the ORCHESTRATOR\'s own operational incidents ' +
        '(prep failures, orphan recoveries, git outages) with a per-repo ' +
        'breakdown and a `bucket`=day|week series — this is about the ' +
        'platform, not about agent quality.\n' +
        '- `heatmap`: hour-of-day × day-of-week activity ' +
        '(`metric`=created|merged).\n' +
        'Cohort semantics: unless a kind says otherwise, a report covers ' +
        'the tasks CREATED inside the window. ' +
        WINDOW_NOTE +
        ' ' +
        UNITS_NOTE +
        ' Passing an option a kind does not accept (e.g. `group_by` with ' +
        '`kind=overview`) is an error rather than being ignored. ' +
        ROUTING_NOTE,
      inputSchema: {
        kind: z
          .string()
          .describe(`Which report. One of: ${REPORT_KINDS.join(', ')}.`),
        repos: z
          .array(z.number().int())
          .optional()
          .describe('Orchestrator repo ids to scope the report to. Omit for all repos.'),
        from: z
          .string()
          .optional()
          .describe(
            `Inclusive ISO-8601 lower bound. Omitted = ${DEFAULT_REPORT_WINDOW_DAYS} days before \`to\`.`
          ),
        to: z
          .string()
          .optional()
          .describe('Exclusive ISO-8601 upper bound. Omitted = now.'),
        bucket: z
          .string()
          .optional()
          .describe(
            `Time bucket for kind=${KINDS_ACCEPTING_BUCKET.join(' / ')}: day (default) or week.`
          ),
        group_by: z
          .string()
          .optional()
          .describe(
            'Grouping key. Required for kind=leaderboard (model|harness|repo) ' +
              'and kind=durations (model|harness); rejected for other kinds.'
          ),
        metric: z
          .string()
          .optional()
          .describe(
            'Required for kind=durations (implementation|review); optional ' +
              'for kind=heatmap (created|merged, default created); rejected ' +
              'for other kinds.'
          ),
      },
      outputSchema: {
        kind: z.string(),
        /** The report object, exactly as the matching /api/reports/* route
         *  returns it — shape depends on `kind`. */
        report: z.looseObject({}),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (!REPORT_KINDS.includes(args.kind as ReportKind)) {
        return invalidInput(
          `kind must be one of: ${REPORT_KINDS.join(', ')} (got "${args.kind}")`
        );
      }
      const kind = args.kind as ReportKind;
      const spec = REPORT_SPECS[kind];

      // -- bucket --
      if (args.bucket !== undefined && !spec.bucket) {
        return invalidInput(
          `bucket is not accepted for kind=${kind} (only ${KINDS_ACCEPTING_BUCKET.join(', ')} take a bucket)`
        );
      }
      if (args.bucket !== undefined && args.bucket !== 'day' && args.bucket !== 'week') {
        return invalidInput(`bucket must be one of: day, week (got "${args.bucket}")`);
      }
      const bucket: 'day' | 'week' = args.bucket === 'week' ? 'week' : 'day';

      // -- group_by --
      if (args.group_by !== undefined && spec.groupBy === null) {
        return invalidInput(`group_by is not accepted for kind=${kind}`);
      }
      if (spec.groupBy !== null) {
        if (args.group_by === undefined) {
          return invalidInput(
            `group_by is required for kind=${kind} and must be one of: ${spec.groupBy.join(', ')}`
          );
        }
        if (!spec.groupBy.includes(args.group_by)) {
          return invalidInput(
            `group_by must be one of: ${spec.groupBy.join(', ')} for kind=${kind} (got "${args.group_by}")`
          );
        }
      }

      // -- metric --
      if (args.metric !== undefined && spec.metric === null) {
        return invalidInput(`metric is not accepted for kind=${kind}`);
      }
      if (spec.metric !== null) {
        if (args.metric === undefined && spec.metric.fallback === undefined) {
          return invalidInput(
            `metric is required for kind=${kind} and must be one of: ${spec.metric.values.join(', ')}`
          );
        }
        if (args.metric !== undefined && !spec.metric.values.includes(args.metric)) {
          return invalidInput(
            `metric must be one of: ${spec.metric.values.join(', ')} for kind=${kind} (got "${args.metric}")`
          );
        }
      }
      const metric = args.metric ?? spec.metric?.fallback;

      // -- window --
      const from = isoBound(args.from, 'from');
      if (!from.ok) return from.error;
      const to = isoBound(args.to, 'to');
      if (!to.ok) return to.error;
      if (from.value !== null && to.value !== null && from.value > to.value) {
        return invalidInput('from must not be later than to');
      }
      const filter = parseFilter(filterQuery(args));

      let report: unknown;
      switch (kind) {
        case 'overview':
          report = getReportOverview(filter);
          break;
        case 'timeseries':
          report = getReportTimeseries(filter, bucket);
          break;
        case 'leaderboard':
          report = getReportLeaderboard(filter, args.group_by as LeaderboardGroupBy);
          break;
        case 'durations':
          report = getReportDurations(
            filter,
            args.group_by as DurationGroupBy,
            metric as DurationMetric
          );
          break;
        case 'funnel':
          report = getReportFunnel(filter);
          break;
        case 'reliability':
          report = getReportReliability(filter, bucket);
          break;
        case 'heatmap':
          report = getReportHeatmap(filter, metric as HeatmapMetric);
          break;
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `${kind} report for ${filter.from} → ${filter.to} ` +
              `(repos: ${filter.repos ? filter.repos.join(', ') : 'all'})\n` +
              JSON.stringify(report, null, 2),
          },
        ],
        structuredContent: { kind, report },
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Row shaping + text-fallback formatting
// ---------------------------------------------------------------------------

interface TaskRow {
  id: number;
  issue_id: number;
  issue_title: string | null;
  repo: { id: number; owner: string; name: string } | null;
  status: string;
  attempt: number;
  max_attempts: number;
  pr_number: number | null;
  agent_profile_id: string | null;
  review_agent_profile_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** The `list_tasks` projection of a task row: the fields an analysis needs,
 *  none of the scheduler bookkeeping (backoff levels, container ids). */
function taskRow(task: Task, repo: Repo | undefined): TaskRow {
  return {
    id: task.id,
    issue_id: task.issue_id,
    issue_title: task.issue_title,
    repo: repo ? { id: repo.id, owner: repo.owner, name: repo.name } : null,
    status: task.status,
    attempt: task.attempt,
    max_attempts: task.max_attempts,
    pr_number: task.pr_number,
    agent_profile_id: task.agent_profile_id,
    review_agent_profile_id: task.review_agent_profile_id,
    created_at: task.created_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
  };
}

function formatTaskLine(t: TaskRow): string {
  const repo = t.repo ? `${t.repo.owner}/${t.repo.name}` : '(repo?)';
  return (
    `#${t.id} ${repo} issue #${t.issue_id} "${t.issue_title ?? ''}" — ` +
    `${t.status}, attempt ${t.attempt}/${t.max_attempts}` +
    (t.pr_number ? `, PR #${t.pr_number}` : '')
  );
}

function formatAttemptLine(a: {
  id: number;
  attempt_number: number | null;
  role: string;
  status: string;
  verdict: string | null;
  model_id: string | null;
  harness_id: string | null;
  error_message: string | null;
}): string {
  return (
    `  attempt ${a.attempt_number ?? '?'} [${a.role}] ${a.status}` +
    (a.verdict ? ` verdict=${a.verdict}` : '') +
    ` (${a.harness_id ?? '?'}/${a.model_id ?? '?'})` +
    (a.error_message ? ` — ${a.error_message}` : '')
  );
}

function formatExportRowLine(r: ExportAttemptRow): string {
  const repo = r.repo_owner && r.repo_name ? `${r.repo_owner}/${r.repo_name}` : '(repo?)';
  return (
    `attempt ${r.attempt_id} task #${r.task_id} ${repo} issue #${r.issue_id} ` +
    `[${r.role}] ${r.status}` +
    (r.verdict ? ` verdict=${r.verdict}` : '') +
    ` model=${r.model_id ?? '?'} harness=${r.harness_id ?? '?'}` +
    ` duration=${r.duration_seconds ?? '?'}s` +
    ` tokens=${r.input_tokens ?? '?'}/${r.output_tokens ?? '?'}`
  );
}
