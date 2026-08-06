import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useStore } from '../../store.js';
import type { CredentialStatus } from '../../api.js';

/** Credentials tab — read-only view of orchestrator and provider
 *  credential env-var statuses. */
export function CredentialSettings() {
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  // The provider-scoped credential rows are derived from each provider's
  // `api_key_env_var`. Subscribe to providersVersion (M8) so that adding
  // / editing / deleting a provider in another tab refreshes this list
  // without a page reload. Orchestrator-scoped rows are static at
  // process start, so a mount-time fetch is sufficient for those — the
  // provider-version subscription just keeps the provider half live.
  const providersVersion = useStore((s) => s.resourceVersions.providers);

  useEffect(() => {
    api.getCredentials().then((r) => setCredentials(r.credentials)).catch(() => {});
  }, [providersVersion]);

  const orchestrator = credentials.filter((c) => c.scope === 'orchestrator');
  const provider = credentials.filter((c) => c.scope === 'provider');

  function row(cred: CredentialStatus) {
    return (
      <div
        // Composite key — `provider_id` is null for orchestrator-scope
        // credentials, so just using it would collide for every
        // orchestrator row. Including scope+name disambiguates.
        key={`${cred.scope}-${cred.name}-${cred.provider_id ?? ''}`}
        /* Env-var names plus the "for provider …" suffix run past 375px,
           so the row wraps and the status keeps its own end of the line
           rather than being pushed off-screen. Wide viewports never wrap,
           and `gap-2` only shows once the two halves would otherwise
           touch — so the desktop row is unchanged. */
        className="flex flex-wrap items-center justify-between gap-2 bg-gray-900 border border-gray-800 rounded p-3"
      >
        {/* `min-w-0` lets this block shrink below its content width inside
            the flex row, and `break-words` keeps a long env-var name from
            spilling past the card. */}
        <div className="min-w-0 break-words">
          <span className="font-mono text-sm">{cred.name}</span>
          {cred.provider_id && (
            <span className="text-gray-500 text-xs ml-2">
              for provider <span className="font-mono">{cred.provider_id}</span>
            </span>
          )}
        </div>
        {cred.configured ? (
          <span className="shrink-0 text-green-400 text-sm">configured</span>
        ) : (
          <span className="shrink-0 text-red-400 text-sm">not set</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Credentials are loaded from environment variables on the orchestrator
        host. To update, modify the orchestrator's <span className="font-mono">.env</span>{' '}
        file and restart. Provider credentials can also be configured inline
        on a per-provider basis under <em>Providers & Models</em> (stored in
        the database rather than the env).
      </p>

      {credentials.length === 0 ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : (
        <>
          <div>
            <h3 className="text-sm font-medium mb-2">
              Orchestrator-only secrets
              <span className="text-gray-500 font-normal text-xs ml-2">
                used by the orchestrator process; never sent to agent containers
              </span>
            </h3>
            <div className="space-y-2">{orchestrator.map(row)}</div>
          </div>

          <div>
            <h3 className="text-sm font-medium mb-2">
              Provider keys forwarded to agent containers
              <span className="text-gray-500 font-normal text-xs ml-2">
                derived from each provider's <span className="font-mono">api_key_env_var</span>
              </span>
            </h3>
            {provider.length === 0 ? (
              <p className="text-gray-500 text-sm">
                No providers reference an env-var pointer.
              </p>
            ) : (
              <div className="space-y-2">{provider.map(row)}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
