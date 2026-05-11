import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useStore } from '../../store.js';
import type {
  AgentProfileResponse,
  HostCapacityResponse,
} from '../../api.js';

/** Global Settings tab — host resource pool + default agent profile. */
export function GlobalSettings() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [profiles, setProfiles] = useState<AgentProfileResponse[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<HostCapacityResponse | null>(null);
  const profilesVersion = useStore((s) => s.resourceVersions.profiles);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
    api.getHostCapacity().then(setCapacity).catch(() => {});
  }, []);

  // Refetch profiles whenever the server broadcasts a profile change.
  // Version starts at 0 so the initial render also fires the effect.
  useEffect(() => {
    api.getAgentProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }, [profilesVersion]);

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
