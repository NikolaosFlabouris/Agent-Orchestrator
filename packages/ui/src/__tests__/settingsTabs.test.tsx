import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The Settings tab is a URL now, which buys two things worth pinning: an
// unknown `/settings/<junk>` must resolve to a real tab rather than rendering
// an empty body, and each pill must be a real <a href> so middle-click /
// ctrl+click open it in a new tab (same rule as the dashboard rows, #171).

vi.mock('../api.js', () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({}),
    getRepos: vi.fn().mockResolvedValue({ repos: [] }),
    getProviders: vi.fn().mockResolvedValue({ providers: [] }),
    getAgentProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
    getCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
  },
}));

const { Settings, parseSettingsTab, DEFAULT_TAB } = await import(
  '../views/Settings.js'
);

const TAB_KEYS = ['global', 'repos', 'providers', 'profiles', 'credentials'];

describe('parseSettingsTab', () => {
  it('accepts every tab key', () => {
    for (const key of TAB_KEYS) {
      expect(parseSettingsTab(key)).toBe(key);
    }
  });

  it('returns null for an absent segment (bare /settings)', () => {
    expect(parseSettingsTab(undefined)).toBeNull();
    expect(parseSettingsTab('')).toBeNull();
  });

  it('returns null for unknown segments', () => {
    for (const junk of ['Global', 'nope', 'global/', '../etc']) {
      expect(parseSettingsTab(junk)).toBeNull();
    }
  });

  it('is not fooled by Object.prototype keys', () => {
    // `TAB_LABELS['toString']` is a function, so a naive lookup would treat
    // /settings/toString as a valid tab and render nothing.
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(parseSettingsTab(key)).toBeNull();
    }
  });

  it('names a real tab as the default', () => {
    expect(parseSettingsTab(DEFAULT_TAB)).toBe(DEFAULT_TAB);
  });
});

function render(path: string): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/settings/:tab?',
          element: React.createElement(Settings),
        })
      )
    )
  );
}

describe('Settings tab bar', () => {
  const html = render('/settings/providers');

  it('links every tab with a real anchor', () => {
    for (const key of TAB_KEYS) {
      expect(html).toContain(`href="/settings/${key}"`);
    }
  });

  it('marks the tab named by the URL as current', () => {
    expect(html).toMatch(
      /<a aria-current="page"[^>]*href="\/settings\/providers"/
    );
    expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
  });

  it('drops the button-era aria-pressed toggle state', () => {
    expect(html).not.toContain('aria-pressed');
  });

  it('renders the tab body named by the URL', () => {
    // Providers & Models is the only tab with this heading.
    expect(html).toContain('Providers');
  });

  it('renders a redirect, not a body-less page, for bare and unknown paths', () => {
    // <Navigate> performs its hop in an effect, which a static render never
    // runs — so what this pins is that Settings bails out entirely (empty
    // output) instead of rendering the chrome with no tab selected. Where it
    // redirects TO is fixed by parseSettingsTab(undefined) === null plus
    // DEFAULT_TAB above.
    for (const path of ['/settings', '/settings/nonsense']) {
      expect(render(path)).toBe('');
    }
  });
});
