import { describe, it, expect } from 'vitest';
import {
  NO_PROVIDER_KEY,
  canLaunchInPool,
  countActiveByProvider,
  limitMapFromProviders,
  resolveProviderKey,
} from '../../scheduler-pools.js';
import type { Task, Provider } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Test fixtures — minimal shapes; cast through `as unknown` to avoid filling
// in fields that these pure helpers don't touch.
// ---------------------------------------------------------------------------

function mkTask(id: number): Task {
  return { id } as unknown as Task;
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
