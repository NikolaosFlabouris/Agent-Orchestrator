import type { Task, Provider } from '@orchestrator/shared';

/** Synthetic provider id used internally to represent "no provider
 *  resolvable for this task". Tasks bucketed under this key are not
 *  subject to per-provider concurrency limits — only the host resource
 *  pool gates their launch. */
export const NO_PROVIDER_KEY = '__none__';

/** Map a task to its current provider id by walking
 *  task → profile → model → provider_id. The caller supplies a single
 *  function that performs the lookup so the helper stays pure (no DB
 *  access of its own; trivially testable).
 *
 *  Returns NO_PROVIDER_KEY when any link in the chain is missing
 *  (profile deleted, model deleted, etc.) — those tasks won't crash the
 *  scheduler but also won't be subject to provider-pool gating. */
export function resolveProviderKey(
  task: Task,
  resolvedProviderId: string | null | undefined
): string {
  return resolvedProviderId ?? NO_PROVIDER_KEY;
}

/** Count currently-active (holding-a-slot) tasks per provider. The
 *  caller supplies the task→provider_id resolver so this stays pure.
 *  Pure — no DB reads. */
export function countActiveByProvider(
  activeTasks: Task[],
  resolveProviderId: (task: Task) => string | null | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of activeTasks) {
    const key = resolveProviderKey(task, resolveProviderId(task));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Decide whether a candidate task's provider pool would permit a launch
 *  right now. Pure — call it once per candidate, incrementing
 *  activeByProvider[key] on each actual launch. The host resource pool
 *  (memory / CPU) is checked separately by the scheduler — see queue.ts
 *  fitsInPool / getAvailableResources.
 *
 *  Rules:
 *   - Tasks with a resolvable provider: active-on-provider must be
 *     strictly less than provider.concurrency_limit. Limit of 0 means
 *     "paused" — no task ever launches against this provider.
 *   - Tasks with NO_PROVIDER_KEY (profile/model/provider chain broken):
 *     no provider-side constraint; the host pool is the only gate.
 *   - Unknown provider key (provider row deleted between tool-row
 *     refresh and now): treated as unlimited from this layer's
 *     perspective. ON DELETE RESTRICT on agent_profiles.model_pk and
 *     models.provider_id should make this rare. */
export function canLaunchInPool(
  providerKey: string,
  activeByProvider: Map<string, number>,
  limitByProvider: Map<string, number>
): boolean {
  if (providerKey === NO_PROVIDER_KEY) return true;
  const active = activeByProvider.get(providerKey) ?? 0;
  const limit = limitByProvider.get(providerKey);
  if (limit === undefined) return true; // provider row missing
  return active < limit;
}

/** Build a provider-id → concurrency_limit map from the providers table. */
export function limitMapFromProviders(
  providers: Provider[]
): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of providers) m.set(p.id, p.concurrency_limit);
  return m;
}
