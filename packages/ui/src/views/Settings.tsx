import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type {
  RepoResponse,
  ToolResponse,
  CredentialStatus,
  ForgejoRepoResponse,
  ProviderResponse,
  HostCapacityResponse,
  InstallStep,
  InstallStepKind,
} from '../api.js';
import { INSTALL_STEP_LABELS } from '../api.js';
import { TEMPLATES } from '../configTemplates.js';

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

export function Settings() {
  const [tab, setTab] = useState<
    'global' | 'repos' | 'tools' | 'providers' | 'credentials'
  >('global');

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
  const [capacity, setCapacity] = useState<HostCapacityResponse | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
    api.getHostCapacity().then(setCapacity).catch(() => {});
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
        <div>
          <label className="block text-sm font-medium mb-1">Default model</label>
          <input
            type="text"
            value={String(settings.default_model ?? '')}
            onChange={(e) => update('default_model', e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          />
        </div>
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
              {repo.agent_tool}
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
          setEditing({
            base_branch: 'main',
            agent_tool: '',
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
              // Disabling the toggle should also strip any script-kind steps
              // so a save can't fail validation against a stale gate.
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
      kind === 'script'
        ? { kind: 'script', path: '' }
        : { kind };
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
              repo. The script inherits the agent container's environment, including
              forwarded provider keys (<span className="font-mono">ANTHROPIC_API_KEY</span>,
              <span className="font-mono"> FORGEJO_AGENT_TOKEN</span>, etc.). Anyone
              who can commit to this repo can change what runs.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

interface CustomEnvRow {
  key: string;
  value: string;
}

function ToolSettings() {
  const [tools, setTools] = useState<ToolResponse[]>([]);
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [editing, setEditing] = useState<Partial<ToolResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  // Per-tool env_vars split into two views the operator interacts with:
  //  - overrides: known FORWARDED_KEYS the operator can set per-tool
  //  - custom: arbitrary extras (KEY/VALUE rows)
  // We re-merge them into a single flat object on save.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [customEnv, setCustomEnv] = useState<CustomEnvRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    api.getTools().then((r) => setTools(r.tools)).catch(() => {});
    api.getProviders().then((r) => setProviders(r.providers)).catch(() => {});
    api.getCredentials().then((r) => setCredentials(r.credentials)).catch(() => {});
  }, []);

  const forwardedKeys = credentials.filter((c) => c.scope === 'forwarded');

  function loadEnvIntoForm(envVars: Record<string, string>) {
    const forwarded = new Set(forwardedKeys.map((c) => c.name));
    const o: Record<string, string> = {};
    const c: CustomEnvRow[] = [];
    for (const [k, v] of Object.entries(envVars ?? {})) {
      if (forwarded.has(k)) o[k] = v;
      else c.push({ key: k, value: v });
    }
    setOverrides(o);
    setCustomEnv(c);
  }

  function startEdit(tool: ToolResponse) {
    setEditing({ ...tool });
    loadEnvIntoForm(tool.env_vars);
    setErrors({});
    setServerError(null);
    setIsNew(false);
  }

  function startCreate() {
    setEditing({
      id: '',
      display_name: '',
      type: 'cli',
      command_template: '',
      env_vars: {},
      config_file_path: null,
      config_file_content: null,
      // 48 h pre-fill — operators are expected to type their actual budget
      // (typically 120 min for paid APIs, 2880 for free local servers).
      // The field is required; null/blank fails save.
      timeout_minutes: 2880,
    });
    setOverrides({});
    setCustomEnv([]);
    setErrors({});
    setServerError(null);
    setIsNew(true);
  }

  function applyTemplate(templateId: string) {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!editing || !tpl) return;
    setEditing({
      ...editing,
      config_file_path: tpl.path || null,
      config_file_content: tpl.content || null,
    });
  }

  function buildEnvVarsObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (v.trim() !== '') out[k] = v;
    }
    for (const row of customEnv) {
      if (row.key.trim() === '') continue;
      out[row.key] = row.value;
    }
    return out;
  }

  async function handleSave() {
    if (!editing) return;
    setServerError(null);
    setErrors({});

    const newErrors: Record<string, string> = {};
    if (isNew && !editing.id) newErrors.id = 'This field is required';
    if (!editing.display_name) newErrors.display_name = 'This field is required';
    if (!editing.command_template) newErrors.command_template = 'This field is required';
    if (
      typeof editing.timeout_minutes !== 'number' ||
      !Number.isInteger(editing.timeout_minutes) ||
      editing.timeout_minutes < 1
    ) {
      newErrors.timeout_minutes = 'Required: a positive integer (minutes)';
    }

    const path = editing.config_file_path?.trim() ?? '';
    const content = editing.config_file_content ?? '';
    if (path && !content) {
      newErrors.config_file = 'Config file path is set but content is empty';
    }
    if (!path && content) {
      newErrors.config_file = 'Config file content is set but path is empty';
    }
    if (path.startsWith('/')) {
      newErrors.config_file = 'Path must be relative (anchored under /repo)';
    } else if (path.split(/[\\/]/).includes('..')) {
      newErrors.config_file = 'Path must not contain ".."';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const envVars = buildEnvVarsObject();
    const payload = {
      ...editing,
      env_vars: envVars,
      config_file_path: path || null,
      config_file_content: content || null,
    };
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
            <div className="col-span-2">
              <label className="block text-sm mb-1">
                Timeout (minutes)
                <span className="text-red-400 ml-0.5">*</span>
                <span className="text-gray-500 font-normal"> — required; typical: 120 (2h) for paid APIs, 2880 (48h) for free local servers</span>
              </label>
              <input
                type="number"
                min={1}
                value={editing.timeout_minutes ?? ''}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  setEditing({
                    ...editing,
                    timeout_minutes: Number.isFinite(n) && n > 0 ? n : (undefined as any),
                  });
                  if (errors.timeout_minutes) setErrors({ ...errors, timeout_minutes: '' });
                }}
                placeholder="2880"
                className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm ${
                  errors.timeout_minutes ? 'border-red-500' : 'border-gray-700'
                }`}
              />
              {errors.timeout_minutes && (
                <p className="text-red-500 text-xs mt-1">{errors.timeout_minutes}</p>
              )}
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
                <option value="">No provider (counts only against host resource pool)</option>
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
                 placeholder='e.g. opencode run "$(cat {{PROMPT_FILE}})" --non-interactive'
                 className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm font-mono ${
                   errors.command_template ? 'border-red-500' : 'border-gray-700'
                 }`}
               />
               {errors.command_template && <p className="text-red-500 text-xs mt-1">{errors.command_template}</p>}

          </div>
          {/* Provider credential overrides — per-tool overrides of FORWARDED_KEYS
              defaults set in the orchestrator's .env. Stored in the DB. */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Provider credential overrides
              <span className="text-gray-500 font-normal"> — leave blank to use the orchestrator's .env value</span>
            </label>
            <p className="text-xs text-yellow-500/80 mb-2">
              Values typed here are stored in the database. Use only when this tool needs a different key/token than the orchestrator default.
            </p>
            {forwardedKeys.length === 0 && (
              <p className="text-xs text-gray-500">
                Loading credential list...
              </p>
            )}
            {forwardedKeys.map((key) => (
              <div key={key.name} className="flex items-center gap-2 mb-1.5">
                <span className="font-mono text-xs text-gray-300 w-56 shrink-0">
                  {key.name}
                </span>
                <input
                  type="text"
                  value={overrides[key.name] ?? ''}
                  onChange={(e) =>
                    setOverrides({ ...overrides, [key.name]: e.target.value })
                  }
                  placeholder={
                    key.configured
                      ? 'using .env value'
                      : 'not set in .env — override required for this tool to use it'
                  }
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
              </div>
            ))}
          </div>

          {/* Other env vars — arbitrary KEY=VALUE pairs forwarded into the
              container in addition to the FORWARDED_KEYS defaults. */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Other environment variables
              <span className="text-gray-500 font-normal"> — anything outside the standard provider keys</span>
            </label>
            {customEnv.map((row, i) => (
              <div key={i} className="flex items-center gap-2 mb-1.5">
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => {
                    const next = [...customEnv];
                    next[i] = { ...next[i], key: e.target.value };
                    setCustomEnv(next);
                  }}
                  placeholder="KEY"
                  className="w-56 shrink-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
                <input
                  type="text"
                  value={row.value}
                  onChange={(e) => {
                    const next = [...customEnv];
                    next[i] = { ...next[i], value: e.target.value };
                    setCustomEnv(next);
                  }}
                  placeholder="value"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={() =>
                    setCustomEnv(customEnv.filter((_, idx) => idx !== i))
                  }
                  className="text-red-400 hover:text-red-300 px-2 text-sm"
                  title="Remove row"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCustomEnv([...customEnv, { key: '', value: '' }])}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              + Add row
            </button>
          </div>

          {/* Config file — drop a file into /repo before the agent runs.
              Used by tools (e.g. OpenCode) that read structured config from
              a file rather than env vars. */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Config file
              <span className="text-gray-500 font-normal"> — optional; written to /repo/&lt;path&gt; before the agent starts</span>
            </label>
            <div className="mb-2">
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) applyTemplate(e.target.value);
                  e.target.value = '';
                }}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
              >
                <option value="">Apply starter template…</option>
                {TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              value={editing.config_file_path ?? ''}
              onChange={(e) => {
                setEditing({ ...editing, config_file_path: e.target.value });
                if (errors.config_file) setErrors({ ...errors, config_file: '' });
              }}
              placeholder="e.g. opencode.json (relative to /repo)"
              className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm font-mono mb-2 ${
                errors.config_file ? 'border-red-500' : 'border-gray-700'
              }`}
            />
            <textarea
              value={editing.config_file_content ?? ''}
              onChange={(e) => {
                setEditing({ ...editing, config_file_content: e.target.value });
                if (errors.config_file) setErrors({ ...errors, config_file: '' });
              }}
              placeholder="(leave blank for no config file)"
              className={`w-full bg-gray-800 border rounded px-3 py-2 text-xs font-mono min-h-[120px] ${
                errors.config_file ? 'border-red-500' : 'border-gray-700'
              }`}
            />
            {errors.config_file && (
              <p className="text-red-500 text-xs mt-1">{errors.config_file}</p>
            )}
            {editing.config_file_path && editing.config_file_content && (
              <p className="text-xs text-gray-500 mt-1">
                Will write to <span className="font-mono">/repo/{editing.config_file_path}</span> inside the container.
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

function CredentialSettings() {
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);

  useEffect(() => {
    api.getCredentials().then((r) => setCredentials(r.credentials)).catch(() => {});
  }, []);

  const orchestrator = credentials.filter((c) => c.scope === 'orchestrator');
  const forwarded = credentials.filter((c) => c.scope === 'forwarded');

  function row(cred: CredentialStatus) {
    return (
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
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Credentials are loaded from environment variables. To update, modify
        the orchestrator's <span className="font-mono">.env</span> file and
        restart the orchestrator.
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
                set here as defaults; per-tool overrides live under Agent Tools
              </span>
            </h3>
            <div className="space-y-2">{forwarded.map(row)}</div>
          </div>
        </>
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
        Providers define concurrency pools for upstream LLM constraints. Tools
        assigned to the same provider serialise against its{' '}
        <span className="font-mono">concurrency_limit</span>; tools on different
        providers run in parallel. All tasks (with or without a provider) also
        consume from the host resource pool (memory + CPU) configured under
        Global Settings. Set{' '}
        <span className="font-mono">concurrency_limit: 0</span> to pause a
        provider (its tools won't launch until raised).
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
