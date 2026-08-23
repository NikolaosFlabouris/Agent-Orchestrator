/**
 * MCP (Model Context Protocol) server module.
 *
 * Builds an `McpServer` instance that exposes the orchestrator's
 * task-management surface as tools an MCP client (Claude Code, the
 * create-task-forgejo plugin's skill, …) can invoke.
 *
 * The write + configuration surface, registered here:
 *
 *   - `list_repos`           — registered repos + their effective agent
 *                              profiles for both workflow stages
 *                              (implementation and review).
 *   - `list_agent_profiles`  — every configured agent profile with the
 *                              joined model/provider stats.
 *   - `create_task`          — create a Forgejo issue + queue an
 *                              orchestrator task, with optional
 *                              per-task overrides (agent_profile_id,
 *                              review_agent_profile_id, max_attempts,
 *                              human_merge, human_review).
 *
 * The read-only telemetry surface — `list_tasks`, `get_task`,
 * `get_task_log`, `query_attempts`, `get_report` — is registered by
 * `registerReadTools` (`./read-tools.ts`), which is where an agent gets
 * the data to analyse LLM performance and the orchestrator's own
 * reliability. Same file split as the code they wrap: writes go through
 * `services/task-intake.ts`, reads through `db.ts` / the reports
 * aggregation / the archive-aware log reader.
 *
 * `create_task` is a thin wrapper over the shared task-intake service
 * (`../services/task-intake.ts`) — the same service `POST /api/tasks`
 * calls — so the MCP path and the REST path cannot diverge on
 * validation, label semantics, override handling, broadcast, or the
 * scheduler kick.
 *
 * No transport wiring here; this module returns a configured McpServer
 * that the Fastify route plugin (`../routes/mcp.ts`) connects to a
 * StreamableHTTPServerTransport. That separation keeps the tools
 * unit-testable without spinning a transport.
 *
 * No authorization here either: bearer-JWT validation runs in
 * `../routes/mcp.ts` (the OAuth 2.1 Resource Server layer), before the
 * SDK transport ever invokes a tool callback. By the time control
 * reaches one of the registered tools below, the caller is a verified
 * Forgejo-authenticated user; the tools themselves treat the bar as
 * "valid MCP token == same surface as a UI cookie session" and don't
 * do further per-tool RBAC.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getAgentProfilesWithStats } from '../db.js';
import type { ForgejoClient } from '../forgejo.js';
import type { Scheduler } from '../scheduler.js';
import type { FastifyBaseLogger } from 'fastify';
import {
  createTask,
  listReposWithEffectiveProfile,
  type TaskIntakeError,
} from '../services/task-intake.js';
import { registerReadTools } from './read-tools.js';

/** Reported to the client during the MCP initialization handshake. The
 *  version is intentionally independent of the orchestrator's package
 *  version — it's the *MCP contract* version, bumped when tool shapes
 *  change in client-visible ways. */
const MCP_SERVER_INFO = {
  name: 'agent-orchestrator',
  // 0.3.0: read-only telemetry tools (list_tasks, get_task, get_task_log,
  // query_attempts, get_report). Additive — the three original tools are
  // untouched, so old clients keep working.
  // 0.2.0: per-stage agent profiles — create_task gained the optional
  // review_agent_profile_id override; list_repos gained the effective
  // review-profile fields. Both additive (old clients keep working).
  version: '0.3.0',
} as const;

/** Joined-through profile info shape shared by the implementation and
 *  review effective-profile fields on `list_repos`. */
const EFFECTIVE_PROFILE_SCHEMA = z
  .object({
    id: z.string(),
    display_name: z.string(),
    harness_id: z.string(),
    timeout_minutes: z.number().int(),
    model_id: z.string().nullable(),
    provider_id: z.string().nullable(),
    provider_display_name: z.string().nullable(),
  })
  .nullable();

/** Dependencies the `create_task` tool needs to act. Match
 *  `IntakeDeps` so callers can hand the same object to both. */
