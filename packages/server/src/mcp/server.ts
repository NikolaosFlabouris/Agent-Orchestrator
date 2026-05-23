/**
 * MCP (Model Context Protocol) server module.
 *
 * Builds an `McpServer` instance that exposes the orchestrator's
 * task-management surface as three tools an MCP client (Claude Code,
 * the create-task-forgejo plugin's skill, …) can invoke:
 *
 *   - `list_repos`           — registered repos + their effective agent
 *                              profile (repo override → global default).
 *   - `list_agent_profiles`  — every configured agent profile with the
 *                              joined model/provider stats.
 *   - `create_task`          — create a Forgejo issue + queue an
 *                              orchestrator task, with optional
 *                              per-task overrides (agent_profile_id,
 *                              max_attempts, human_merge, human_review).
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

/** Reported to the client during the MCP initialization handshake. The
 *  version is intentionally independent of the orchestrator's package
 *  version — it's the *MCP contract* version, bumped when tool shapes
 *  change in client-visible ways. */
const MCP_SERVER_INFO = {
  name: 'agent-orchestrator',
  version: '0.1.0',
} as const;

/** Dependencies the `create_task` tool needs to act. Match
 *  `IntakeDeps` so callers can hand the same object to both. */
export interface McpServerDeps {
  forgejo: ForgejoClient;
  scheduler: Pick<Scheduler, 'triggerTick'>;
  log?: FastifyBaseLogger;
}

/**
 * Build a fresh McpServer with the three tools registered. The caller
 * is responsible for connecting it to a transport.
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
        'along with the agent profile that will run a new task against ' +
        "it by default (the repo's own override if set, else the global " +
        'default). Use this to pick a `repo_id` for `create_task` and to ' +
        'surface the effective profile/model/provider to the human.',
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
            effective_profile: z
              .object({
                id: z.string(),
                display_name: z.string(),
                harness_id: z.string(),
                timeout_minutes: z.number().int(),
                model_id: z.string().nullable(),
                provider_id: z.string().nullable(),
                provider_display_name: z.string().nullable(),
              })
              .nullable(),
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
        'for the `agent_profile_id` override on `create_task`.',
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
        'make it specific, with clear acceptance criteria.',
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
        agent_profile_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Optional per-task profile override. null / omitted = inherit ' +
              "from the repo's default, which itself inherits from the " +
              'global default.'
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
        `agent profile: ${task.agent_profile_id ?? '(inherit)'}.`;
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
          },
          issue: { number: issue.number, title: issue.title },
        },
      };
    }
  );

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
  return `#${r.id} ${r.owner}/${r.name} (base: ${r.base_branch}) → ${profile}${sourceTag}`;
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
