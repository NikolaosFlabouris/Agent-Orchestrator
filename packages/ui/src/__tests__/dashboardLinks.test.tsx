import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// Every Dashboard task row — active card, queue row, recent completion — must
// navigate through a real <a href="/tasks/:id">, because that is the only way
// the browser offers middle-click / ctrl+click "open in new tab" (issue #171).
// A <div role="link"> with an onClick+navigate renders identically and passes
// a click test, so the thing worth pinning is the MARKUP: an anchor per row,
// no `role="link"` left behind, and no nested <a> (the Forgejo issue link must
// stay a sibling of the task link, not a child of it).

const forgejoBaseUrl = 'https://forge.example';

const fakeState: Record<string, unknown> = {
  tasks: [],
  hostPool: {
    memory_used_mb: 0,
    memory_total_mb: 0,
    cpu_used_cores: 0,
    cpu_total_cores: 0,
  },
  queueDepth: 0,
  paused: false,
  forgejoBaseUrl,
  alerts: [],
  agentProfiles: [],
  resourceVersions: { providers: 0, models: 0, profiles: 0 },
  user: null,
  connection: 'live',
  setStatus: () => {},
  setHostPool: () => {},
  setAgentProfiles: () => {},
  setForgejoBaseUrl: () => {},
  syncTasks: () => {},
};

// zustand v5 hands SSR renders the store's INITIAL state (its
// `getServerSnapshot` is `getInitialState`), so priming the real store would
// render an empty dashboard. Stub the hook with a plain object instead.
vi.mock('../store.js', async () => {
  const actual =
    await vi.importActual<typeof import('../store.js')>('../store.js');
  const useStore = Object.assign((sel: (s: unknown) => unknown) => sel(fakeState), {
    getState: () => fakeState,
    setState: () => {},
    subscribe: () => () => {},
  });
  return { ...actual, useStore };
});

vi.mock('../api.js', () => ({
  api: {
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    getStatus: vi.fn().mockResolvedValue({}),
    getRepos: vi.fn().mockResolvedValue({ repos: [] }),
    getAgentProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
    getReportOverview: vi.fn().mockResolvedValue(null),
  },
}));

const { Dashboard } = await import('../views/Dashboard.js');

function task(over: Record<string, unknown>) {
  return {
    id: 1,
    issue_id: 7,
    issue_title: 'A title',
    status: 'in-progress',
    attempt: 1,
    max_attempts: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    repo: { owner: 'o', name: 'r' },
    queue_position: 1,
    ...over,
  } as never;
}

function render() {
  fakeState.tasks = [
    task({ id: 1, issue_id: 7, status: 'in-progress' }),
    task({ id: 2, issue_id: 8, status: 'queued' }),
    task({
      id: 3,
      issue_id: 9,
      status: 'merged',
      completed_at: '2026-01-02T00:00:00.000Z',
    }),
  ];
  return renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(Dashboard))
  );
}

describe('Dashboard task rows', () => {
  const html = render();

  it('links every row type to its task detail page with a real anchor', () => {
    // 1 = active card, 2 = queue row, 3 = recent completion.
    for (const id of [1, 2, 3]) {
      expect(html).toContain(`href="/tasks/${id}"`);
    }
  });

  it('drops the div/role="link" keyboard emulation', () => {
    expect(html).not.toContain('role="link"');
  });

  it('keeps the Forgejo issue links as siblings, never nested anchors', () => {
    for (const issue of [7, 8, 9]) {
      expect(html).toContain(`href="${forgejoBaseUrl}/o/r/issues/${issue}"`);
    }
    const nested = /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<a\b/.test(html);
    expect(nested).toBe(false);
  });

  it('leaves the queue drag handle outside the link', () => {
    expect(html).toContain('aria-label="Drag to reorder queue position"');
  });
});

describe('Recent size selector', () => {
  const html = render();

  it('offers 5/10/20/50/100 and defaults to 10', () => {
    const options = [...html.matchAll(/<option value="(\d+)"/g)].map((m) =>
      Number(m[1])
    );
    expect(options).toEqual([5, 10, 20, 50, 100]);
    expect(html).toContain('<option value="10" selected="">10</option>');
  });

  it('associates a label with the select', () => {
    const id = /<select id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<label for="${id}"`);
  });
});