export interface McpServerDeps {
  forgejo: ForgejoClient;
  scheduler: Pick<Scheduler, 'triggerTick'>;
  log?: FastifyBaseLogger;
}

/**
 * Build a fresh McpServer with every tool registered. The caller is
 * responsible for connecting it to a transport.
 *
 * Note on the McpServer lifecycle: an instance can only be connected
 * to one transport at a time. The transport-mounting plugin
 * (`routes/mcp.ts`) creates a new transport per HTTP session and
 * dedicates one McpServer instance to it, which is the recommended
 * pattern for the stateful Streamable HTTP mode.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });

  // ─── list_repos ────────────────────────────────────────────────────
  server.registerTool(
    'list_repos',
    {
      title: 'List registered repositories',
      description:
        'Returns every repository registered with the orchestrator, ' +
        'along with the agent profiles that will run a new task against ' +
        'it by default — one for the implementation (develop) stage and ' +
        'one for the review stage (the review profile falls back to the ' +
        'implementation profile when not configured). Use this to pick a ' +
        '`repo_id` for `create_task` and to surface the effective ' +
        'profile/model/provider per stage to the human.',
      // No input schema — the tool takes no arguments.
      outputSchema: {
        repos: z.array(
          z.object({
            id: z.number().int(),
            owner: z.string(),
            name: z.string(),
            base_branch: z.string(),
            repo_agent_profile_id: z.string().nullable(),
            global_default_agent_profile_id: z.string().nullable(),
            effective_agent_profile_id: z.string().nullable(),
            agent_profile_source: z.enum(['repo', 'global', 'none']),
            effective_profile: EFFECTIVE_PROFILE_SCHEMA,
            repo_review_agent_profile_id: z.string().nullable(),
            effective_review_agent_profile_id: z.string().nullable(),
            review_agent_profile_source: z.enum([
              'repo',
              'global',
              'implementation',
              'none',
            ]),
            effective_review_profile: EFFECTIVE_PROFILE_SCHEMA,
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const repos = listReposWithEffectiveProfile();
      return {
        // Text fallback for clients that don't read structuredContent.
        content: [
          {
            type: 'text',
            text: repos.length === 0
              ? 'No repositories are registered. Add one via Settings → Repositories in the orchestrator UI.'
              : repos.map(formatRepoLine).join('\n'),
          },
        ],
        structuredContent: { repos },
      };
    }
  );

  // ─── list_agent_profiles ───────────────────────────────────────────
  server.registerTool(
    'list_agent_profiles',
    {
      title: 'List configured agent profiles',
      description:
        'Returns every agent profile (harness + model + provider + timeout) ' +
        'configured in the orchestrator. Use this to surface valid values ' +
        'for the `agent_profile_id` and `review_agent_profile_id` ' +
        'overrides on `create_task`.',
      outputSchema: {
        profiles: z.array(
          z.object({
            id: z.string(),
            display_name: z.string(),
            harness_id: z.string(),
            model_pk: z.number().int(),
            timeout_minutes: z.number().int(),
            // The joined model/provider/usage stats from
            // getAgentProfilesWithStats. Typed loosely (string|null) here so
            // the schema doesn't drift from the DB helper's shape — the
            // helper is the source of truth for the JSON.
            provider_id: z.string().nullable(),
            model_id: z.string().nullable(),
            repos_using: z.number().int(),
            tasks_using: z.number().int(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const profiles = getAgentProfilesWithStats();
      // Strip config_json — operator-tunable harness knobs are an
      // implementation detail and not useful to the MCP client surfacing
      // a chooser. Keep the response tight.
      const stripped = profiles.map(({ config_json: _omit, ...rest }) => rest);
      return {
        content: [
          {
            type: 'text',
            text: stripped.length === 0
              ? 'No agent profiles configured.'
              : stripped.map(formatProfileLine).join('\n'),
          },
        ],
        structuredContent: { profiles: stripped },
      };
    }
  );

  // ─── create_task ───────────────────────────────────────────────────
  // Inputs are individually validated by zod (the SDK pre-validates
  // before calling us); the task-intake service then re-validates the
  // semantic invariants (repo exists, agent_profile_id resolves, …)
  // and runs the actual side effects. Defense-in-depth: an MCP client
  // can't slip a malformed shape past us, and a hand-rolled HTTP
  // caller that bypasses the SDK still hits the same service-level
  // checks the route path uses.
  server.registerTool(
    'create_task',
    {
      title: 'Create and queue a new task',
      description:
        'Create a Forgejo issue (with the supplied title and Markdown ' +
        'description), apply the orchestrator\'s status/queued label ' +
        '(plus optional human-merge / human-review override labels), ' +
        'insert the matching task row with any overrides applied ' +
        'atomically, broadcast on the dashboard websocket, and trigger ' +
        'the scheduler. The issue description IS the agent prompt — ' +
        'make it specific, with clear acceptance criteria. Use the ' +
        'dependencies parameter to declare issues this task must wait ' +
        'for: the task stays queued until each listed issue is closed ' +
        '(the orchestrator writes them into the issue body as a ' +
        '"## Dependencies" checklist, which humans can edit on Forgejo).',
      inputSchema: {
        repo_id: z
          .number()
          .int()
          .positive()
          .describe('Orchestrator repo id (see list_repos).'),
        title: z
          .string()
          .min(1)
          .describe('Issue title; also used as PR title and squash-commit subject.'),
        description: z
          .string()
          .min(1)
          .describe(
            'Markdown body of the Forgejo issue. This is what the agent ' +
              'sees as its task prompt — include description, ' +
              'requirements, relevant files, and testable acceptance ' +
              'criteria.'
          ),
        dependencies: z
          .array(z.number().int().positive())
          .optional()
          .describe(
            'Issue numbers (same repo) this task depends on. The task is ' +
              'not scheduled until every listed issue is closed. Each ' +
              'number is validated to exist; already-closed issues are ' +
              'allowed (immediately satisfied). Written into the issue ' +
              'body as a "## Dependencies" checklist — a human can later ' +
              'remove a line or tick its box on Forgejo to override.'
          ),
        agent_profile_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Optional per-task profile override for the implementation ' +
              "(develop) stage. null / omitted = inherit from the repo's " +
              'default, which itself inherits from the global default.'
          ),
        review_agent_profile_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Optional per-task profile override for the review stage. ' +
              "null / omitted = inherit from the repo's review default, " +
              'then the global review default, finally falling back to ' +
              'the implementation profile (review and implementation run ' +
              'with the same profile unless one of those is set).'
          ),
        max_attempts: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Optional per-task dev-attempt cap. Omitted = use the system ' +
              'default (DEFAULT_MAX_ATTEMPTS = 7).'
          ),
        human_merge: z
          .boolean()
          .optional()
          .describe(
            'When true, applies the human-merge label so the orchestrator ' +
              'leaves the PR open for a human to merge after automated ' +
              'review approves.'
          ),
        human_review: z
          .boolean()
          .optional()
          .describe(
            'When true, applies the human-review label so the dev agent ' +
              'still opens a PR but the automated review agent is skipped ' +
              'and the task ends in awaiting-human-review.'
          ),
      },
      outputSchema: {
        task: z.object({
          id: z.number().int(),
          issue_id: z.number().int(),
          issue_title: z.string().nullable(),
          repo_id: z.number().int(),
          status: z.string(),
          queue_position: z.number().int().nullable(),
          attempt: z.number().int(),
          max_attempts: z.number().int(),
          agent_profile_id: z.string().nullable(),
          review_agent_profile_id: z.string().nullable(),
        }),
        issue: z.object({
          number: z.number().int(),
          title: z.string(),
        }),
      },
      annotations: {
        // `destructiveHint: false` is honest: creating a task doesn't
        // destroy anything. `idempotentHint: false` is also honest:
        // calling twice creates two issues + two tasks.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true, // touches Forgejo over the network
      },
    },
    async (args) => {
      const result = await createTask(args, deps);
      if (!result.ok) {
        return toolError(result.error);
      }
      const { task, issue } = result.value;
      const summary =
        `Created task #${task.id} for issue #${issue.number} ` +
        `("${issue.title}"). Status: queued, ` +
        `queue position: ${task.queue_position ?? '?'}, ` +
        `attempts allowed: ${task.max_attempts}, ` +
        `agent profile: ${task.agent_profile_id ?? '(inherit)'}, ` +
        `review profile: ${task.review_agent_profile_id ?? '(inherit)'}.`;
      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: {
          task: {
            id: task.id,
            issue_id: task.issue_id,
            issue_title: task.issue_title,
            repo_id: task.repo_id,
            status: task.status,
            queue_position: task.queue_position,
            attempt: task.attempt,
            max_attempts: task.max_attempts,
            agent_profile_id: task.agent_profile_id,
            review_agent_profile_id: task.review_agent_profile_id,
          },
          issue: { number: issue.number, title: issue.title },
        },
      };
    }
  );

  // ─── read-only telemetry tools ─────────────────────────────────────
  // list_tasks / get_task / get_task_log / query_attempts / get_report.
  // Same authorization posture as the tools above: the bearer check in
  // routes/mcp.ts has already run, and none of them do per-user scoping
  // (create_task doesn't either).
  registerReadTools(server, deps);

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One-line repo summary for the text content block. Keep it terse so an
 *  agent can scan a list of 20 repos without consuming much context. */
