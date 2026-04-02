import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { RepoResponse, ToolResponse, CredentialStatus } from '../api.js';

const SAFE_SCRIPT_PATTERNS = [
  /^npm\s+(ci|install)$/,
  /^yarn\s+install$/,
  /^pnpm\s+install$/,
  /^pip\s+install\s+-r\s+\S+$/,
];

export function Settings() {
  const [tab, setTab] = useState<'global' | 'repos' | 'tools' | 'credentials'>('global');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm">
          &larr; Dashboard
        </Link>
        <h1 className="text-xl font-semibold mt-1">Settings</h1>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-6">
        <div className="flex gap-1 mb-6 bg-gray-900 rounded-lg p-1 w-fit">
          {(['global', 'repos', 'tools', 'credentials'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded text-sm capitalize ${tab === t ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {t === 'global' ? 'Global Settings' : t === 'repos' ? 'Repositories' : t === 'tools' ? 'Agent Tools' : 'Credentials'}
            </button>
          ))}
        </div>

        {tab === 'global' && <GlobalSettings />}
        {tab === 'repos' && <RepoSettings />}
        {tab === 'tools' && <ToolSettings />}
        {tab === 'credentials' && <CredentialSettings />}
      </main>
    </div>
  );
}

function GlobalSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await api.updateSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Error
    } finally {
      setSaving(false);
    }
  }

  function update(key: string, value: unknown) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  const fields: Array<{ key: string; label: string; type: 'number' | 'text' | 'select'; options?: string[] }> = [
    { key: 'max_concurrency', label: 'Max concurrent agents', type: 'number' },
    { key: 'default_max_attempts', label: 'Default max attempts', type: 'number' },
    { key: 'agent_timeout_minutes', label: 'Agent timeout (minutes)', type: 'number' },
    { key: 'default_max_turns', label: 'Default max turns', type: 'number' },
    { key: 'default_model', label: 'Default model', type: 'text' },
    { key: 'poll_interval_seconds', label: 'Poll interval (seconds)', type: 'number' },
    { key: 'merge_strategy', label: 'Merge strategy', type: 'select', options: ['squash', 'merge', 'rebase'] },
    { key: 'workspace_retention_days', label: 'Workspace retention (days)', type: 'number' },
    { key: 'default_container_memory_mb', label: 'Container memory (MB)', type: 'number' },
    { key: 'default_container_cpu_cores', label: 'Container CPU cores', type: 'number' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="block text-sm font-medium mb-1">{f.label}</label>
            {f.type === 'select' ? (
              <select
                value={String(settings[f.key] ?? '')}
                onChange={(e) => update(f.key, e.target.value)}
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                {f.options?.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                type={f.type}
                value={String(settings[f.key] ?? '')}
                onChange={(e) =>
                  update(f.key, f.type === 'number' ? parseInt(e.target.value, 10) || 0 : e.target.value)
                }
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            )}
          </div>
        ))}
      </div>

      {/* Model pricing */}
      <div>
        <label className="block text-sm font-medium mb-1">Model Pricing (JSON)</label>
        <textarea
          value={
            typeof settings.model_pricing === 'object'
              ? JSON.stringify(settings.model_pricing, null, 2)
              : String(settings.model_pricing ?? '{}')
          }
          onChange={(e) => {
            try {
              update('model_pricing', JSON.parse(e.target.value));
            } catch {
              // Keep invalid JSON as string until valid
            }
          }}
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono min-h-[100px]"
        />
      </div>

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

