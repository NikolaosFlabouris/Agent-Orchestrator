import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type {
  RepoResponse,
  CredentialStatus,
  ForgejoRepoResponse,
  ProviderResponse,
  ProviderKind,
  ProviderKindSpec,
  ModelResponse,
  AgentProfileResponse,
  HarnessSpec,
  HarnessId,
  HostCapacityResponse,
  InstallStep,
  InstallStepKind,
} from '../api.js';
import { INSTALL_STEP_LABELS } from '../api.js';

const INSTALL_STEP_KINDS: InstallStepKind[] = [
  'npm-ci',
  'npm-install',
  'yarn-install',
  'pnpm-install',
  'pip-requirements',
  'pip-pyproject',
  'uv-sync',
  'cargo-fetch',
  'go-mod-download',
];

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
      <header className="sticky top-0 z-20 border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="flex items-center justify-between">
          <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
            &larr; Dashboard
          </Link>
          <Link to="/help" className="text-blue-400 hover:text-blue-300 text-sm">
            Help
          </Link>
        </div>
        <h1 className="text-xl font-semibold mt-1">Settings</h1>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-6">
        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit">
          {(Object.keys(TAB_LABELS) as TabKey[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded text-sm ${
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

// ---------------------------------------------------------------------------
// Global Settings tab
// ---------------------------------------------------------------------------

function GlobalSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [profiles, setProfiles] = useState<AgentProfileResponse[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<HostCapacityResponse | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
    api.getHostCapacity().then(setCapacity).catch(() => {});
    api.getAgentProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.updateSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function update(key: string, value: unknown) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  const memValue = parseInt(String(settings.max_agent_memory_mb ?? '0'), 10) || 0;
  const cpuValue = parseInt(String(settings.max_agent_cpu_cores ?? '0'), 10) || 0;
  const memOver = capacity ? memValue > capacity.memory_total_mb : false;
  const cpuOver = capacity ? cpuValue > capacity.cpu_cores : false;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Host memory pool (MB)</label>
          <input
            type="number"
            value={String(settings.max_agent_memory_mb ?? '')}
            onChange={(e) =>
              update('max_agent_memory_mb', parseInt(e.target.value, 10) || 0)
            }
            className={`w-full bg-gray-900 border rounded px-3 py-2 text-sm ${
              memOver ? 'border-yellow-600' : 'border-gray-700'
            }`}
          />
          <p className="text-xs text-gray-500 mt-1">
            Total memory the orchestrator may allocate to agent containers.
            Sum of per-repo <span className="font-mono">container_memory_mb</span>{' '}
            across active tasks must not exceed this.
          </p>
          <CapacityHint
            kind="memory"
            capacity={capacity}
            over={memOver}
            onUseDetected={() =>
              capacity && update('max_agent_memory_mb', capacity.memory_total_mb)
            }
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Host CPU pool (cores)</label>
          <input
            type="number"
            value={String(settings.max_agent_cpu_cores ?? '')}
            onChange={(e) =>
              update('max_agent_cpu_cores', parseInt(e.target.value, 10) || 0)
            }
            className={`w-full bg-gray-900 border rounded px-3 py-2 text-sm ${
              cpuOver ? 'border-yellow-600' : 'border-gray-700'
            }`}
          />
          <p className="text-xs text-gray-500 mt-1">
            Total CPU cores the orchestrator may allocate to agent containers.
            Sum of per-repo <span className="font-mono">container_cpu_cores</span>{' '}
            across active tasks must not exceed this.
          </p>
          <CapacityHint
            kind="cpu"
            capacity={capacity}
            over={cpuOver}
            onUseDetected={() =>
              capacity && update('max_agent_cpu_cores', capacity.cpu_cores)
            }
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Default agent profile
        </label>
        <select
          value={String(settings.default_agent_profile_id ?? '')}
          onChange={(e) => update('default_agent_profile_id', e.target.value)}
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
        >
          {profiles.length === 0 && (
            <option value="">No agent profiles configured</option>
          )}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name} ({p.id})
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          Used when neither the task nor its repo specifies an agent profile.
          Manage profiles under <em>Agent Profiles</em>.
        </p>
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm rounded px-3 py-2">
          {error}
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white px-6 py-2 rounded text-sm"
      >
        {saving ? 'Saving...' : saved ? 'Saved' : 'Save settings'}
      </button>
    </div>
  );
}

function CapacityHint({
  kind,
  capacity,
  over,
  onUseDetected,
}: {
  kind: 'memory' | 'cpu';
  capacity: HostCapacityResponse | null;
  over: boolean;
  onUseDetected: () => void;
}) {
  if (!capacity) return null;
  const detected =
    kind === 'memory'
      ? `${capacity.memory_total_mb} MB`
      : `${capacity.cpu_cores} cores`;
  const sourceLabel =
    capacity.source === 'docker'
      ? 'Docker'
      : 'host OS — Docker not reachable';
  return (
    <p className="text-xs mt-1">
      <span className="text-gray-500">
        Detected: <span className="font-mono">{detected}</span> via {sourceLabel}.{' '}
      </span>
      <button
        type="button"
        onClick={onUseDetected}
        className="text-blue-400 hover:text-blue-300 underline"
      >
        Use detected
      </button>
      {over && (
        <span className="text-yellow-500 ml-2">
          ⚠ Exceeds detected capacity. Containers may be killed by Docker if it
          can't honour the reservation.
        </span>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Repos tab
// ---------------------------------------------------------------------------

function RepoSettings() {
  const [repos, setRepos] = useState<RepoResponse[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileResponse[]>([]);
  const [availableRepos, setAvailableRepos] = useState<ForgejoRepoResponse[]>([]);
  const [editing, setEditing] = useState<Partial<RepoResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getRepos().then((r) => setRepos(r.repos)).catch(() => {});
    api.getAgentProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
    api.getAvailableRepos().then((r) => setAvailableRepos(r.repos)).catch(() => {});
  }, []);

  async function handleSave() {
    if (!editing) return;
    setError(null);
    try {
      if (isNew) {
        const repo = await api.createRepo(editing);
        setRepos((prev) => [...prev, repo]);
      } else {
        const repo = await api.updateRepo(editing.id!, editing);
        setRepos((prev) => prev.map((r) => (r.id === repo.id ? repo : r)));
      }
      setEditing(null);
      setIsNew(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <div className="space-y-4">
      {repos.map((repo) => {
        const profile = repo.agent_profile_id
          ? profiles.find((p) => p.id === repo.agent_profile_id)
          : null;
        return (
          <div
            key={repo.id}
            className="bg-gray-900 border border-gray-800 rounded p-4 flex items-center justify-between"
          >
            <div>
              <span className="font-medium">
                {repo.owner}/{repo.name}
              </span>
              <span className="text-gray-500 text-sm ml-3">
                {profile
                  ? profile.display_name
                  : repo.agent_profile_id
                    ? `${repo.agent_profile_id} (missing)`
                    : 'inherits global default'}
              </span>
            </div>
            <button
              onClick={() => { setEditing({ ...repo }); setIsNew(false); }}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Edit
            </button>
          </div>
        );
      })}

      <button
        onClick={() => {
          setEditing({
            base_branch: 'main',
            agent_profile_id: null,
            merge_strategy: 'squash',
            install_steps: [],
            allow_script_steps: false,
          });
          setIsNew(true);
          api.getAvailableRepos().then((r) => setAvailableRepos(r.repos)).catch(() => {});
        }}
        className="text-sm text-blue-400 hover:text-blue-300"
      >
        + Add repository
      </button>

      {editing && (
        <div className="bg-gray-900 border border-gray-700 rounded p-4 space-y-4 mt-4">
          <h3 className="font-medium">
            {isNew ? 'Add Repository' : `Edit ${editing.owner}/${editing.name}`}
          </h3>
          {error && (
            <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm rounded px-3 py-2">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            {isNew && (
              <div className="col-span-2">
                <label className="block text-sm mb-1">Repository</label>
                {availableRepos.length > 0 ? (
                  <select
                    value={editing.owner && editing.name ? `${editing.owner}/${editing.name}` : ''}
                    onChange={(e) => {
                      const selected = availableRepos.find((r) => r.full_name === e.target.value);
                      if (selected) {
                        setEditing({ ...editing, owner: selected.owner, name: selected.name, base_branch: selected.default_branch });
                      }
                    }}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                  >
                    <option value="">Select a repository...</option>
                    {availableRepos.map((r) => (
                      <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-gray-500 text-sm py-2">No unregistered repositories found in Forgejo</p>
                )}
              </div>
            )}
            <div>
              <label className="block text-sm mb-1">Base branch</label>
              <input
                value={editing.base_branch ?? 'main'}
                onChange={(e) => setEditing({ ...editing, base_branch: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">
                Default agent profile
              </label>
              <select
                value={editing.agent_profile_id ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    agent_profile_id: e.target.value || null,
                  })
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="">Inherit (use global default)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">Memory (MB)</label>
              <input
                type="number"
                value={editing.container_memory_mb ?? ''}
                onChange={(e) => setEditing({ ...editing, container_memory_mb: e.target.value ? parseInt(e.target.value, 10) : null })}
                placeholder="Use global default"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">CPU cores</label>
              <input
                type="number"
                value={editing.container_cpu_cores ?? ''}
                onChange={(e) => setEditing({ ...editing, container_cpu_cores: e.target.value ? parseInt(e.target.value, 10) : null })}
                placeholder="Use global default"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm mb-1">
                Merge strategy
                <span className="text-gray-500 font-normal"> — preferred PR merge style; resolved against the repo's Forgejo-side allowed list at merge time</span>
              </label>
              <select
                value={editing.merge_strategy ?? 'squash'}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    merge_strategy: e.target.value as 'squash' | 'merge' | 'rebase',
                  })
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="squash">squash</option>
                <option value="merge">merge</option>
                <option value="rebase">rebase</option>
              </select>
            </div>
          </div>
          <InstallStepsEditor
            steps={editing.install_steps ?? []}
            allowScriptSteps={editing.allow_script_steps ?? false}
            onChangeSteps={(steps) => setEditing({ ...editing, install_steps: steps })}
            onChangeAllowScript={(allow) => {
              const next: Partial<RepoResponse> = { ...editing, allow_script_steps: allow };
              if (!allow) {
                next.install_steps = (editing.install_steps ?? []).filter(
                  (s) => s.kind !== 'script'
                );
              }
              setEditing(next);
            }}
          />
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded text-sm"
            >
              Save
            </button>
            <button
              onClick={() => { setEditing(null); setIsNew(false); setError(null); }}
              className="text-gray-400 hover:text-gray-200 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Install steps editor (shared by Repos tab)
// ---------------------------------------------------------------------------

function InstallStepsEditor({
  steps,
  allowScriptSteps,
  onChangeSteps,
  onChangeAllowScript,
}: {
  steps: InstallStep[];
  allowScriptSteps: boolean;
  onChangeSteps: (steps: InstallStep[]) => void;
  onChangeAllowScript: (allow: boolean) => void;
}) {
  function updateStep(idx: number, next: InstallStep) {
    const copy = [...steps];
    copy[idx] = next;
    onChangeSteps(copy);
  }
  function removeStep(idx: number) {
    onChangeSteps(steps.filter((_, i) => i !== idx));
  }
  function addStep(kind: InstallStepKind | 'script') {
    const next: InstallStep =
      kind === 'script' ? { kind: 'script', path: '' } : { kind };
    onChangeSteps([...steps, next]);
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">
        Install steps
        <span className="text-gray-500 font-normal">
          {' '}— run sequentially before the agent, under a shared cache lock
        </span>
      </label>
      {steps.length === 0 && (
        <p className="text-xs text-gray-500">
          No install steps configured. The agent will start without dependency install.
        </p>
      )}
      {steps.map((step, i) => (
        <div
          key={i}
          className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded p-2"
        >
          <select
            value={step.kind}
            onChange={(e) => {
              const newKind = e.target.value as InstallStepKind | 'script';
              if (newKind === 'script') {
                updateStep(i, { kind: 'script', path: (step as { path?: string }).path ?? '', cwd: step.cwd });
              } else {
                updateStep(i, { kind: newKind, cwd: step.cwd });
              }
            }}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono w-56 shrink-0"
          >
            {INSTALL_STEP_KINDS.map((k) => (
              <option key={k} value={k}>{INSTALL_STEP_LABELS[k]}</option>
            ))}
            {allowScriptSteps && (
              <option value="script">script (custom)</option>
            )}
          </select>
          {step.kind === 'script' && (
            <input
              type="text"
              value={(step as { path: string }).path}
              onChange={(e) => updateStep(i, { ...step, path: e.target.value })}
              placeholder="scripts/setup.sh (relative to cwd)"
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
            />
          )}
          <input
            type="text"
            value={step.cwd ?? ''}
            onChange={(e) => updateStep(i, { ...step, cwd: e.target.value || undefined })}
            placeholder="cwd (relative to /repo, optional)"
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
          />
          <button
            type="button"
            onClick={() => removeStep(i)}
            className="text-red-400 hover:text-red-300 px-2 text-sm"
            title="Remove step"
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            addStep(e.target.value as InstallStepKind | 'script');
            e.target.value = '';
          }}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
        >
          <option value="">+ Add install step…</option>
          {INSTALL_STEP_KINDS.map((k) => (
            <option key={k} value={k}>{INSTALL_STEP_LABELS[k]}</option>
          ))}
          {allowScriptSteps && (
            <option value="script">script (custom)</option>
          )}
        </select>
      </div>
      <div className="pt-2">
        <label className="flex items-start gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={allowScriptSteps}
            onChange={(e) => onChangeAllowScript(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Allow custom setup scripts for this repo</span>
            <span className="text-gray-500 block">
              Lets you add a <span className="font-mono">script</span>-kind step that
              runs <span className="font-mono">bash &lt;path&gt;</span> from inside the
              repo. The script inherits the agent container's environment.
              Anyone who can commit to this repo can change what runs.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers & Models tab
// ---------------------------------------------------------------------------

function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  const [kinds, setKinds] = useState<ProviderKindSpec[]>([]);
  const [editing, setEditing] = useState<Partial<ProviderResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh(): void {
    api.getProviders().then((r) => setProviders(r.providers)).catch(() => {});
  }

  useEffect(() => {
    refresh();
    api.getProviderKinds().then((r) => setKinds(r.kinds)).catch(() => {});
  }, []);

  function startCreate(): void {
    setEditing({
      id: '',
      display_name: '',
      kind: 'anthropic',
      concurrency_limit: 5,
      base_url: null,
      auth_token: null,
      api_key_env_var: 'ANTHROPIC_API_KEY',
      notes: null,
    });
    setIsNew(true);
    setError(null);
  }

  function startEdit(p: ProviderResponse): void {
    setEditing({ ...p });
    setIsNew(false);
    setError(null);
  }

  async function handleSave(): Promise<void> {
    if (!editing) return;
    setError(null);
    try {
      if (isNew) {
        await api.createProvider(editing);
      } else {
        await api.updateProvider(editing.id!, {
          display_name: editing.display_name,
          kind: editing.kind,
          concurrency_limit: editing.concurrency_limit,
          base_url: editing.base_url,
          auth_token: editing.auth_token,
          api_key_env_var: editing.api_key_env_var,
          notes: editing.notes,
        });
      }
      setEditing(null);
      setIsNew(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm(`Delete provider ${id}?`)) return;
    setError(null);
    try {
      await api.deleteProvider(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const editingKindSpec = editing?.kind
    ? kinds.find((k) => k.kind === editing.kind)
    : undefined;

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-400">
        Providers carry the connection identity for an LLM endpoint: kind, URL
        (for self-hosted), and credential. Each provider has its own
        concurrency limit. Cloud kinds (Anthropic, OpenAI…) are typically
        singletons with the API key in the orchestrator's <span className="font-mono">.env</span>.
        Self-hosted (Ollama) can have multiple instances with different URLs.
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm rounded px-3 py-2">
          {error}
        </div>
      )}

      {providers.length === 0 && !editing ? (
        <p className="text-gray-500 text-sm">No providers configured.</p>
      ) : (
        providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            kinds={kinds}
            expanded={expandedId === p.id}
            onExpand={() => setExpandedId(expandedId === p.id ? null : p.id)}
            onEdit={() => startEdit(p)}
            onDelete={() => handleDelete(p.id)}
          />
        ))
      )}

      <button
        onClick={startCreate}
        className="text-sm text-blue-400 hover:text-blue-300"
      >
        + Add provider
      </button>

      {editing && editingKindSpec && (
        <div className="bg-gray-900 border border-gray-700 rounded p-4 space-y-4 mt-4">
          <h3 className="font-medium">
            {isNew ? 'Add Provider' : `Edit ${editing.display_name}`}
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">ID</label>
              <input
                value={editing.id ?? ''}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                disabled={!isNew}
                placeholder="e.g. ollama-gpu"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm disabled:text-gray-500"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Display name</label>
              <input
                value={editing.display_name ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, display_name: e.target.value })
                }
                placeholder="e.g. Ollama (GPU box)"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm mb-1">Kind</label>
              <select
                value={editing.kind ?? 'anthropic'}
                onChange={(e) => {
                  const newKind = e.target.value as ProviderKind;
                  const spec = kinds.find((k) => k.kind === newKind);
                  setEditing({
                    ...editing,
                    kind: newKind,
                    // Reset auth fields to the new kind's defaults when
                    // switching, so an operator doesn't accidentally save an
                    // anthropic provider with an ollama URL.
                    base_url: spec?.requires_base_url ? editing.base_url ?? '' : null,
                    api_key_env_var: spec?.container_env_name ?? null,
                    auth_token: null,
                  });
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                {kinds.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.display_name}
                  </option>
                ))}
              </select>
              {editingKindSpec && (
                <p className="text-xs text-gray-500 mt-1">{editingKindSpec.description}</p>
              )}
            </div>
            <div>
              <label className="block text-sm mb-1">
                Concurrency limit
                <span className="text-gray-500 font-normal"> — 0 pauses all profiles using this provider</span>
              </label>
              <input
                type="number"
                min={0}
                value={editing.concurrency_limit ?? 1}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    concurrency_limit: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            {editingKindSpec.requires_base_url && (
              <div>
                <label className="block text-sm mb-1">
                  Base URL <span className="text-red-400">*</span>
                </label>
                <input
                  value={editing.base_url ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, base_url: e.target.value })
                  }
                  placeholder="http://192.168.1.10:11434"
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </div>
            )}
            {editingKindSpec.container_env_name && (
              <div className="col-span-2">
                <label className="block text-sm mb-1">
                  API key env var
                  <span className="text-gray-500 font-normal">
                    {' '}— name of the env var on the orchestrator's host that holds the API key.
                    The orchestrator reads it at launch and exports the value into the agent
                    container as <span className="font-mono">{editingKindSpec.container_env_name}</span>.
                  </span>
                </label>
                <input
                  value={editing.api_key_env_var ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      api_key_env_var: e.target.value || null,
                    })
                  }
                  placeholder={editingKindSpec.container_env_name}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono"
                />
              </div>
            )}
            <div className="col-span-2">
              <label className="block text-sm mb-1">
                Auth token (inline)
                <span className="text-gray-500 font-normal">
                  {' '}— optional. For self-hosted servers with bearer auth, OR
                  for cloud kinds when you want to multi-instance without using
                  the env-var pointer above. Stored in the database as plaintext.
                </span>
              </label>
              <input
                type="password"
                value={editing.auth_token ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    auth_token: e.target.value || null,
                  })
                }
                placeholder={editingKindSpec.auth_optional ? '(optional)' : ''}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm mb-1">Notes (optional)</label>
            <textarea
              value={editing.notes ?? ''}
              onChange={(e) =>
                setEditing({ ...editing, notes: e.target.value || null })
              }
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm min-h-[60px]"
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded text-sm"
            >
              Save
            </button>
            <button
              onClick={() => {
                setEditing(null);
                setIsNew(false);
                setError(null);
              }}
              className="text-gray-400 hover:text-gray-200 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  kinds,
  expanded,
  onExpand,
  onEdit,
  onDelete,
}: {
  provider: ProviderResponse;
  kinds: ProviderKindSpec[];
  expanded: boolean;
  onExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const kindSpec = kinds.find((k) => k.kind === provider.kind);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-4">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-medium">{provider.display_name}</span>
          <span className="text-gray-500 text-sm ml-2">({provider.id})</span>
          <span className="text-gray-500 text-sm ml-3">
            kind: {kindSpec?.display_name ?? provider.kind}
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={
              provider.concurrency_limit === 0
                ? 'text-yellow-400'
                : provider.active_slots >= provider.concurrency_limit
                  ? 'text-orange-400'
                  : 'text-gray-300'
            }
            title={
              provider.concurrency_limit === 0
                ? 'Paused — no tasks launch'
                : `${provider.active_slots} active / ${provider.concurrency_limit} limit`
            }
          >
            {provider.active_slots}/{provider.concurrency_limit}
            {provider.concurrency_limit === 0 ? ' (paused)' : ''}
          </span>
          <span className="text-gray-500">
            {provider.models_count} model{provider.models_count === 1 ? '' : 's'}
          </span>
          <button
            onClick={onExpand}
            className="text-blue-400 hover:text-blue-300"
          >
            {expanded ? 'Collapse' : 'Models'}
          </button>
          <button
            onClick={onEdit}
            className="text-blue-400 hover:text-blue-300"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={provider.models_count > 0}
            className="text-red-400 hover:text-red-300 disabled:text-gray-600 disabled:cursor-not-allowed"
            title={
              provider.models_count > 0
                ? 'Delete or reassign the provider\'s models first'
                : 'Delete provider'
            }
          >
            Delete
          </button>
        </div>
      </div>
      {provider.notes && (
        <div className="mt-2 text-xs text-gray-500">{provider.notes}</div>
      )}
      {expanded && <ProviderModels providerId={provider.id} />}
    </div>
  );
}

function ProviderModels({ providerId }: { providerId: string }) {
  const [models, setModels] = useState<ModelResponse[]>([]);
  const [adding, setAdding] = useState(false);
  const [draftId, setDraftId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);

  function refresh(): void {
    api
      .getProviderModels(providerId)
      .then((r) => setModels(r.models))
      .catch(() => {});
  }
  useEffect(refresh, [providerId]);

  async function handleAdd(): Promise<void> {
    setError(null);
    try {
      await api.createModel(providerId, {
        model_id: draftId.trim(),
        display_name: draftName.trim(),
      });
      setDraftId('');
      setDraftName('');
      setAdding(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed');
    }
  }

  async function handleDelete(pk: number): Promise<void> {
    if (!window.confirm('Delete this model?')) return;
    setError(null);
    try {
      await api.deleteModel(pk);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="mt-4 border-t border-gray-800 pt-4">
      <h4 className="text-sm font-medium mb-2">Models</h4>
      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-200 text-xs rounded px-2 py-1 mb-2">
          {error}
        </div>
      )}
      {models.length === 0 ? (
        <p className="text-xs text-gray-500">No models configured.</p>
      ) : (
        <ul className="space-y-1 mb-2">
          {models.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between bg-gray-800 rounded px-3 py-1.5 text-xs"
            >
              <span>
                <span className="font-mono">{m.model_id}</span>
                <span className="text-gray-500 ml-2">{m.display_name}</span>
              </span>
              <button
                onClick={() => handleDelete(m.id)}
                className="text-red-400 hover:text-red-300"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="flex items-center gap-2 mt-2">
          <input
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            placeholder="model_id (e.g. claude-sonnet-4-6)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
          />
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="display name"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
          />
          <button
            onClick={handleAdd}
            disabled={!draftId.trim() || !draftName.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white px-3 py-1 rounded text-xs"
          >
            Add
          </button>
          <button
            onClick={() => {
              setAdding(false);
              setDraftId('');
              setDraftName('');
              setError(null);
            }}
            className="text-gray-400 hover:text-gray-200 px-2 text-xs"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          + Add model
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Profiles tab
// ---------------------------------------------------------------------------

function AgentProfileSettings() {
  const [profiles, setProfiles] = useState<AgentProfileResponse[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessSpec[]>([]);
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  const [allModels, setAllModels] = useState<Map<string, ModelResponse[]>>(new Map());
  const [editing, setEditing] = useState<Partial<AgentProfileResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh(): void {
    api.getAgentProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }

  useEffect(() => {
    refresh();
    api.getHarnesses().then((r) => setHarnesses(r.harnesses)).catch(() => {});
    api
      .getProviders()
      .then((r) => {
        setProviders(r.providers);
        // Pre-fetch each provider's models so the model picker is responsive.
        // Use allSettled so a 404 on a single provider (e.g. just deleted)
        // doesn't blank out the whole map — surviving entries still
        // populate the dropdown.
        Promise.allSettled(
          r.providers.map((p) =>
            api.getProviderModels(p.id).then((m) => [p.id, m.models] as const)
          )
        ).then((results) => {
          const entries = results
            .filter(
              (r): r is PromiseFulfilledResult<readonly [string, ModelResponse[]]> =>
                r.status === 'fulfilled'
            )
            .map((r) => r.value);
          setAllModels(new Map(entries));
        });
      })
      .catch(() => {});
  }, []);

  function startCreate(): void {
    setEditing({
      id: '',
      display_name: '',
      harness_id: 'claude-sdk',
      model_pk: 0,
      config_json: {},
      timeout_minutes: 120,
    });
    setIsNew(true);
    setError(null);
  }

  function startEdit(p: AgentProfileResponse): void {
    setEditing({ ...p });
    setIsNew(false);
    setError(null);
  }

  async function handleSave(): Promise<void> {
    if (!editing) return;
    setError(null);
    try {
      if (isNew) {
        await api.createAgentProfile(editing);
      } else {
        await api.updateAgentProfile(editing.id!, {
          display_name: editing.display_name,
          harness_id: editing.harness_id,
          model_pk: editing.model_pk,
          config_json: editing.config_json,
          timeout_minutes: editing.timeout_minutes,
        });
      }
      setEditing(null);
      setIsNew(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm(`Delete profile ${id}?`)) return;
    setError(null);
    try {
      await api.deleteAgentProfile(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const editingHarness = editing?.harness_id
    ? harnesses.find((h) => h.id === editing.harness_id)
    : undefined;

  // Build the model dropdown filtered by the chosen harness's supported
  // provider kinds. Show all models from supported providers; the harness
  // throws at launch time if the operator picks an unsupported pairing
  // (no save-time validation per E3 — but a hint helps).
  const modelOptions = providers
    .filter((p) =>
      editingHarness ? editingHarness.supported_provider_kinds.includes(p.kind) : true
    )
    .flatMap((p) => {
      const models = allModels.get(p.id) ?? [];
      return models.map((m) => ({ provider: p, model: m }));
    });

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-400">
        An agent profile pairs a harness (Claude SDK, Claude Code, OpenCode, Pi)
        with a specific model from one of your providers, plus any harness-
        specific configuration. Tasks reference profiles either directly
        (per-task override), or inherit from their repo's default, or fall
        back to the global default under <em>Global Settings</em>.
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm rounded px-3 py-2">
          {error}
        </div>
      )}

      {profiles.length === 0 && !editing ? (
        <p className="text-gray-500 text-sm">
          No agent profiles configured. Add one below.
        </p>
      ) : (
        profiles.map((p) => {
          const harness = harnesses.find((h) => h.id === p.harness_id);
          return (
            <div
              key={p.id}
              className="bg-gray-900 border border-gray-800 rounded p-4 flex items-center justify-between"
            >
              <div>
                <span className="font-medium">{p.display_name}</span>
                <span className="text-gray-500 text-sm ml-2">({p.id})</span>
                <div className="text-gray-500 text-xs mt-1">
                  {harness?.display_name ?? p.harness_id} ·{' '}
                  <span className="font-mono">
                    {p.provider_id}/{p.model_id}
                  </span>{' '}
                  · timeout {p.timeout_minutes}m · {p.repos_using} repo
                  {p.repos_using === 1 ? '' : 's'}, {p.tasks_using} task
                  {p.tasks_using === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <button
                  onClick={() => startEdit(p)}
                  className="text-blue-400 hover:text-blue-300"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(p.id)}
                  className="text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })
      )}

      <button
        onClick={startCreate}
        className="text-sm text-blue-400 hover:text-blue-300"
      >
        + Add agent profile
      </button>

      {editing && editingHarness && (
        <div className="bg-gray-900 border border-gray-700 rounded p-4 space-y-4 mt-4">
          <h3 className="font-medium">
            {isNew ? 'Add Agent Profile' : `Edit ${editing.display_name}`}
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">ID</label>
              <input
                value={editing.id ?? ''}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                disabled={!isNew}
                placeholder="e.g. claude-sdk-sonnet"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm disabled:text-gray-500"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Display name</label>
              <input
                value={editing.display_name ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, display_name: e.target.value })
                }
                placeholder="e.g. Claude SDK + Sonnet"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Harness</label>
              <select
                value={editing.harness_id ?? 'claude-sdk'}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    harness_id: e.target.value as HarnessId,
                    config_json: {}, // reset knobs when harness changes
                  })
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                {harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.display_name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Supports kinds: {editingHarness.supported_provider_kinds.join(', ')}
              </p>
            </div>
            <div>
              <label className="block text-sm mb-1">
                Timeout (minutes) <span className="text-red-400">*</span>
              </label>
              <input
                type="number"
                min={1}
                value={editing.timeout_minutes ?? 2880}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    timeout_minutes: parseInt(e.target.value, 10) || 1,
                  })
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm mb-1">
                Model
                <span className="text-gray-500 font-normal">
                  {' '}— filtered to providers compatible with this harness
                </span>
              </label>
              {modelOptions.length === 0 ? (
                <p className="text-xs text-yellow-400">
                  No models available for harness '{editingHarness.id}'. Add
                  models to a {editingHarness.supported_provider_kinds.join(' / ')}{' '}
                  provider under <em>Providers & Models</em>.
                </p>
              ) : (
                <select
                  value={editing.model_pk ?? 0}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      model_pk: parseInt(e.target.value, 10),
                    })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                >
                  <option value={0}>Select model…</option>
                  {modelOptions.map(({ provider, model }) => (
                    <option key={model.id} value={model.id}>
                      {provider.display_name} — {model.display_name} (
                      <span>{model.model_id}</span>)
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <HarnessConfigForm
            harnessId={editingHarness.id}
            config={editing.config_json ?? {}}
            onChange={(cfg) => setEditing({ ...editing, config_json: cfg })}
          />

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={!editing.model_pk}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white px-4 py-2 rounded text-sm"
            >
              Save
            </button>
            <button
              onClick={() => {
                setEditing(null);
                setIsNew(false);
                setError(null);
              }}
              className="text-gray-400 hover:text-gray-200 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Per-harness config form. Each harness has its own component matched
 *  by id. Empty for v1 harnesses with no operator-tunable knobs. */
function HarnessConfigForm({
  harnessId,
  config,
  onChange,
}: {
  harnessId: HarnessId;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  if (harnessId === 'claude-code') {
    const maxTurns = typeof config.max_turns === 'number' ? config.max_turns : 100;
    return (
      <div>
        <label className="block text-sm mb-1">
          max_turns
          <span className="text-gray-500 font-normal">
            {' '}— passed to <span className="font-mono">claude --max-turns N</span>
          </span>
        </label>
        <input
          type="number"
          min={1}
          value={maxTurns}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onChange({ ...config, max_turns: Number.isFinite(n) && n > 0 ? n : 100 });
          }}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
        />
      </div>
    );
  }
  // claude-sdk, opencode, pi: no operator-tunable knobs in v1.
  return (
    <p className="text-xs text-gray-500">
      No harness-specific configuration for {harnessId}.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Credentials tab
// ---------------------------------------------------------------------------

function CredentialSettings() {
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);

  useEffect(() => {
    api.getCredentials().then((r) => setCredentials(r.credentials)).catch(() => {});
  }, []);

  const orchestrator = credentials.filter((c) => c.scope === 'orchestrator');
  const provider = credentials.filter((c) => c.scope === 'provider');

  function row(cred: CredentialStatus) {
    return (
      <div
        key={`${cred.scope}-${cred.name}-${cred.provider_id ?? ''}`}
        className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded p-3"
      >
        <div>
          <span className="font-mono text-sm">{cred.name}</span>
          {cred.provider_id && (
            <span className="text-gray-500 text-xs ml-2">
              for provider <span className="font-mono">{cred.provider_id}</span>
            </span>
          )}
        </div>
        {cred.configured ? (
          <span className="text-green-400 text-sm">configured</span>
        ) : (
          <span className="text-red-400 text-sm">not set</span>
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
