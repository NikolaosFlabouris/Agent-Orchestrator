import { useEffect, useId, useState } from 'react';
import { api } from '../../api.js';
import { useStore } from '../../store.js';
import type {
  ProviderResponse,
  ProviderKind,
  ProviderKindSpec,
  ModelResponse,
} from '../../api.js';
import { buildProviderSavePayload, type AuthTokenMode } from './providerSavePayload.js';
import { Button } from '../../components/Button.js';
import { Input, Select, Textarea, inputClasses } from '../../components/Input.js';

/** Hit-area padding for the inline text buttons in the provider and
 *  model rows. The negative margin cancels the padding's effect on
 *  layout, so only the tappable area grows: 20px of `text-sm` plus
 *  2×12px reaches the 44px minimum. Dropped from `sm` up, where the rows
 *  keep their original density. */
const TOUCH_TARGET_Y = '-my-3 py-3 sm:my-0 sm:py-0';

/** Same idea for the `text-xs` model rows, where the 16px line box needs
 *  2×14px to clear 44px. */
const TOUCH_TARGET_Y_XS = '-my-3.5 py-3.5 sm:my-0 sm:py-0';

/** Providers & Models tab — per-provider connection identity (kind,
 *  URL, credential) + nested models list. */
export function ProviderSettings() {
  const [providers, setProviders] = useState<ProviderResponse[]>([]);
  const [kinds, setKinds] = useState<ProviderKindSpec[]>([]);
  const [editing, setEditing] = useState<Partial<ProviderResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  // Auth-token editor state lives outside `editing` because the value
  // itself is write-only and we don't want it accidentally folded back
  // into a future GET response payload via setEditing({...p}).
  const [authTokenMode, setAuthTokenMode] = useState<AuthTokenMode>('keep');
  const [authTokenDraft, setAuthTokenDraft] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providersVersion = useStore((s) => s.resourceVersions.providers);
  const modelsVersion = useStore((s) => s.resourceVersions.models);
  // One id root for this tab's label/control pairs.
  const uid = useId();
  const idFieldId = `${uid}-id`;
  const displayNameId = `${uid}-display-name`;
  const kindId = `${uid}-kind`;
  const concurrencyId = `${uid}-concurrency`;
  const baseUrlId = `${uid}-base-url`;
  const apiKeyEnvVarId = `${uid}-api-key-env-var`;
  const authTokenId = `${uid}-auth-token`;
  const notesId = `${uid}-notes`;

  function refresh(): void {
    api.getProviders().then((r) => setProviders(r.providers)).catch(() => {});
  }

  useEffect(() => {
    api.getProviderKinds().then((r) => setKinds(r.kinds)).catch(() => {});
  }, []);

  // Refresh on provider mutations AND on model mutations (the GET
  // /api/providers payload carries `models_count`, which drifts when
  // models change).
  useEffect(() => {
    refresh();
  }, [providersVersion, modelsVersion]);

  function startCreate(): void {
    setEditing({
      id: '',
      display_name: '',
      kind: 'anthropic',
      concurrency_limit: 5,
      base_url: null,
      has_auth_token: false,
      api_key_env_var: 'ANTHROPIC_API_KEY',
      notes: null,
    });
    // New providers default to "set" so the operator can type a token
    // immediately; for edits we default to "keep" so the stored value
    // stays untouched unless the operator explicitly chooses Replace.
    setAuthTokenMode('set');
    setAuthTokenDraft('');
    setIsNew(true);
    setError(null);
  }

  function startEdit(p: ProviderResponse): void {
    setEditing({ ...p });
    setAuthTokenMode('keep');
    setAuthTokenDraft('');
    setIsNew(false);
    setError(null);
  }

  async function handleSave(): Promise<void> {
    if (!editing) return;
    setError(null);

    const spec = editing.kind
      ? kinds.find((k) => k.kind === editing.kind)
      : undefined;
    // Validation + request-body construction live in a pure helper so the
    // credential edge-cases stay unit-testable (see providerSavePayload).
    const result = buildProviderSavePayload({
      editing,
      spec,
      authTokenMode,
      authTokenDraft,
    });
    if ('error' in result) {
      setError(result.error);
      return;
    }

    try {
      if (isNew) {
        await api.createProvider({ id: editing.id, ...result.payload });
      } else {
        await api.updateProvider(editing.id!, result.payload);
      }
      setEditing(null);
      setIsNew(false);
      setAuthTokenMode('keep');
      setAuthTokenDraft('');
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

  // Mirrors the final arm of the auth-token tri-state below: the only
  // mode that actually renders an input for the label to point at.
  const authTokenInputShown =
    authTokenMode === 'set' ||
    (authTokenMode === 'keep' && !editing?.has_auth_token);

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-400">
        Providers carry the connection identity for an LLM endpoint: kind, URL
        (for self-hosted), and credential. Each provider has its own
        concurrency limit. Cloud kinds (Anthropic, OpenAI…) are typically
        singletons with the API key in the orchestrator's <span className="font-mono">.env</span>.
        Self-hosted (OpenAI-compatible) can have multiple instances with
        different URLs.
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
        type="button"
        onClick={startCreate}
        className="min-h-11 sm:min-h-0 text-sm text-blue-400 hover:text-blue-300"
      >
        + Add provider
      </button>

      {editing && editingKindSpec && (
        <div className="bg-gray-900 border border-gray-700 rounded p-4 space-y-4 mt-4">
          <h3 className="font-medium">
            {isNew ? 'Add Provider' : `Edit ${editing.display_name}`}
          </h3>
          {/* `min-w-0` on every cell: a grid item's automatic minimum size
              is its content's min-content width, and a select sized by its
              longest option is far wider than a 375px column. `col-span-2`
              has to be `sm:`-prefixed too — spanning two columns in the
              one-column mobile grid would create an implicit second column
              and push the form off-screen. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <label htmlFor={idFieldId} className="block text-sm mb-1">ID</label>
              <Input
                id={idFieldId}
                value={editing.id ?? ''}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                disabled={!isNew}
                placeholder="e.g. ollama-gpu"
                className="w-full disabled:text-gray-500"
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={displayNameId} className="block text-sm mb-1">Display name</label>
              <Input
                id={displayNameId}
                value={editing.display_name ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, display_name: e.target.value })
                }
                placeholder="e.g. Ollama (GPU box)"
                className="w-full"
              />
            </div>
            <div className="min-w-0 sm:col-span-2">
              <label htmlFor={kindId} className="block text-sm mb-1">Kind</label>
              <Select
                id={kindId}
                value={editing.kind ?? 'anthropic'}
                onChange={(e) => {
                  const newKind = e.target.value as ProviderKind;
                  const spec = kinds.find((k) => k.kind === newKind);
                  setEditing({
                    ...editing,
                    kind: newKind,
                    // Reset auth fields to the new kind's defaults when
                    // switching, so an operator doesn't accidentally save an
                    // anthropic provider with a self-hosted URL.
                    base_url: spec?.requires_base_url ? editing.base_url ?? '' : null,
                    api_key_env_var: spec?.container_env_name ?? null,
                  });
                  // Force the auth-token tri-state to 'clear' so a kind
                  // switch with a stored token doesn't carry credentials
                  // intended for a different endpoint across the change.
                  // Operator can flip back to 'keep' via Undo if the
                  // existing token is genuinely portable.
                  if (editing.has_auth_token) {
                    setAuthTokenMode('clear');
                    setAuthTokenDraft('');
                  } else {
                    setAuthTokenMode('set');
                    setAuthTokenDraft('');
                  }
                }}
                className="w-full"
              >
                {kinds.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.display_name}
                  </option>
                ))}
              </Select>
              {editingKindSpec && (
                <p className="text-xs text-gray-500 mt-1">{editingKindSpec.description}</p>
              )}
            </div>
            <div className="min-w-0">
              <label htmlFor={concurrencyId} className="block text-sm mb-1">
                Concurrency limit
                <span className="text-gray-500 font-normal"> — 0 pauses all profiles using this provider</span>
              </label>
              <Input
                id={concurrencyId}
                type="number"
                min={0}
                value={editing.concurrency_limit ?? 1}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    concurrency_limit: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="w-full"
              />
            </div>
            {editingKindSpec.requires_base_url && (
              <div className="min-w-0">
                <label htmlFor={baseUrlId} className="block text-sm mb-1">
                  Base URL <span className="text-red-400">*</span>
                </label>
                <Input
                  id={baseUrlId}
                  value={editing.base_url ?? ''}
                  onChange={(e) =>
                    setEditing({ ...editing, base_url: e.target.value })
                  }
                  placeholder="http://192.168.1.10:11434"
                  className="w-full"
                />
              </div>
            )}
            {editingKindSpec.container_env_name && (
              <div className="min-w-0 sm:col-span-2">
                <label htmlFor={apiKeyEnvVarId} className="block text-sm mb-1">
                  API key env var
                  <span className="text-gray-500 font-normal">
                    {' '}— name of the env var on the orchestrator's host that holds the API key.
                    The orchestrator reads it at launch and exports the value into the agent
                    container as <span className="font-mono">{editingKindSpec.container_env_name}</span>.
                  </span>
                </label>
                <Input
                  id={apiKeyEnvVarId}
                  value={editing.api_key_env_var ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      api_key_env_var: e.target.value || null,
                    })
                  }
                  placeholder={editingKindSpec.container_env_name}
                  className="w-full font-mono"
                />
              </div>
            )}
            <div className="min-w-0 sm:col-span-2">
              {/* Two of the three modes below render no control at all, so
                  `htmlFor` is only wired up when the input actually
                  exists — a dangling `for` would be a label pointing at
                  nothing in the accessibility tree. */}
              <label
                htmlFor={authTokenInputShown ? authTokenId : undefined}
                className="block text-sm mb-1"
              >
                Auth token (inline)
                <span className="text-gray-500 font-normal">
                  {' '}— optional. For self-hosted servers with bearer auth, OR
                  for cloud kinds when you want to multi-instance without using
                  the env-var pointer above. Stored in the database as
                  plaintext; the server never reveals the stored value back
                  through the API. Use Replace to rotate.
                </span>
              </label>
              {authTokenMode === 'keep' && editing.has_auth_token ? (
                // Edit-existing path: don't even render an input field.
                // The stored value isn't available to the client, so any
                // input here would be pre-filled with the wrong thing.
                <div className={inputClasses('gray-800', 'flex flex-wrap items-center gap-3')}>
                  <span className="text-gray-300 font-mono">**** (stored)</span>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthTokenMode('set');
                      setAuthTokenDraft('');
                    }}
                    aria-label="Replace the stored auth token"
                    className={`text-blue-400 hover:text-blue-300 ${TOUCH_TARGET_Y}`}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthTokenMode('clear');
                      setAuthTokenDraft('');
                    }}
                    aria-label="Clear the stored auth token"
                    className={`text-red-400 hover:text-red-300 ${TOUCH_TARGET_Y}`}
                  >
                    Clear
                  </button>
                </div>
              ) : authTokenMode === 'clear' ? (
                <div className="flex flex-wrap items-center gap-3 bg-gray-800 border border-yellow-700 rounded px-3 py-2 text-sm">
                  <span className="text-yellow-400">
                    Will clear the stored token on save.
                  </span>
                  <button
                    type="button"
                    onClick={() => setAuthTokenMode('keep')}
                    aria-label="Undo clearing the stored auth token"
                    className={`text-blue-400 hover:text-blue-300 ${TOUCH_TARGET_Y}`}
                  >
                    Undo
                  </button>
                </div>
              ) : (
                // 'set' mode, or 'keep' with no stored token yet (new
                // providers, or edits to providers that have only an
                // env-var pointer). Render a fresh input.
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    id={authTokenId}
                    type="password"
                    value={authTokenDraft}
                    onChange={(e) => {
                      setAuthTokenDraft(e.target.value);
                      // If the operator starts typing while the form was
                      // in 'keep' mode (no stored token), promote to 'set'
                      // so the value lands in the PATCH body.
                      if (authTokenMode === 'keep') setAuthTokenMode('set');
                    }}
                    placeholder={
                      editingKindSpec.auth_optional ? '(optional)' : 'paste token'
                    }
                    autoComplete="new-password"
                    className="min-w-0 flex-1 font-mono"
                  />
                  {/* Cancel-set button only relevant when editing a row
                      that already has a stored token — gives the
                      operator an explicit way back to "keep" without
                      blanking the draft accidentally. */}
                  {!isNew && editing.has_auth_token && authTokenMode === 'set' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAuthTokenMode('keep');
                        setAuthTokenDraft('');
                      }}
                      className={`text-gray-400 hover:text-gray-200 text-sm ${TOUCH_TARGET_Y}`}
                    >
                      Keep existing
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div>
            <label htmlFor={notesId} className="block text-sm mb-1">Notes (optional)</label>
            <Textarea
              id={notesId}
              value={editing.notes ?? ''}
              onChange={(e) =>
                setEditing({ ...editing, notes: e.target.value || null })
              }
              className="w-full min-h-[60px]"
            />
          </div>
          {/* `min-h-11` (44px) is the minimum comfortable touch target;
              `px-4 py-2` only reaches 36px. Reset at `sm` so the desktop
              buttons keep their original height. */}
          <div className="flex gap-3">
            <Button
              onClick={handleSave}
              className="min-h-11 sm:min-h-0 px-4 py-2 text-sm"
            >
              Save
            </Button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setIsNew(false);
                setAuthTokenMode('keep');
                setAuthTokenDraft('');
                setError(null);
              }}
              className="min-h-11 sm:min-h-0 text-gray-400 hover:text-gray-200 px-4 py-2 text-sm"
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
      {/* Below `sm` the five-control action cluster alone fills the card,
          so a single line would squeeze Delete off-screen; stacking gives
          the cluster its own line where every control stays reachable.
          From `sm` up this is the original centred, space-between row. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* `min-w-0` lets this block shrink below its content width inside
            the flex row, and `break-words` keeps a long display name or id
            from spilling past the card. */}
        <div className="min-w-0 break-words">
          <span className="font-medium">{provider.display_name}</span>
          <span className="text-gray-500 text-sm ml-2">({provider.id})</span>
          <span className="text-gray-500 text-sm ml-3">
            kind: {kindSpec?.display_name ?? provider.kind}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm sm:shrink-0">
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
            type="button"
            onClick={onExpand}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `Collapse models for ${provider.display_name}`
                : `Show models for ${provider.display_name}`
            }
            className={`text-blue-400 hover:text-blue-300 ${TOUCH_TARGET_Y}`}
          >
            {expanded ? 'Collapse' : 'Models'}
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit provider ${provider.display_name}`}
            className={`text-blue-400 hover:text-blue-300 ${TOUCH_TARGET_Y}`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={provider.models_count > 0}
            aria-label={`Delete provider ${provider.display_name}`}
            className={`text-red-400 hover:text-red-300 disabled:text-gray-600 disabled:cursor-not-allowed ${TOUCH_TARGET_Y}`}
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
  const modelsVersion = useStore((s) => s.resourceVersions.models);
  const uid = useId();
  const draftIdId = `${uid}-model-id`;
  const draftNameId = `${uid}-model-name`;

  function refresh(): void {
    api
      .getProviderModels(providerId)
      .then((r) => setModels(r.models))
      .catch(() => {});
  }
  // Re-fetch when the provider context changes OR when any model
  // anywhere mutates (server bumps the resource version after every
  // CRUD on /api/providers/:id/models or /api/models/:pk).
  useEffect(refresh, [providerId, modelsVersion]);

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
              className="flex flex-wrap items-center justify-between gap-2 bg-gray-800 rounded px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 break-words">
                <span className="font-mono">{m.model_id}</span>
                <span className="text-gray-500 ml-2">{m.display_name}</span>
              </span>
              <button
                type="button"
                onClick={() => handleDelete(m.id)}
                aria-label={`Delete model ${m.model_id}`}
                className={`shrink-0 text-red-400 hover:text-red-300 ${TOUCH_TARGET_Y_XS}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        /* Two inputs plus two buttons do not share a line at 375px; below
           `sm` each input takes a full line of the wrapped row and the two
           buttons follow on the next one. From `sm` up the inputs go back
           to `flex-1` and the row is the single line it has always been. */
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <label htmlFor={draftIdId} className="sr-only">
            Model id
          </label>
          <input
            id={draftIdId}
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            placeholder="model_id (e.g. claude-sonnet-4-6)"
            className="w-full min-w-0 sm:w-auto sm:flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
          />
          <label htmlFor={draftNameId} className="sr-only">
            Model display name
          </label>
          <input
            id={draftNameId}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="display name"
            className="w-full min-w-0 sm:w-auto sm:flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
          />
          <Button
            onClick={handleAdd}
            disabled={!draftId.trim() || !draftName.trim()}
            className="min-h-11 sm:min-h-0 disabled:bg-gray-700 px-3 py-1 text-xs"
          >
            Add
          </Button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setDraftId('');
              setDraftName('');
              setError(null);
            }}
            className="min-h-11 sm:min-h-0 text-gray-400 hover:text-gray-200 px-2 text-xs"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="min-h-11 sm:min-h-0 text-xs text-blue-400 hover:text-blue-300"
        >
          + Add model
        </button>
      )}
    </div>
  );
}
