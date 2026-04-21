import type { Task, AgentTool, Provider, Repo } from '@orchestrator/shared';

/** Synthetic provider id used internally to represent "no provider assigned".
 *  Tasks whose tool has `provider_id === null` are bucketed under this key for
 *  bookkeeping but their slot use is only bounded by global max_concurrency. */
export const NO_PROVIDER_KEY = '__none__';

/** Given a task and its resolved tool + repo, return the provider id the task
 *  occupies a slot against. Null tool.provider_id → NO_PROVIDER_KEY. */
export function resolveProviderKey(
  task: Task,
  tool: AgentTool | undefined,
  _repo: Repo | undefined
): string {
  // _repo is unused today but kept in the signature for future extension
  // (e.g. per-repo provider overrides) without churning call sites.
  return tool?.provider_id ?? NO_PROVIDER_KEY;
}

/** Count currently-active (holding-a-slot) tasks per provider, given a list
 *  of active tasks and a way to look up each one's tool. Pure — no DB reads. */
export function countActiveByProvider(
  activeTasks: Task[],
  resolveTool: (task: Task) => AgentTool | undefined,
  resolveRepo: (task: Task) => Repo | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of activeTasks) {
    const tool = resolveTool(task);
    const repo = resolveRepo(task);
    const key = resolveProviderKey(task, tool, repo);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Decide whether a candidate task is launchable right now. Pure — call it
 *  once per candidate, decrementing remainingGlobal and incrementing
 *  activeByProvider[key] on each actual launch.
 *
 *  Rules:
 *   - Global ceiling (settings.max_concurrency) is absolute. Once remaining
 *     global slots hit 0, nothing launches regardless of provider headroom.
 *   - For tasks with a provider assigned: active-on-provider must be strictly
 *     less than provider.concurrency_limit. A limit of 0 means "paused" —
 *     no task with this provider ever launches.
 *   - For tasks with no provider: only the global ceiling applies.
 *   - Unknown provider (tool points at a deleted provider): treat as unlimited
 *     within the global ceiling. ON DELETE SET NULL should make this rare. */
export function canLaunchInPool(
  providerKey: string,
  activeByProvider: Map<string, number>,
  limitByProvider: Map<string, number>,
  remainingGlobal: number
): boolean {
  if (remainingGlobal <= 0) return false;
  if (providerKey === NO_PROVIDER_KEY) return true;
  const active = activeByProvider.get(providerKey) ?? 0;
  const limit = limitByProvider.get(providerKey);
  if (limit === undefined) return true; // provider row missing; fall back to global-only
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
