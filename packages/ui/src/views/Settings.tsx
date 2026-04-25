import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type {
  RepoResponse,
  ToolResponse,
  CredentialStatus,
  ForgejoRepoResponse,
  ProviderResponse,
} from '../api.js';

const SAFE_SCRIPT_PATTERNS = [
  /^npm\s+(ci|install)$/,
  /^yarn\s+install$/,
  /^pnpm\s+install$/,
  /^pip\s+install\s+-r\s+\S+$/,
];

export function Settings() {
  const [tab, setTab] = useState<
    'global' | 'repos' | 'tools' | 'providers' | 'credentials'
  >('global');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900 px-6 py-4">
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
          {(['global', 'repos', 'tools', 'providers', 'credentials'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded text-sm capitalize ${tab === t ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {t === 'global'
                ? 'Global Settings'
                : t === 'repos'
                  ? 'Repositories'
                  : t === 'tools'
                    ? 'Agent Tools'
                    : t === 'providers'
                      ? 'Providers'
                      : 'Credentials'}
            </button>
          ))}
        </div>

        {tab === 'global' && <GlobalSettings />}
        {tab === 'repos' && <RepoSettings />}
        {tab === 'tools' && <ToolSettings />}
        {tab === 'providers' && <ProviderSettings />}
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
  const [availableRepos, setAvailableRepos] = useState<ForgejoRepoResponse[]>([]);
  const [editing, setEditing] = useState<Partial<RepoResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    api.getRepos().then((r) => setRepos(r.repos)).catch(() => {});
    api.getTools().then((r) => setTools(r.tools)).catch(() => {});
    api.getAvailableRepos().then((r) => setAvailableRepos(r.repos)).catch(() => {});
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
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  const [editing, setEditing] = useState<Partial<ToolResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [envVarsText, setEnvVarsText] = useState('{}');
  const [authConfigText, setAuthConfigText] = useState('{}');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    api.getTools().then((r) => setTools(r.tools)).catch(() => {});
    api.getProviders().then((r) => setProviders(r.providers)).catch(() => {});
  }, []);

  function startEdit(tool: ToolResponse) {
    setEditing({ ...tool });
    setEnvVarsText(JSON.stringify(tool.env_vars, null, 2));
    setAuthConfigText(JSON.stringify(tool.auth_config, null, 2));
    setIsNew(false);
  }

  function startCreate() {
    setEditing({ id: '', display_name: '', type: 'cli', command_template: '', auth_type: 'none', env_vars: {}, auth_config: {} });
    setEnvVarsText('{}');
    setAuthConfigText('{}');
    setIsNew(true);
  }

  async function handleSave() {
    if (!editing) return;
    setServerError(null);
    setErrors({});

    const newErrors: Record<string, string> = {};
    if (isNew && !editing.id) newErrors.id = 'This field is required';
    if (!editing.display_name) newErrors.display_name = 'This field is required';
    if (!editing.command_template) newErrors.command_template = 'This field is required';

    try {
      JSON.parse(envVarsText);
    } catch {
      newErrors.env_vars = 'Invalid JSON';
    }
    try {
      JSON.parse(authConfigText);
    } catch {
      newErrors.auth_config = 'Invalid JSON';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    let envVars: Record<string, string>;
    let authConfig: Record<string, unknown>;
    try {
      envVars = JSON.parse(envVarsText);
      authConfig = JSON.parse(authConfigText);
    } catch {
      return;
    }

    const payload = { ...editing, env_vars: envVars, auth_config: authConfig };
    try {
      if (isNew) {
        const tool = await api.createTool(payload);
        setTools((prev) => [...prev, tool]);
      } else {
        const tool = await api.updateTool(editing.id!, payload);
        setTools((prev) => prev.map((t) => (t.id === tool.id ? tool : t)));
      }
      setEditing(null);
      setIsNew(false);
    } catch (e: any) {
      setServerError(e.message || 'An unexpected error occurred');
    }
  }

  const statusColors: Record<string, string> = {
    configured: 'text-green-400',
    missing: 'text-red-400',
    'not required': 'text-gray-400',
  };

  return (
    <div className="space-y-4">
      {tools.length === 0 && !editing ? (
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
              <div className="flex items-center gap-3">
                <span className={`text-sm ${statusColors[tool.auth_status] ?? 'text-gray-400'}`}>
                  {tool.auth_status}
                </span>
                <button
                  onClick={() => startEdit(tool)}
                  className="text-sm text-blue-400 hover:text-blue-300"
                >
                  Edit
                </button>
              </div>
            </div>
            {tool.command_template && (
              <div className="mt-2 text-xs font-mono text-gray-400 truncate">
                {tool.command_template}
              </div>
            )}
            {Object.keys(tool.env_vars).length > 0 && (
              <div className="mt-2 text-xs text-gray-500">
                Env: {Object.entries(tool.env_vars).map(([k, v]) => `${k}=${v}`).join(', ')}
              </div>
            )}
          </div>
        ))
      )}

      <button
        onClick={startCreate}
        className="text-sm text-blue-400 hover:text-blue-300"
      >
        + Add tool
      </button>

      {editing && (
        <div className="bg-gray-900 border border-gray-700 rounded p-4 space-y-4 mt-4">
           <h3 className="font-medium">
             {isNew ? 'Add Agent Tool' : `Edit ${editing.display_name}`}
           </h3>
           {serverError && (
             <div className="bg-red-900/50 border border-red-700 text-red-200 px-3 py-2 rounded text-sm">
               {serverError}
             </div>
           )}
           <div className="grid grid-cols-2 gap-4">

            <div>
              <label className="block text-sm mb-1">ID</label>
               <input
                 value={editing.id ?? ''}
                 onChange={(e) => {
                   setEditing({ ...editing, id: e.target.value });
                   if (errors.id) setErrors({ ...errors, id: '' });
                 }}
                 disabled={!isNew}
                 placeholder="e.g. opencode-local"
                 className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm disabled:text-gray-500 ${
                   errors.id ? 'border-red-500' : 'border-gray-700'
                 }`}
               />
               {errors.id && <p className="text-red-500 text-xs mt-1">{errors.id}</p>}

            </div>
            <div>
              <label className="block text-sm mb-1">Display name</label>
               <input
                 value={editing.display_name ?? ''}
                 onChange={(e) => {
                   setEditing({ ...editing, display_name: e.target.value });
                   if (errors.display_name) setErrors({ ...errors, display_name: '' });
                 }}
                 placeholder="e.g. OpenCode (Local LLM)"
                 className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm ${
                   errors.display_name ? 'border-red-500' : 'border-gray-700'
                 }`}
               />
               {errors.display_name && <p className="text-red-500 text-xs mt-1">{errors.display_name}</p>}

            </div>
            <div>
              <label className="block text-sm mb-1">Type</label>
              <select
                value={editing.type ?? 'cli'}
                onChange={(e) => setEditing({ ...editing, type: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="cli">cli</option>
                <option value="sdk">sdk</option>
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">Auth type</label>
              <select
                value={editing.auth_type ?? 'none'}
                onChange={(e) => setEditing({ ...editing, auth_type: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="none">none</option>
                <option value="api-key">api-key</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-sm mb-1">
                Timeout override (minutes)
                <span className="text-gray-500 font-normal"> — blank = use repo/global default</span>
              </label>
              <input
                type="number"
                min={1}
                value={editing.timeout_minutes ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    timeout_minutes: e.target.value ? parseInt(e.target.value, 10) : null,
                  })
                }
                placeholder="e.g. 2880 for 48h on a free/local tool"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm mb-1">
                Provider (concurrency pool)
                <span className="text-gray-500 font-normal"> — optional; tools sharing a provider serialise against its limit</span>
              </label>
              <select
                value={editing.provider_id ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    provider_id: e.target.value || null,
                  })
                }
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              >
                <option value="">No provider (use global max_concurrency only)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name} (limit {p.concurrency_limit})
                  </option>
                ))}
              </select>
              {providers.length === 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  No providers configured yet. Add one under the Providers tab
                  to pool this tool with others.
                </p>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm mb-1">Command template</label>
               <input
                 value={editing.command_template ?? ''}
                 onChange={(e) => {
                   setEditing({ ...editing, command_template: e.target.value });
                   if (errors.command_template) setErrors({ ...errors, command_template: '' });
                 }}
                 placeholder='e.g. opencode run --non-interactive --prompt "${TASK_PROMPT}"'
                 className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm font-mono ${
                   errors.command_template ? 'border-red-500' : 'border-gray-700'
                 }`}
               />
               {errors.command_template && <p className="text-red-500 text-xs mt-1">{errors.command_template}</p>}

          </div>
          <div>
            <label className="block text-sm mb-1">Environment variables (JSON)</label>
               <textarea
                 value={envVarsText}
                 onChange={(e) => {
                   setEnvVarsText(e.target.value);
                   if (errors.env_vars) setErrors({ ...errors, env_vars: '' });
                 }}
                 placeholder='{"OPENCODE_BASE_URL": "http://192.168.1.50:8080/v1"}'
                 className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm font-mono min-h-[80px] ${
                   errors.env_vars ? 'border-red-500' : 'border-gray-700'
                 }`}
               />
               {errors.env_vars && <p className="text-red-500 text-xs mt-1">{errors.env_vars}</p>}

          </div>
          <div>
            <label className="block text-sm mb-1">Auth config (JSON)</label>
               <textarea
                 value={authConfigText}
                 onChange={(e) => {
                   setAuthConfigText(e.target.value);
                   if (errors.auth_config) setErrors({ ...errors, auth_config: '' });
                 }}
                 placeholder='{"env_var": "OPENCODE_API_KEY", "optional": true}'
                 className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm font-mono min-h-[60px] ${
                   errors.auth_config ? 'border-red-500' : 'border-gray-700'
                 }`}
               />
               {errors.auth_config && <p className="text-red-500 text-xs mt-1">{errors.auth_config}</p>}

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

// ---------------------------------------------------------------------------
// Providers — concurrency-pool management
// ---------------------------------------------------------------------------

function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  const [editing, setEditing] = useState<Partial<ProviderResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh(): void {
    api.getProviders().then((r) => setProviders(r.providers)).catch(() => {});
  }
  useEffect(refresh, []);

  function startCreate(): void {
    setEditing({ id: '', display_name: '', concurrency_limit: 1, notes: '' });
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
          concurrency_limit: editing.concurrency_limit,
          notes: editing.notes,
        });
      }
      setEditing(null);
      setIsNew(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm(`Delete provider ${id}?`)) return;
    setError(null);
    try {
      await api.deleteProvider(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-400">
        Providers define concurrency pools. Tools assigned to the same provider
        serialise against its <span className="font-mono">concurrency_limit</span>;
        tools on different providers run in parallel. Tools with no provider
        count against the global <span className="font-mono">max_concurrency</span>{' '}
        only. Set <span className="font-mono">concurrency_limit: 0</span> to
        pause a provider (its tools won't launch until raised).
      </div>

      {providers.length === 0 && !editing ? (
        <p className="text-gray-500 text-sm">
          No providers configured. Tools with no assigned provider share the
          global pool.
        </p>
      ) : (
        providers.map((p) => (
          <div
            key={p.id}
            className="bg-gray-900 border border-gray-800 rounded p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{p.display_name}</span>
                <span className="text-gray-500 text-sm ml-2">({p.id})</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span
                  className={
                    p.concurrency_limit === 0
                      ? 'text-yellow-400'
                      : p.active_slots >= p.concurrency_limit
                        ? 'text-orange-400'
                        : 'text-gray-300'
                  }
                  title={
                    p.concurrency_limit === 0
                      ? 'Paused — no tasks launch'
                      : `${p.active_slots} active / ${p.concurrency_limit} limit`
                  }
                >
                  {p.active_slots}/{p.concurrency_limit}
                  {p.concurrency_limit === 0 ? ' (paused)' : ''}
                </span>
                <span className="text-gray-500">
                  {p.tools_using} tool{p.tools_using === 1 ? '' : 's'}
                </span>
                <button
                  onClick={() => startEdit(p)}
                  className="text-blue-400 hover:text-blue-300"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(p.id)}
                  disabled={p.tools_using > 0}
                  className="text-red-400 hover:text-red-300 disabled:text-gray-600 disabled:cursor-not-allowed"
                  title={
                    p.tools_using > 0
                      ? 'Reassign the tools using this provider first'
                      : 'Delete provider'
                  }
                >
                  Delete
                </button>
              </div>
            </div>
            {p.notes && (
              <div className="mt-2 text-xs text-gray-500">{p.notes}</div>
            )}
          </div>
        ))
      )}

      <button
        onClick={startCreate}
        className="text-sm text-blue-400 hover:text-blue-300"
      >
        + Add provider
      </button>

      {editing && (
        <div className="bg-gray-900 border border-gray-700 rounded p-4 space-y-4 mt-4">
          <h3 className="font-medium">
            {isNew ? 'Add Provider' : `Edit ${editing.display_name}`}
          </h3>
          {error && (
            <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm rounded px-3 py-2">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">ID</label>
              <input
                value={editing.id ?? ''}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                disabled={!isNew}
                placeholder="e.g. ollama-local"
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
                placeholder="e.g. Ollama (local)"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1">
                Concurrency limit
                <span className="text-gray-500 font-normal"> — 0 pauses all assigned tools</span>
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
          </div>
          <div>
            <label className="block text-sm mb-1">Notes (optional)</label>
            <textarea
              value={editing.notes ?? ''}
              onChange={(e) =>
                setEditing({ ...editing, notes: e.target.value })
              }
              placeholder="e.g. Ollama 0.11 on the GPU box, OLLAMA_NUM_PARALLEL=1"
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
