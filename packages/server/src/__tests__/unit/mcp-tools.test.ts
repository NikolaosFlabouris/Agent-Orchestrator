import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { initDatabase, getDb } from '../../db.js';
import { createMcpServer } from '../../mcp/server.js';
import type { ForgejoClient } from '../../forgejo.js';
import type { Scheduler } from '../../scheduler.js';

/**
 * End-to-end tests for the MCP tool surface.
 *
 * Each test wires a fresh in-memory MCP client to a fresh server (no
 * transport over the network, no Fastify, no real Forgejo) via
 * `InMemoryTransport.createLinkedPair()`. This exercises the same
 * Protocol + JSON-RPC code path a real client would, so we catch
 * schema-validation regressions, tool-name typos, and result-shape
 * mismatches.
 *
 * `create_task` uses the shared `task-intake` service we already cover
 * exhaustively in `task-intake.test.ts`; these tests focus on the MCP
 * wrapper — the tool registration, error-kind → isError mapping, and
 * the structured-content shape clients consume.
 */

function insertRepo(opts: { owner?: string; name?: string } = {}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO repos (owner, name, base_branch, agent_profile_id, install_steps, allow_script_steps, container_memory_mb, container_cpu_cores, merge_strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.owner ?? 'acme',
      opts.name ?? 'frontend',
      'main',
      null,
      '[]',
      0,
      null,
      null,
      'squash'
    );
  return result.lastInsertRowid as number;
}

