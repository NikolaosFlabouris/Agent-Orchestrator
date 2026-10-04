import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ForgejoClient } from '../../forgejo.js';

/**
 * Regression tests for duplicate-label creation in replaceLabelByNames.
 *
 * The per-repo label cache used to be filled once and never refreshed, and
 * getLabels only read Forgejo's first page. Any label missing from the cache
 * (created later by a human/CI, or past page 1) was re-created, producing a
 * second label with the same name. Forgejo's `?labels=<name>` filter then
 * matched nothing, silently breaking CI triage's duplicate guard.
 */

type Label = { id: number; name: string; color: string };

const repo = { id: 1, owner: 'nik', name: 'repo', base_branch: 'main' } as Parameters<
  ForgejoClient['replaceLabelByNames']
>[0];

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Stub forge: serves `labels` paged, records every call. */
function stubForge(opts: {
  labels: Label[];
  pageSize?: number;
  failCreate?: (name: string) => boolean;
}) {
  const state = { labels: [...opts.labels], nextId: 1000 };
  const calls: Call[] = [];
  const pageSize = opts.pageSize ?? 50;

  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: path + url.search, body });

    const respond = (status: number, payload?: unknown) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
      }) as Response;

    if (path === '/repos/nik/repo/labels' && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      // Forgejo clamps limit to its own max page size
      const limit = Math.min(Number(url.searchParams.get('limit') ?? pageSize), pageSize);
      return respond(200, state.labels.slice((page - 1) * limit, page * limit));
    }
    if (path === '/repos/nik/repo/labels' && method === 'POST') {
      if (opts.failCreate?.(body.name)) return respond(409, { message: 'exists' });
      const label = { id: state.nextId++, name: body.name, color: body.color };
      state.labels.push(label);
      return respond(201, label);
    }
    if (path === '/repos/nik/repo/issues/7/labels' && method === 'PUT') {
      return respond(200, []);
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof fetch;

  return { state, calls };
}

const isLabelsGet = (c: Call) => c.method === 'GET' && c.path.startsWith('/repos/nik/repo/labels');
const isLabelsPost = (c: Call) => c.method === 'POST' && c.path === '/repos/nik/repo/labels';
const putBody = (calls: Call[]) =>
  calls.filter((c) => c.method === 'PUT').at(-1)?.body as { labels: number[] };

describe('ForgejoClient.replaceLabelByNames label cache', () => {
  const originalFetch = globalThis.fetch;
  let client: ForgejoClient;

  beforeEach(() => {
    client = new ForgejoClient('http://forgejo', 'tok');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('refreshes a stale cache instead of creating a duplicate', async () => {
    const forge = stubForge({ labels: [{ id: 1, name: 'status/ready', color: '#fff' }] });
    await client.replaceLabelByNames(repo, 7, ['status/ready']);

    // Created on the forge by someone else after the cache was filled
    forge.state.labels.push({ id: 56, name: 'ci-failure', color: '#f00' });
    forge.calls.length = 0;

    await client.replaceLabelByNames(repo, 7, ['status/ready', 'ci-failure']);

    expect(forge.calls.filter(isLabelsPost)).toHaveLength(0);
    expect(forge.calls.filter(isLabelsGet)).toHaveLength(1);
    expect(putBody(forge.calls).labels).toEqual([1, 56]);
  });

  it('pages through labels and finds one on page 2', async () => {
    const labels = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `label-${i + 1}`,
      color: '#fff',
    }));
    labels.push({ id: 51, name: 'ci-failure', color: '#f00' });
    const forge = stubForge({ labels, pageSize: 50 });

    await client.replaceLabelByNames(repo, 7, ['ci-failure']);

    expect(forge.calls.filter(isLabelsPost)).toHaveLength(0);
    const gets = forge.calls.filter(isLabelsGet).map((c) => c.path);
    expect(gets).toEqual([
      '/repos/nik/repo/labels?page=1&limit=50',
      '/repos/nik/repo/labels?page=2&limit=50',
    ]);
    expect(putBody(forge.calls).labels).toEqual([51]);
  });

  it('getLabels stops at an empty page when the last page is full', async () => {
    const labels = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `l${i}`, color: '#fff' }));
    const forge = stubForge({ labels, pageSize: 50 });

    const all = await client.getLabels(repo);

    expect(all).toHaveLength(50);
    expect(forge.calls.filter(isLabelsGet)).toHaveLength(2);
  });

  it('resolves duplicate names to the lowest id and never creates', async () => {
    const forge = stubForge({
      labels: [
        { id: 57, name: 'ci-failure', color: '#0075ca' },
        { id: 56, name: 'ci-failure', color: '#f00' },
      ],
    });

    await client.replaceLabelByNames(repo, 7, ['ci-failure']);
    await client.replaceLabelByNames(repo, 7, ['ci-failure']);

    expect(forge.calls.filter(isLabelsPost)).toHaveLength(0);
    const puts = forge.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => (c.body as { labels: number[] }).labels)).toEqual([[56], [56]]);
  });

  it('uses the existing label when creation races and fails', async () => {
    const forge = stubForge({
      labels: [],
      failCreate: (name) => {
        // Another writer wins the race
        forge.state.labels.push({ id: 99, name, color: '#f00' });
        return true;
      },
    });

    await expect(client.replaceLabelByNames(repo, 7, ['ci-failure'])).resolves.toBeUndefined();
    expect(forge.calls.filter(isLabelsPost)).toHaveLength(1);
    expect(putBody(forge.calls).labels).toEqual([99]);
  });

  it('throws when creation fails and the label is still missing', async () => {
    const forge = stubForge({ labels: [], failCreate: () => true });

    await expect(client.replaceLabelByNames(repo, 7, ['ci-failure'])).rejects.toThrow(/failed with 409/);
    expect(forge.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('creates genuinely missing labels with the default colour and exclusive rule', async () => {
    const forge = stubForge({ labels: [] });

    await client.replaceLabelByNames(repo, 7, ['status/ready', 'human-merge']);

    const posts = forge.calls.filter(isLabelsPost).map((c) => c.body);
    expect(posts).toEqual([
      { name: 'status/ready', color: '#0075ca', exclusive: true },
      { name: 'human-merge', color: '#0075ca', exclusive: false },
    ]);
    // One initial fill, no extra refresh for the second miss
    expect(forge.calls.filter(isLabelsGet)).toHaveLength(1);
    expect(putBody(forge.calls).labels).toEqual([1000, 1001]);
  });

  it('makes no GET /labels request when every name is cached', async () => {
    const forge = stubForge({
      labels: [
        { id: 1, name: 'status/ready', color: '#fff' },
        { id: 2, name: 'ci-failure', color: '#f00' },
      ],
    });
    await client.replaceLabelByNames(repo, 7, ['status/ready']);
    forge.calls.length = 0;

    await client.replaceLabelByNames(repo, 7, ['status/ready', 'ci-failure']);

    expect(forge.calls.filter(isLabelsGet)).toHaveLength(0);
    expect(forge.calls.filter(isLabelsPost)).toHaveLength(0);
    expect(forge.calls).toHaveLength(1);
    expect(putBody(forge.calls).labels).toEqual([1, 2]);
  });
});
