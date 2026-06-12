import { describe, it, expect } from 'vitest';
import {
  NO_PROVIDER_KEY,
  canLaunchInPool,
  countActiveByProvider,
  limitMapFromProviders,
  resolveProviderKey,
  shouldDeferReviewLaunch,
} from '../../scheduler-pools.js';
import type { Task, Provider } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Test fixtures — minimal shapes; cast through `as unknown` to avoid filling
// in fields that these pure helpers don't touch.
// ---------------------------------------------------------------------------

function mkTask(id: number, container_id: string | null = 'c'): Task {
  return { id, container_id } as unknown as Task;
}
function mkProvider(id: string, limit: number): Provider {
  return {
    id,
    display_name: id,
    kind: 'anthropic',
    concurrency_limit: limit,
    base_url: null,
    auth_token: null,
    api_key_env_var: null,
    notes: null,
  };
}

// ---------------------------------------------------------------------------

describe('resolveProviderKey', () => {
  it('returns the supplied provider id when set', () => {
    expect(resolveProviderKey(mkTask(1), 'ollama-a')).toBe('ollama-a');
  });
  it('returns NO_PROVIDER_KEY when null', () => {
    expect(resolveProviderKey(mkTask(1), null)).toBe(NO_PROVIDER_KEY);
  });
  it('returns NO_PROVIDER_KEY when undefined', () => {
    expect(resolveProviderKey(mkTask(1), undefined)).toBe(NO_PROVIDER_KEY);
  });
});

describe('countActiveByProvider', () => {
  it('buckets tasks by their resolved provider_id', () => {
    const tasks = [mkTask(1), mkTask(2), mkTask(3), mkTask(4)];
    const providerByTask: Record<number, string | null> = {
      1: 'anthropic',
      2: 'anthropic',
      3: 'ollama-a',
      4: null,
    };
    const counts = countActiveByProvider(tasks, (t) => providerByTask[t.id]);
    expect(counts.get('anthropic')).toBe(2);
    expect(counts.get('ollama-a')).toBe(1);
    expect(counts.get(NO_PROVIDER_KEY)).toBe(1);
  });
});

describe('canLaunchInPool', () => {
  const limits = limitMapFromProviders([
    mkProvider('anthropic', 3),
    mkProvider('ollama-a', 1),
    mkProvider('ollama-b', 0), // paused
  ]);

  it('allows when provider has headroom', () => {
    expect(canLaunchInPool('anthropic', new Map([['anthropic', 1]]), limits)).toBe(true);
  });

  it('blocks when provider is at its limit', () => {
    expect(canLaunchInPool('ollama-a', new Map([['ollama-a', 1]]), limits)).toBe(false);
  });

  it('treats a provider with limit=0 as paused (no launches)', () => {
    expect(canLaunchInPool('ollama-b', new Map(), limits)).toBe(false);
  });

  it('treats NO_PROVIDER_KEY as unconstrained from this layer', () => {
    // No-provider tasks are gated only by the host resource pool, which is
    // checked separately by the scheduler — this helper waves them through.
    expect(canLaunchInPool(NO_PROVIDER_KEY, new Map([[NO_PROVIDER_KEY, 100]]), limits)).toBe(true);
    expect(canLaunchInPool(NO_PROVIDER_KEY, new Map(), limits)).toBe(true);
  });

  it('treats an unknown provider key (row deleted) as unlimited from this layer', () => {
    // After ON DELETE RESTRICT, the FK should prevent this — but a stale
    // resolution mid-migration is still possible. Don't block it; the
    // missing limit row defaults to "unconstrained from this layer".
    expect(canLaunchInPool('gone', new Map(), limits)).toBe(true);
  });
});

describe('shouldDeferReviewLaunch', () => {
  const limits = limitMapFromProviders([
    mkProvider('anthropic', 3),
    mkProvider('ollama-a', 1),
    mkProvider('ollama-b', 0), // paused
  ]);

  // Resolver stub: task → provider id. The real resolver is the
  // scheduler's stage-aware providerIdForTask; here it's just a lookup.
  function resolverFor(providerByTask: Record<number, string | null>) {
    return (t: Task) => providerByTask[t.id];
  }

  it('defers when the (foreign) review provider is at its limit', () => {
    // Task 1 finished dev on anthropic; its review targets ollama-a
    // (limit 1), which task 2 is already occupying.
    const active = [mkTask(1), mkTask(2)];
    const resolve = resolverFor({ 1: 'anthropic', 2: 'ollama-a' });
    expect(shouldDeferReviewLaunch('ollama-a', 1, active, resolve, limits)).toBe(
      true
    );
  });

  it('launches when the same limit-1 provider is held only by the transitioning task itself (self-exclusion)', () => {
    // The single-profile case on a concurrency_limit=1 provider: the
    // task's exited dev container nominally holds the only slot. The
    // task hands that slot to its own review — counting it would defer
    // every review on this provider, regressing pre-split behavior.
    const active = [mkTask(1)];
    const resolve = resolverFor({ 1: 'ollama-a' });
    expect(shouldDeferReviewLaunch('ollama-a', 1, active, resolve, limits)).toBe(
      false
    );
  });

  it('defers when a limit-1 provider is held by a DIFFERENT task', () => {
    const active = [mkTask(1), mkTask(2)];
    const resolve = resolverFor({ 1: 'anthropic', 2: 'ollama-a' });
    // Task 1's review targets ollama-a; task 2 (not the transitioning
    // task) holds the only slot.
    expect(shouldDeferReviewLaunch('ollama-a', 1, active, resolve, limits)).toBe(
      true
    );
  });

  it('never defers a broken profile chain (null review provider)', () => {
    // Unconstrained-by-provider treatment, matching fillSlots. If the
    // chain is truly broken, the launch-time resolution throws the
    // operator-facing error instead.
    expect(shouldDeferReviewLaunch(null, 1, [mkTask(2)], () => 'x', limits)).toBe(
      false
    );
  });

  it('launches when the review provider has headroom', () => {
    const active = [mkTask(1), mkTask(2)];
    const resolve = resolverFor({ 1: 'anthropic', 2: 'anthropic' });
    // anthropic limit 3; one foreign holder (task 2) after excluding
    // the transitioning task → 1 < 3.
    expect(
      shouldDeferReviewLaunch('anthropic', 1, active, resolve, limits)
    ).toBe(false);
  });

  it('defers onto a paused provider (limit 0) even with no active tasks', () => {
    expect(shouldDeferReviewLaunch('ollama-b', 1, [], () => null, limits)).toBe(
      true
    );
  });

  it('treats an unknown review provider (row deleted) as unconstrained', () => {
    expect(shouldDeferReviewLaunch('gone', 1, [mkTask(2)], () => 'gone', limits)).toBe(
      false
    );
  });

  it('ignores tasks without a container (parked or queued) in the count', () => {
    // Task 2 is parked in-review with no container on ollama-a — it
    // holds no slot, so task 1's review can launch there.
    const active = [mkTask(1), mkTask(2, null)];
    const resolve = resolverFor({ 1: 'anthropic', 2: 'ollama-a' });
    expect(shouldDeferReviewLaunch('ollama-a', 1, active, resolve, limits)).toBe(
      false
    );
  });
});