function RepoSettings() {
  const [repos, setRepos] = useState<RepoResponse[]>([]);
  const [tools, setTools] = useState<ToolResponse[]>([]);
  const [editing, setEditing] = useState<Partial<RepoResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    api.getRepos().then((r) => setRepos(r.repos)).catch(() => {});
    api.getTools().then((r) => setTools(r.tools)).catch(() => {});
  }, []);

  async function handleSave() {
    if (!editing) return;
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
    } catch {
      // Error
    }
  }

  const scriptWarning =
    editing?.pre_agent_script &&
    !SAFE_SCRIPT_PATTERNS.some((p) => p.test(editing.pre_agent_script!));

  return (
    <div className="space-y-4">
      {repos.map((repo) => (
        <div
          key={repo.id}
          className="bg-gray-900 border border-gray-800 rounded p-4 flex items-center justify-between"
        >
          <div>
            <span className="font-medium">
              {repo.owner}/{repo.name}
            </span>
            <span className="text-gray-500 text-sm ml-3">
              {repo.image_type} / {repo.agent_tool}
            </span>
          </div>
          <button
            onClick={() => { setEditing({ ...repo }); setIsNew(false); }}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            Edit
          </button>
        </div>
      ))}

      <button
        onClick={() => {
          setEditing({ base_branch: 'main', image_type: 'node', agent_tool: '' });
          setIsNew(true);
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
          <div className="grid grid-cols-2 gap-4">
            {isNew && (
              <>
                <div>
                  <label className="block text-sm mb-1">Owner</label>
                  <input
                    value={editing.owner ?? ''}
                    onChange={(e) => setEditing({ ...editing, owner: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1">Name</label>
                  <input
                    value={editing.name ?? ''}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
                  />
                </div>
              </>
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
              <label className="block text-sm mb-1">Image type</label>
              <select
                value={editing.image_type ?? 'node'}
                onChange={(e) => setEditing({ ...editing, image_type: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="node">node</option>
                <option value="python">python</option>
                <option value="go">go</option>
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">Agent tool</label>
              <select
                value={editing.agent_tool ?? ''}
                onChange={(e) => setEditing({ ...editing, agent_tool: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="">Select...</option>
                {tools.map((t) => (
                  <option key={t.id} value={t.id}>{t.display_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">Model override</label>
              <input
                value={editing.model ?? ''}
                onChange={(e) => setEditing({ ...editing, model: e.target.value || null })}
                placeholder="Use global default"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Timeout (minutes)</label>
              <input
                type="number"
                value={editing.timeout_minutes ?? ''}
                onChange={(e) => setEditing({ ...editing, timeout_minutes: e.target.value ? parseInt(e.target.value, 10) : null })}
                placeholder="Use global default"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Max turns</label>
              <input
                type="number"
                value={editing.max_turns ?? ''}
                onChange={(e) => setEditing({ ...editing, max_turns: e.target.value ? parseInt(e.target.value, 10) : null })}
                placeholder="Use global default"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
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
          </div>
          <div>
            <label className="block text-sm mb-1">Pre-agent script</label>
            <input
              value={editing.pre_agent_script ?? ''}
              onChange={(e) => setEditing({ ...editing, pre_agent_script: e.target.value || null })}
              placeholder="e.g. npm ci"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
            />
            {scriptWarning && (
              <p className="text-yellow-400 text-xs mt-1">
                This command doesn't match a common dependency install pattern. It will run with
                full shell access inside agent containers, including access to environment variables
                (API keys).
              </p>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded text-sm"
            >
              Save
            </button>
            <button
              onClick={() => { setEditing(null); setIsNew(false); }}
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

function ToolSettings() {
  const [tools, setTools] = useState<ToolResponse[]>([]);

  useEffect(() => {
    api.getTools().then((r) => setTools(r.tools)).catch(() => {});
  }, []);

  const statusColors: Record<string, string> = {
    configured: 'text-green-400',
    missing: 'text-red-400',
    'not required': 'text-gray-400',
  };

  return (
    <div className="space-y-4">
      {tools.length === 0 ? (
        <p className="text-gray-500 text-sm">No agent tools configured</p>
      ) : (
        tools.map((tool) => (
          <div
            key={tool.id}
            className="bg-gray-900 border border-gray-800 rounded p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{tool.display_name}</span>
                <span className="text-gray-500 text-sm ml-2">({tool.id})</span>
                <span className="text-gray-500 text-sm ml-2">
                  Type: {tool.type}
                </span>
              </div>
              <span className={`text-sm ${statusColors[tool.auth_status] ?? 'text-gray-400'}`}>
                {tool.auth_status}
              </span>
            </div>
            {tool.command_template && (
              <div className="mt-2 text-xs font-mono text-gray-400 truncate">
                {tool.command_template}
              </div>
            )}
            {Object.keys(tool.env_vars).length > 0 && (
              <div className="mt-2 text-xs text-gray-500">
                Env: {Object.keys(tool.env_vars).join(', ')}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function CredentialSettings() {
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);

  useEffect(() => {
    api.getCredentials().then((r) => setCredentials(r.credentials)).catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Credentials are loaded from environment variables. To update, modify the
        .env file and restart the orchestrator.
      </p>
      {credentials.length === 0 ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : (
        <div className="space-y-2">
          {credentials.map((cred) => (
            <div
              key={cred.name}
              className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded p-3"
            >
              <span className="font-mono text-sm">{cred.name}</span>
              {cred.configured ? (
                <span className="text-green-400 text-sm">configured</span>
              ) : (
                <span className="text-red-400 text-sm">not set</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
