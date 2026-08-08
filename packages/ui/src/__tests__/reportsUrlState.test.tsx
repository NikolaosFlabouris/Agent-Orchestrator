import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// `parseReportParams` is unit-tested next door; what this pins is the wiring —
// that the filter bar renders from the URL rather than from its own state, so
// pasting a shared /reports link actually reproduces the filtered view.

const repos = [
  { id: 1, owner: 'o', name: 'one' },
  { id: 2, owner: 'o', name: 'two' },
];

vi.mock('../api.js', () => ({
  api: {
    getRepos: vi.fn().mockResolvedValue({ repos }),
    getStatus: vi.fn().mockResolvedValue({ forgejo_base_url: '' }),
    getReportTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0, limit: 25 }),
  },
}));

const { Reports } = await import('../views/Reports.js');

function render(url: string): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [url] },
      React.createElement(Reports)
    )
  );
}

/** The `value` of each `<input type="date">`, in document order (From, To). */
function dateInputs(html: string): string[] {
  return [...html.matchAll(/<input type="date"[^>]*value="([^"]*)"/g)].map(
    (m) => m[1]
  );
}

describe('Reports filter bar', () => {
  it('takes its date range from the query string', () => {
    expect(dateInputs(render('/reports?from=2026-01-01&to=2026-02-01'))).toEqual([
      '2026-01-01',
      '2026-02-01',
    ]);
  });

  it('falls back to the default window when a date is junk', () => {
    const [from, to] = dateInputs(render('/reports?from=yesterday&to=2026-02-01'));
    // Without freezing the clock all we can say about the substituted bound
    // is that it is a well-formed date — and that the good bound survived.
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toBe('2026-02-01');
  });

  it('reads the repo selection from ?repos', () => {
    // The chips themselves come from an effect-loaded repo list, which a
    // static render never populates — but the "All" chip is highlighted
    // exactly when nothing is selected, so it reports the parsed selection.
    expect(render('/reports')).toMatch(/bg-blue-900[^>]*>All</);
    expect(render('/reports?repos=2')).toMatch(/bg-gray-800[^>]*>All</);
    // …and a junk id is no selection at all.
    expect(render('/reports?repos=abc')).toMatch(/bg-blue-900[^>]*>All</);
  });
});
