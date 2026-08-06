import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader.js';
import { GlobalSettings } from './Settings/GlobalSettings.js';
import { RepoSettings } from './Settings/RepoSettings.js';
import { ProviderSettings } from './Settings/ProviderSettings.js';
import { AgentProfileSettings } from './Settings/AgentProfileSettings.js';
import { CredentialSettings } from './Settings/CredentialSettings.js';

/** Settings page — thin tab router. Each tab's UI lives in its own
 *  file under `./Settings/` so this top-level component stays focused
 *  on layout (header, tab bar, body). Add a new tab by:
 *    1. Creating `./Settings/<Name>.tsx` exporting a default-naming
 *       component.
 *    2. Adding an entry to `TAB_LABELS` and the routing switch below.
 *  Cross-tab state (e.g. websocket-driven resource versions) lives in
 *  the global store, so tabs don't need to share a parent here. */

type TabKey = 'global' | 'repos' | 'providers' | 'profiles' | 'credentials';

const TAB_LABELS: Record<TabKey, string> = {
  global: 'Global Settings',
  repos: 'Repositories',
  providers: 'Providers & Models',
  profiles: 'Agent Profiles',
  credentials: 'Credentials',
};

export function Settings() {
  const [tab, setTab] = useState<TabKey>('global');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader
        back={
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
            &larr; Dashboard
          </Link>
        }
        title="Settings"
      >
        <Link to="/help" className="text-blue-400 hover:text-blue-300 text-sm">
          Help
        </Link>
      </AppHeader>

      <main className="mx-auto max-w-4xl px-6 py-6">
        {/* The five pills add up to ~650px, so on a phone the last two sit
            past the right edge and are unreachable. `max-w-full` caps the
            `w-fit` bar at the column width and `overflow-x-auto` turns the
            excess into a scroll of the bar itself rather than of the
            document; `shrink-0 whitespace-nowrap` keeps each pill at its
            natural width instead of letting flex squeeze the labels onto
            two lines. Wide viewports never overflow, so no scrollbar
            appears and the bar renders exactly as before. */}
        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit max-w-full overflow-x-auto">
          {(Object.keys(TAB_LABELS) as TabKey[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              /* py-3 makes the pill 44px tall — the minimum comfortable
                 touch target; `sm:py-2` restores the original height from
                 the tablet breakpoint up. */
              className={`shrink-0 whitespace-nowrap px-4 py-3 sm:py-2 rounded text-sm ${
                tab === t
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {tab === 'global' && <GlobalSettings />}
        {tab === 'repos' && <RepoSettings />}
        {tab === 'providers' && <ProviderSettings />}
        {tab === 'profiles' && <AgentProfileSettings />}
        {tab === 'credentials' && <CredentialSettings />}
      </main>
    </div>
  );
}