interface ConnectedPair {
  client: Client;
  triggerTick: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
  replaceLabelByNames: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

async function connectPair(
  overrides: {
    createIssue?: ReturnType<typeof vi.fn>;
    replaceLabelByNames?: ReturnType<typeof vi.fn>;
    getIssue?: ReturnType<typeof vi.fn>;
  } = {}
): Promise<ConnectedPair> {
  const createIssue =
    overrides.createIssue ??
    vi.fn().mockResolvedValue({ number: 101, title: 'mock title' });
  const replaceLabelByNames =
    overrides.replaceLabelByNames ?? vi.fn().mockResolvedValue(undefined);
  const getIssue =
    overrides.getIssue ??
    vi.fn().mockResolvedValue({ number: 101, title: 'existing title' });
  const triggerTick = vi.fn();

  const forgejoStub = {
    createIssue,
    replaceLabelByNames,
    getIssue,
  } as unknown as ForgejoClient;

  const server = createMcpServer({
    forgejo: forgejoStub,
    scheduler: { triggerTick } as Pick<Scheduler, 'triggerTick'>,
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    triggerTick,
    createIssue,
    replaceLabelByNames,
    getIssue,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  initDatabase(':memory:');
});

// ---------------------------------------------------------------------------
// Tool registration / discovery
// ---------------------------------------------------------------------------

describe('MCP server — tool registration', () => {
  it('advertises exactly list_repos, list_agent_profiles, and create_task', async () => {
    const pair = await connectPair();
    try {
      const { tools } = await pair.client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['create_task', 'list_agent_profiles', 'list_repos']);
    } finally {
      await pair.close();
    }
  });

  it('reports correct annotations: create_task is non-read-only, list_repos is read-only', async () => {
    const pair = await connectPair();
    try {
      const { tools } = await pair.client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect(byName.get('list_repos')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('list_agent_profiles')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('create_task')?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get('create_task')?.annotations?.destructiveHint).toBe(false);
      expect(byName.get('create_task')?.annotations?.openWorldHint).toBe(true);
    } finally {
      await pair.close();
    }
  });
});

// ---------------------------------------------------------------------------
// list_repos
// ---------------------------------------------------------------------------

describe('MCP tool list_repos', () => {
  it('returns an empty array when no repos are registered', async () => {
    const pair = await connectPair();
    try {
      const result = await pair.client.callTool({
        name: 'list_repos',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { repos: unknown[] };
      expect(sc.repos).toEqual([]);
    } finally {
      await pair.close();
    }
  });

  it('returns registered repos with the effective profile resolved server-side', async () => {
    insertRepo({ owner: 'acme', name: 'a' });
    const pair = await connectPair();
    try {
      const result = await pair.client.callTool({
        name: 'list_repos',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        repos: Array<{
          owner: string;
          name: string;
          effective_agent_profile_id: string | null;
          agent_profile_source: string;
        }>;
      };
      expect(sc.repos).toHaveLength(1);
      expect(sc.repos[0]).toMatchObject({
        owner: 'acme',
        name: 'a',
        // Bootstrap seeds default_agent_profile_id = 'default-claude-sdk'.
        effective_agent_profile_id: 'default-claude-sdk',
        agent_profile_source: 'global',
      });
    } finally {
      await pair.close();
    }
  });
});

// ---------------------------------------------------------------------------
// list_agent_profiles
// ---------------------------------------------------------------------------

describe('MCP tool list_agent_profiles', () => {
  it('returns the bootstrap-seeded profiles with model + provider joined', async () => {
    const pair = await connectPair();
    try {
      const result = await pair.client.callTool({
        name: 'list_agent_profiles',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        profiles: Array<{ id: string; harness_id: string; model_id: string | null }>;
      };
      // Bootstrap seeds at least default-claude-sdk.
      const def = sc.profiles.find((p) => p.id === 'default-claude-sdk');
      expect(def).toBeDefined();
      expect(def!.harness_id).toBe('claude-sdk');
      expect(def!.model_id).toBe('claude-sonnet-4-6');
    } finally {
      await pair.close();
    }
  });
});

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------

describe('MCP tool create_task', () => {
  it('happy path returns the created task + issue and kicks the scheduler', async () => {
    const repoId = insertRepo();
    const pair = await connectPair({
      createIssue: vi
        .fn()
        .mockResolvedValue({ number: 42, title: 'Add login validation' }),
    });
    try {
      const result = await pair.client.callTool({
        name: 'create_task',
        arguments: {
          repo_id: repoId,
          title: 'Add login validation',
          description: 'do the thing',
        },
      });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        task: { id: number; issue_id: number; status: string };
        issue: { number: number; title: string };
      };
      expect(sc.issue).toEqual({ number: 42, title: 'Add login validation' });
      expect(sc.task.issue_id).toBe(42);
      expect(sc.task.status).toBe('queued');
      expect(pair.createIssue).toHaveBeenCalledTimes(1);
      expect(pair.replaceLabelByNames.mock.calls[0][2]).toEqual([
        'status/queued',
      ]);
      expect(pair.triggerTick).toHaveBeenCalledTimes(1);
    } finally {
      await pair.close();
    }
  });

  it('happy path with overrides applies human-* labels and persists profile/attempts on the row', async () => {
    const repoId = insertRepo();
    const pair = await connectPair();
    try {
      const result = await pair.client.callTool({
        name: 'create_task',
        arguments: {
          repo_id: repoId,
          title: 't',
          description: 'd',
          agent_profile_id: 'default-claude-sdk',
          max_attempts: 3,
          human_merge: true,
          human_review: true,
        },
      });
      expect(result.isError).toBeFalsy();
      expect(pair.replaceLabelByNames.mock.calls[0][2]).toEqual([
        'status/queued',
        'human-merge',
        'human-review',
      ]);
      const sc = result.structuredContent as {
        task: { agent_profile_id: string | null; max_attempts: number };
      };
      expect(sc.task.agent_profile_id).toBe('default-claude-sdk');
      expect(sc.task.max_attempts).toBe(3);
    } finally {
      await pair.close();
    }
  });

  it("not_found from the service maps to isError with a 'Not found:' prefix", async () => {
    const pair = await connectPair();
    try {
      const result = await pair.client.callTool({
        name: 'create_task',
        arguments: {
          repo_id: 9999,
          title: 't',
          description: 'd',
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/^Not found:/);
      expect(text).toMatch(/Repo not found/);
      // No side effects.
      expect(pair.createIssue).not.toHaveBeenCalled();
      expect(pair.triggerTick).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });

  it("forgejo_failure from the service maps to isError with the upstream prefix", async () => {
    const repoId = insertRepo();
    const pair = await connectPair({
      createIssue: vi.fn().mockRejectedValue(new Error('upstream is down')),
    });
    try {
      const result = await pair.client.callTool({
        name: 'create_task',
        arguments: { repo_id: repoId, title: 't', description: 'd' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/^Forgejo upstream failure:/);
      expect(text).toMatch(/upstream is down/);
    } finally {
      await pair.close();
    }
  });

  it("invalid input from the service (unknown agent_profile_id) maps to isError with 'Invalid input:' prefix", async () => {
    const repoId = insertRepo();
    const pair = await connectPair();
    try {
      const result = await pair.client.callTool({
        name: 'create_task',
        arguments: {
          repo_id: repoId,
          title: 't',
          description: 'd',
          agent_profile_id: 'no-such-profile',
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toMatch(/^Invalid input:/);
      expect(text).toMatch(/Unknown agent_profile_id/);
    } finally {
      await pair.close();
    }
  });

  it('rejects schema-invalid inputs at the SDK validation layer', async () => {
    // repo_id must be a positive integer per the zod schema; a string
    // should be rejected before the callback runs. The SDK returns the
    // failure as isError on the CallToolResult — clients see a uniform
    // shape whether validation fired client-side, server-side schema,
    // or service-level.
    const pair = await connectPair();
    try {
      const result = await pair.client.callTool({
        name: 'create_task',
        arguments: { repo_id: 'not-a-number', title: 't', description: 'd' },
      });
      expect(result.isError).toBe(true);
      // No issue side effect — the schema check fired first.
      expect(pair.createIssue).not.toHaveBeenCalled();
    } finally {
      await pair.close();
    }
  });
});
