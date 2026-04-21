import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ForgejoClient } from '../../forgejo.js';

/**
 * Regression test for the empty-body response bug:
 *
 * Forgejo's `POST /pulls/:id/merge` returns HTTP 200 with an empty body on
 * success. The old implementation unconditionally called `response.json()`
 * which threw `SyntaxError: Unexpected end of JSON input`, so the caller
 * saw a successful merge as a failed one. In production this caused task #1
 * to be marked `failed` even though PR #15 had merged cleanly.
 */
describe('ForgejoClient empty-body handling', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponse(opts: {
    status: number;
    body: string;
    ok?: boolean;
  }): void {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
      status: opts.status,
      text: async () => opts.body,
      json: async () => JSON.parse(opts.body),
    } as Response);
  }

  it('returns undefined for 200 OK with empty body (the merge-response case)', async () => {
    mockFetchResponse({ status: 200, body: '' });
    const client = new ForgejoClient('http://forgejo', 'tok');
    // mergePullRequest internally calls request('POST', ..., body) and
    // returns Promise<void>, so the call should just resolve.
    await expect(
      client.mergePullRequest(
        { id: 1, owner: 'nik', name: 'repo', base_branch: 'main' } as Parameters<
          typeof client.mergePullRequest
        >[0],
        15
      )
    ).resolves.toBeUndefined();
  });

  it('returns undefined for 204 No Content (pre-existing behaviour preserved)', async () => {
    mockFetchResponse({ status: 204, body: '' });
    const client = new ForgejoClient('http://forgejo', 'tok');
    await expect(
      client.deleteBranch(
        { id: 1, owner: 'nik', name: 'repo', base_branch: 'main' } as Parameters<
          typeof client.deleteBranch
        >[0],
        'agent/issue-1'
      )
    ).resolves.toBeUndefined();
  });

  it('parses JSON body when present (pre-existing behaviour preserved)', async () => {
    mockFetchResponse({
      status: 200,
      body: JSON.stringify({ id: 1, login: 'nik' }),
    });
    const client = new ForgejoClient('http://forgejo', 'tok');
    const user = await client.getCurrentUser();
    expect(user).toEqual({ id: 1, login: 'nik' });
  });

  it('still throws ForgejoApiError on non-2xx responses', async () => {
    mockFetchResponse({
      status: 405,
      body: '{"message":""}',
      ok: false,
    });
    const client = new ForgejoClient('http://forgejo', 'tok');
    await expect(
      client.mergePullRequest(
        { id: 1, owner: 'nik', name: 'repo', base_branch: 'main' } as Parameters<
          typeof client.mergePullRequest
        >[0],
        15
      )
    ).rejects.toThrow(/failed with 405/);
  });
});
