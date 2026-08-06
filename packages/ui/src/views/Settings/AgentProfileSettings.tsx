import { useEffect, useId, useState } from 'react';
import { api } from '../../api.js';
import { useStore } from '../../store.js';
import type {
  ProviderResponse,
  ModelResponse,
  AgentProfileResponse,
  HarnessSpec,
  HarnessId,
} from '../../api.js';

/** Hit-area padding for the inline text buttons in a profile row. The
 *  negative margin cancels the padding's effect on layout, so only the
 *  tappable area grows: 20px of `text-sm` plus 2×12px reaches the 44px
 *  minimum. Dropped from `sm` up, where the rows keep their density. */
const TOUCH_TARGET_Y = '-my-3 py-3 sm:my-0 sm:py-0';

/** Agent Profiles tab — pair a harness (Claude SDK / Claude Code /
 *  OpenCode / Pi) with a provider+model and harness-specific config. */
export function AgentProfileSettings() {
  const [profiles, setProfiles] = useState<AgentProfileResponse[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessSpec[]>([]);
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  // Lazy initializer: a `new Map()` literal would allocate on every
  // render and useState would discard all but the first. The thunk
  // form runs once on mount.
  const [allModels, setAllModels] = useState<Map<string, ModelResponse[]>>(() => new Map());
  const [editing, setEditing] = useState<Partial<AgentProfileResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profilesVersion = useStore((s) => s.resourceVersions.profiles);
  const providersVersion = useStore((s) => s.resourceVersions.providers);
  const modelsVersion = useStore((s) => s.resourceVersions.models);
  // One id root for this tab's label/control pairs.
  const uid = useId();
  const idFieldId = `${uid}-id`;
  const displayNameId = `${uid}-display-name`;
  const harnessSelectId = `${uid}-harness`;
  const timeoutId = `${uid}-timeout`;
  const modelSelectId = `${uid}-model`;

  // Harness registry is code-defined and never mutates at runtime, so
  // we fetch it once.
  useEffect(() => {
    api.getHarnesses().then((r) => setHarnesses(r.harnesses)).catch(() => {});
  }, []);

  // Profile list — refresh on any profile mutation.
  useEffect(() => {
    api.getAgentProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }, [profilesVersion]);

  // Providers + their model lists — refresh when either set mutates.
  // We re-fetch the model lookup map any time providers OR models
  // change so the form's model dropdown never shows a stale option.
  useEffect(() => {
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
  }, [providersVersion, modelsVersion]);

  function startCreate(): void {
    setEditing({
      id: '',
      display_name: '',
      harness_id: 'claude-sdk',
      model_pk: 0,
      config_json: {},
      // Matches DB default (`agent_profiles.timeout_minutes DEFAULT
      // 2880`) and the Help-text documented default. 2880 min = 2 days
      // — comfortably long for autonomous runs without masking a stuck
      // agent indefinitely.
      timeout_minutes: 2880,
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
      // Profile list normally refreshes via the resource_changed
      // websocket event the server broadcasts. M7: belt-and-braces
      // inline refetch covers the case where the WS connection dropped
      // mid-save — without it the just-saved profile wouldn't appear
      // in the list until the page reloads.
      api
        .getAgentProfiles()
        .then((r) => setProfiles(r.profiles))
        .catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm(`Delete profile ${id}?`)) return;
    setError(null);
    try {
      await api.deleteAgentProfile(id);
      // M7: clear the editor state if it was open on the row we just
      // deleted. Without this, the editor stays open with the deleted
      // profile's draft and clicking Save would re-POST the row, silently
      // re-creating it. Also belt-and-braces refetch in case the WS
      // dropped (same reasoning as handleSave).
      if (editing?.id === id) {
        setEditing(null);
        setIsNew(false);
      }
      api
        .getAgentProfiles()
        .then((r) => setProfiles(r.profiles))
        .catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const editingHarness = editing?.harness_id
    ? harnesses.find((h) => h.id === editing.harness_id)
    : undefined;

  // Build the model dropdown filtered by the chosen harness's supported
  // provider kinds. The server-side compatibility check (M2) catches
  // any mismatch at save time; this filter is the UX hint.
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
            /* Below `sm` the harness/model/usage summary alone is wider
               than the card, so a single line would squeeze Edit and
               Delete off-screen; stacking gives them their own line where
               they stay reachable. From `sm` up this is the original
               centred, space-between row. */
            <div
              key={p.id}
              className="bg-gray-900 border border-gray-800 rounded p-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            >
              {/* `min-w-0` lets this block shrink below its content width
                  inside the flex row, and `break-words` keeps a long
                  provider/model pair from spilling past the card. */}
              <div className="min-w-0 break-words">
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
              <div className="flex flex-wrap items-center gap-3 text-sm sm:shrink-0">
                <button
                  type="button"
                  onClick={() => startEdit(p)}
                  aria-label={`Edit agent profile ${p.display_name}`}
                  className={`text-blue-400 hover:text-blue-300 ${TOUCH_TARGET_Y}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(p.id)}
                  aria-label={`Delete agent profile ${p.display_name}`}
                  className={`text-red-400 hover:text-red-300 ${TOUCH_TARGET_Y}`}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })
      )}

      <button
        type="button"
        onClick={startCreate}
        className="min-h-11 sm:min-h-0 text-sm text-blue-400 hover:text-blue-300"
      >
        + Add agent profile
      </button>

      {editing && editingHarness && (
        <div className="bg-gray-900 border border-gray-700 rounded p-4 space-y-4 mt-4">
          <h3 className="font-medium">
            {isNew ? 'Add Agent Profile' : `Edit ${editing.display_name}`}
          </h3>
          {/* `min-w-0` on every cell: a grid item's automatic minimum size
              is its content's min-content width, and the model select —
              sized by its longest "provider — model (id)" option — is far
              wider than a 375px column. `col-span-2` has to be
              `sm:`-prefixed too — spanning two columns in the one-column
              mobile grid would create an implicit second column and push
              the form off-screen. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <label htmlFor={idFieldId} className="block text-sm mb-1">ID</label>
              <input
                id={idFieldId}
                value={editing.id ?? ''}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                disabled={!isNew}
                placeholder="e.g. claude-sdk-sonnet"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm disabled:text-gray-500"
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={displayNameId} className="block text-sm mb-1">Display name</label>
              <input
                id={displayNameId}
                value={editing.display_name ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, display_name: e.target.value })
                }
                placeholder="e.g. Claude SDK + Sonnet"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={harnessSelectId} className="block text-sm mb-1">Harness</label>
              <select
                id={harnessSelectId}
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
            <div className="min-w-0">
              <label htmlFor={timeoutId} className="block text-sm mb-1">
                Timeout (minutes) <span className="text-red-400">*</span>
              </label>
              <input
                id={timeoutId}
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
            <div className="min-w-0 sm:col-span-2">
              {/* With no compatible models the branch below renders a
                  warning instead of the select, so `htmlFor` is only wired
                  up when there is a control to point at. */}
              <label
                htmlFor={modelOptions.length > 0 ? modelSelectId : undefined}
                className="block text-sm mb-1"
              >
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
                <>
                  <select
                    id={modelSelectId}
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
                    {/* If the profile points at a model that's no longer in
                        the visible options (deleted in another tab, or
                        the harness's compatible-kinds list changed),
                        render a synthetic option so the operator can SEE
                        the dangling pointer instead of the select
                        silently snapping to the placeholder. */}
                    {editing.model_pk &&
                      !modelOptions.some(
                        ({ model }) => model.id === editing.model_pk
                      ) && (
                        <option value={editing.model_pk}>
                          (missing model — pk {editing.model_pk}, pick a
                          replacement)
                        </option>
                      )}
                    {modelOptions.map(({ provider, model }) => (
                      <option key={model.id} value={model.id}>
                        {provider.display_name} — {model.display_name} (
                        <span>{model.model_id}</span>)
                      </option>
                    ))}
                  </select>
                  {editing.model_pk !== undefined &&
                    editing.model_pk !== 0 &&
                    !modelOptions.some(
                      ({ model }) => model.id === editing.model_pk
                    ) && (
                      <p className="mt-1 text-xs text-yellow-400">
                        The previously selected model is no longer available
                        for this harness. Pick a replacement before saving.
                      </p>
                    )}
                </>
              )}
            </div>
          </div>

          <HarnessConfigForm
            harnessId={editingHarness.id}
            config={editing.config_json ?? {}}
            onChange={(cfg) => setEditing({ ...editing, config_json: cfg })}
          />

          {/* Compute save-eligibility once so the button and the
              tooltip stay in sync. (L) The previous version disabled
              only on falsy model_pk, leaving the button live when the
              selected model_pk pointed at a row no longer in
              modelOptions (deleted in another tab, or the harness's
              compatible-kinds list changed). Server rejects the save
              with a clear error, but disabling here avoids the round
              trip. */}
          {(() => {
            const modelMissing =
              !editing.model_pk ||
              !modelOptions.some(({ model }) => model.id === editing.model_pk);
            const saveDisabled = modelMissing;
            const saveTitle = modelMissing
              ? 'Select a model compatible with this harness before saving.'
              : undefined;
            return (
              /* `min-h-11` (44px) is the minimum comfortable touch
                 target; `px-4 py-2` only reaches 36px. Reset at `sm` so
                 the desktop buttons keep their original height. */
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveDisabled}
                  title={saveTitle}
                  className="min-h-11 sm:min-h-0 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white px-4 py-2 rounded text-sm"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setIsNew(false);
                    setError(null);
                  }}
                  className="min-h-11 sm:min-h-0 text-gray-400 hover:text-gray-200 px-4 py-2 text-sm"
                >
                  Cancel
                </button>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/** Per-harness config form. Each harness has its own component matched
 *  by id. Empty for v1 harnesses with no operator-tunable knobs.
 *
 *  Note: `harnessId` is typed as `HarnessId` (a string literal union)
 *  for the known set, but practically this component should render
 *  "no config" for any unknown id rather than crashing. The default
 *  branch handles that. */
function HarnessConfigForm({
  harnessId,
  config,
  onChange,
}: {
  harnessId: HarnessId;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  // Declared before the early return below — hooks must run on every
  // render regardless of which harness is selected.
  const uid = useId();
  const maxTurnsId = `${uid}-max-turns`;
  if (harnessId === 'claude-code') {
    const maxTurns = typeof config.max_turns === 'number' ? config.max_turns : 100;
    return (
      <div>
        <label htmlFor={maxTurnsId} className="block text-sm mb-1">
          max_turns
          <span className="text-gray-500 font-normal">
            {' '}— passed to <span className="font-mono">claude --max-turns N</span>
          </span>
        </label>
        <input
          id={maxTurnsId}
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
  // claude-sdk, opencode, pi, and any future harness id we haven't
  // built a form for yet: no operator-tunable knobs surfaced.
  return (
    <p className="text-xs text-gray-500">
      No harness-specific configuration for {harnessId}.
    </p>
  );
}
