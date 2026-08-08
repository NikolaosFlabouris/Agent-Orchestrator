import { useEffect, useId, useState } from 'react';
import { api } from '../../api.js';
import { useStore } from '../../store.js';
import type {
  RepoResponse,
  ForgejoRepoResponse,
  AgentProfileResponse,
  InstallStep,
  InstallStepKind,
} from '../../api.js';
import { INSTALL_STEP_LABELS } from '../../api.js';
import { Button } from '../../components/Button.js';
import { Input, Select } from '../../components/Input.js';

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

/** Hit-area padding for the inline text buttons that sit in a list row
 *  or a compact editor line. The negative margin cancels the padding's
 *  effect on layout, so only the tappable area grows: 20px of `text-sm`
 *  plus 2×12px reaches the 44px minimum. Dropped from `sm` up, where a
 *  pointer is the likely input device and the rows keep their density. */
const TOUCH_TARGET_Y = '-my-3 py-3 sm:my-0 sm:py-0';

/** Repositories tab — per-repo profile/branch/memory/cpu/merge config
 *  and the install-steps editor. */
export function RepoSettings() {
  const [repos, setRepos] = useState<RepoResponse[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileResponse[]>([]);
  const [availableRepos, setAvailableRepos] = useState<ForgejoRepoResponse[]>([]);
  const [editing, setEditing] = useState<Partial<RepoResponse> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profilesVersion = useStore((s) => s.resourceVersions.profiles);
  // One id root for this tab's label/control pairs.
  const uid = useId();
  const repoSelectId = `${uid}-repo`;
  const baseBranchId = `${uid}-base-branch`;
  const implProfileId = `${uid}-impl-profile`;
  const reviewProfileId = `${uid}-review-profile`;
  const memoryId = `${uid}-memory`;
  const cpuId = `${uid}-cpu`;
  const mergeStrategyId = `${uid}-merge-strategy`;

  useEffect(() => {
    api.getRepos().then((r) => setRepos(r.repos)).catch(() => {});
    api.getAvailableRepos().then((r) => setAvailableRepos(r.repos)).catch(() => {});
  }, []);

  // Profile list is invalidated on any profile mutation broadcast from
  // the Agent Profiles tab.
  useEffect(() => {
    api.getAgentProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }, [profilesVersion]);

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
        const reviewProfile = repo.review_agent_profile_id
          ? profiles.find((p) => p.id === repo.review_agent_profile_id)
          : null;
        return (
          /* Below `sm` the profile summary alone is wider than the row, so
             a single line would either squeeze Edit off-screen or stretch
             the document; stacking puts the button on its own line where
             it stays reachable. From `sm` up the row is the original
             centred, space-between line. */
          <div
            key={repo.id}
            className="bg-gray-900 border border-gray-800 rounded p-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            {/* `min-w-0` lets this block shrink below its content width
                inside the flex row, and `break-words` keeps an unbroken
                owner/name pair from spilling past the card. */}
            <div className="min-w-0 break-words">
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
              {repo.review_agent_profile_id && (
                <span className="text-gray-500 text-sm ml-3">
                  review:{' '}
                  {reviewProfile
                    ? reviewProfile.display_name
                    : `${repo.review_agent_profile_id} (missing)`}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => { setEditing({ ...repo }); setIsNew(false); }}
              aria-label={`Edit ${repo.owner}/${repo.name}`}
              className={`self-start sm:self-auto shrink-0 text-sm text-blue-400 hover:text-blue-300 ${TOUCH_TARGET_Y}`}
            >
              Edit
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => {
          setEditing({
            base_branch: 'main',
            agent_profile_id: null,
            review_agent_profile_id: null,
            merge_strategy: 'squash',
            install_steps: [],
            allow_script_steps: false,
          });
          setIsNew(true);
          api.getAvailableRepos().then((r) => setAvailableRepos(r.repos)).catch(() => {});
        }}
        className="min-h-11 sm:min-h-0 text-sm text-blue-400 hover:text-blue-300"
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
          {/* `min-w-0` on every cell: a grid item's automatic minimum size
              is its content's min-content width, and a select sized by its
              longest option is far wider than a 375px column. `col-span-2`
              has to be `sm:`-prefixed too — spanning two columns in the
              one-column mobile grid would create an implicit second column
              and push the form off-screen. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {isNew && (
              <div className="min-w-0 sm:col-span-2">
                <label htmlFor={repoSelectId} className="block text-sm mb-1">Repository</label>
                {availableRepos.length > 0 ? (
                  <Select
                    id={repoSelectId}
                    value={editing.owner && editing.name ? `${editing.owner}/${editing.name}` : ''}
                    onChange={(e) => {
                      const selected = availableRepos.find((r) => r.full_name === e.target.value);
                      if (selected) {
                        setEditing({ ...editing, owner: selected.owner, name: selected.name, base_branch: selected.default_branch });
                      }
                    }}
                    className="w-full"
                  >
                    <option value="">Select a repository...</option>
                    {availableRepos.map((r) => (
                      <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                    ))}
                  </Select>
                ) : (
                  <p className="text-gray-500 text-sm py-2">No unregistered repositories found in Forgejo</p>
                )}
              </div>
            )}
            <div className="min-w-0">
              <label htmlFor={baseBranchId} className="block text-sm mb-1">Base branch</label>
              <Input
                id={baseBranchId}
                value={editing.base_branch ?? 'main'}
                onChange={(e) => setEditing({ ...editing, base_branch: e.target.value })}
                className="w-full"
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={implProfileId} className="block text-sm mb-1">
                Default implementation profile
              </label>
              <Select
                id={implProfileId}
                value={editing.agent_profile_id ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    agent_profile_id: e.target.value || null,
                  })
                }
                className="w-full"
              >
                <option value="">Inherit (use global default)</option>
                {/* Synthetic option for a dangling profile id so the
                    operator can see the broken pointer rather than the
                    select silently snapping to "Inherit". */}
                {editing.agent_profile_id &&
                  !profiles.some((p) => p.id === editing.agent_profile_id) && (
                    <option value={editing.agent_profile_id}>
                      (missing profile — {editing.agent_profile_id})
                    </option>
                  )}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </Select>
              {editing.agent_profile_id &&
                !profiles.some((p) => p.id === editing.agent_profile_id) && (
                  <p className="mt-1 text-xs text-yellow-400">
                    This repo is configured with a profile that no longer
                    exists. Pick a replacement or switch to Inherit.
                  </p>
                )}
            </div>
            <div className="min-w-0">
              <label htmlFor={reviewProfileId} className="block text-sm mb-1">
                Default review profile
              </label>
              <Select
                id={reviewProfileId}
                value={editing.review_agent_profile_id ?? ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    review_agent_profile_id: e.target.value || null,
                  })
                }
                className="w-full"
              >
                <option value="">
                  Inherit (global review default, else implementation profile)
                </option>
                {/* Synthetic option for a dangling profile id — same
                    treatment as the implementation select above. */}
                {editing.review_agent_profile_id &&
                  !profiles.some(
                    (p) => p.id === editing.review_agent_profile_id
                  ) && (
                    <option value={editing.review_agent_profile_id}>
                      (missing profile — {editing.review_agent_profile_id})
                    </option>
                  )}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </Select>
              {editing.review_agent_profile_id &&
                !profiles.some(
                  (p) => p.id === editing.review_agent_profile_id
                ) && (
                  <p className="mt-1 text-xs text-yellow-400">
                    This repo's review profile no longer exists. Pick a
                    replacement or switch to Inherit.
                  </p>
                )}
            </div>
            <div className="min-w-0">
              <label htmlFor={memoryId} className="block text-sm mb-1">Memory (MB)</label>
              <Input
                id={memoryId}
                type="number"
                value={editing.container_memory_mb ?? ''}
                onChange={(e) => setEditing({ ...editing, container_memory_mb: e.target.value ? parseInt(e.target.value, 10) : null })}
                placeholder="Use global default"
                className="w-full"
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={cpuId} className="block text-sm mb-1">CPU cores</label>
              <Input
                id={cpuId}
                type="number"
                value={editing.container_cpu_cores ?? ''}
                onChange={(e) => setEditing({ ...editing, container_cpu_cores: e.target.value ? parseInt(e.target.value, 10) : null })}
                placeholder="Use global default"
                className="w-full"
              />
            </div>
            <div className="min-w-0 sm:col-span-2">
              <label htmlFor={mergeStrategyId} className="block text-sm mb-1">
                Merge strategy
                <span className="text-gray-500 font-normal"> — preferred PR merge style; resolved against the repo's Forgejo-side allowed list at merge time</span>
              </label>
              <Select
                id={mergeStrategyId}
                value={editing.merge_strategy ?? 'squash'}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    merge_strategy: e.target.value as 'squash' | 'merge' | 'rebase',
                  })
                }
                className="w-full"
              >
                <option value="squash">squash</option>
                <option value="merge">merge</option>
                <option value="rebase">rebase</option>
              </Select>
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
              onClick={() => { setEditing(null); setIsNew(false); setError(null); }}
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
  const uid = useId();
  // The heading labels the whole editor rather than one control, so it is
  // a group label (see the `role="group"` below) and the per-step controls
  // carry their own names.
  const groupLabelId = `${uid}-install-steps`;

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
    <div className="space-y-2" role="group" aria-labelledby={groupLabelId}>
      <div id={groupLabelId} className="text-sm font-medium">
        Install steps
        <span className="text-gray-500 font-normal">
          {' '}— run sequentially before the agent, under a shared cache lock
        </span>
      </div>
      {steps.length === 0 && (
        <p className="text-xs text-gray-500">
          No install steps configured. The agent will start without dependency install.
        </p>
      )}
      {steps.map((step, i) => (
        /* A `w-56` select plus two `flex-1` inputs plus the remove button
           cannot share one line at 375px. Below `sm` each control takes a
           full line of the wrapped row instead; from `sm` up every child
           reverts to its original width and the row is the single line it
           has always been. */
        <div
          key={i}
          className="flex flex-wrap items-center gap-2 bg-gray-800 border border-gray-700 rounded p-2"
        >
          <select
            aria-label={`Install step ${i + 1} kind`}
            value={step.kind}
            onChange={(e) => {
              const newKind = e.target.value as InstallStepKind | 'script';
              if (newKind === 'script') {
                updateStep(i, { kind: 'script', path: (step as { path?: string }).path ?? '', cwd: step.cwd });
              } else {
                updateStep(i, { kind: newKind, cwd: step.cwd });
              }
            }}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono min-w-0 w-full sm:w-56 shrink-0"
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
              aria-label={`Install step ${i + 1} script path`}
              value={(step as { path: string }).path}
              onChange={(e) => updateStep(i, { ...step, path: e.target.value })}
              placeholder="scripts/setup.sh (relative to cwd)"
              className="w-full min-w-0 sm:w-auto sm:flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
            />
          )}
          <input
            type="text"
            aria-label={`Install step ${i + 1} working directory`}
            value={step.cwd ?? ''}
            onChange={(e) => updateStep(i, { ...step, cwd: e.target.value || undefined })}
            placeholder="cwd (relative to /repo, optional)"
            className="w-full min-w-0 sm:w-auto sm:flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono"
          />
          {/* `ml-auto` parks the × at the right end of its own wrapped
              line on mobile; from `sm` the flex-1 inputs already consume
              the free space, so it is dropped and nothing moves. */}
          <button
            type="button"
            onClick={() => removeStep(i)}
            className="ml-auto sm:ml-0 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-red-400 hover:text-red-300 px-2 text-sm"
            aria-label={`Remove install step ${i + 1}`}
            title="Remove step"
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <select
          aria-label="Add install step"
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            addStep(e.target.value as InstallStepKind | 'script');
            e.target.value = '';
          }}
          className="min-w-0 max-w-full min-h-11 sm:min-h-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
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