function formatRepoLine(
  r: ReturnType<typeof listReposWithEffectiveProfile>[number]
): string {
  const profile = r.effective_profile
    ? `${r.effective_profile.display_name} ` +
      `(${r.effective_profile.harness_id} / ` +
      `${r.effective_profile.provider_id ?? '?'}/${r.effective_profile.model_id ?? '?'})`
    : r.effective_agent_profile_id ?? '(no profile)';
  const sourceTag =
    r.agent_profile_source === 'repo'
      ? ' [repo override]'
      : r.agent_profile_source === 'global'
        ? ' [global default]'
        : ' [none]';
  // Only surface the review profile when it differs from the
  // implementation one — the common single-profile case stays terse.
  const reviewTag =
    r.effective_review_agent_profile_id !== null &&
    r.effective_review_agent_profile_id !== r.effective_agent_profile_id
      ? `, review → ${
          r.effective_review_profile?.display_name ??
          r.effective_review_agent_profile_id
        }`
      : '';
  return `#${r.id} ${r.owner}/${r.name} (base: ${r.base_branch}) → ${profile}${sourceTag}${reviewTag}`;
}

/** One-line agent-profile summary for the text content block. */
function formatProfileLine(p: {
  id: string;
  display_name: string;
  harness_id: string;
  timeout_minutes: number;
  provider_id: string | null;
  model_id: string | null;
}): string {
  return (
    `${p.id}: ${p.display_name} ` +
    `(${p.harness_id} / ${p.provider_id ?? '?'}/${p.model_id ?? '?'}, ` +
    `timeout=${p.timeout_minutes}m)`
  );
}

/** Map a task-intake tagged error onto an MCP tool error result. The
 *  MCP wire format for tool errors is `isError: true` with a text
 *  content block — the SDK does not surface our `kind` taxonomy
 *  separately, so we prefix the message for clarity. */
function toolError(error: TaskIntakeError): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const prefix =
    error.kind === 'invalid'
      ? 'Invalid input'
      : error.kind === 'not_found'
        ? 'Not found'
        : 'Forgejo upstream failure';
  return {
    content: [{ type: 'text', text: `${prefix}: ${error.message}` }],
    isError: true,
  };
}
