import { describe, it, expect } from 'vitest';
import {
  NO_PROVIDER_KEY,
  canLaunchInPool,
  countActiveByProvider,
  limitMapFromProviders,
  resolveProviderKey,
} from '../../scheduler-pools.js';
import type { Task, AgentTool, Provider } from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Test fixtures — minimal shapes; cast through `as unknown` to avoid filling
// in fields that these pure helpers don't touch.
// ---------------------------------------------------------------------------

function mkTool(id: string, provider: string | null): AgentTool {
  return { id, provider_id: provider } as unknown as AgentTool;
}
function mkTask(id: number): Task {
  return { id } as unknown as Task;
}
function mkProvider(id: string, limit: number): Provider {
  return { id, display_name: id, concurrency_limit: limit, notes: null };
}

// ---------------------------------------------------------------------------

describe('resolveProviderKey', () => {
  it('returns the tool provider_id when set', () => {
    expect(resolveProviderKey(mkTask(1), mkTool('t', 'ollama-a'), undefined)).toBe(
      'ollama-a'
    );
  });
  it('returns NO_PROVIDER_KEY when tool provider_id is null', () => {
    expect(resolveProviderKey(mkTask(1), mkTool('t', null), undefined)).toBe(
      NO_PROVIDER_KEY
    );
  });
  it('returns NO_PROVIDER_KEY when the tool itself is missing', () => {
    expect(resolveProviderKey(mkTask(1), undefined, undefined)).toBe(
      NO_PROVIDER_KEY
    );
  });
});

describe('countActiveByProvider', () => {
  it('buckets tasks by their tool.provider_id', () => {
    const tasks = [mkTask(1), mkTask(2), mkTask(3), mkTask(4)];
    const toolByTask: Record<number, AgentTool> = {
      1: mkTool('claude', 'anthropic'),
      2: mkTool('claude', 'anthropic'),
      3: mkTool('ollama', 'ollama-a'),
      4: mkTool('ollama-local', null),
    };
    const counts = countActiveByProvider(
      tasks,
      (t) => toolByTask[t.id],
      () => undefined
    );
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

  it('blocks when the global ceiling is 0', () => {
    expect(canLaunchInPool('anthropic', new Map(), limits, 0)).toBe(false);
  });

  it('allows when provider has headroom and global remains', () => {
    expect(canLaunchInPool('anthropic', new Map([['anthropic', 1]]), limits, 5)).toBe(true);
  });

  it('blocks when provider is at its limit', () => {
    expect(canLaunchInPool('ollama-a', new Map([['ollama-a', 1]]), limits, 5)).toBe(false);
  });

  it('treats a provider with limit=0 as paused (no launches)', () => {
    expect(canLaunchInPool('ollama-b', new Map(), limits, 5)).toBe(false);
  });

  it('treats NO_PROVIDER_KEY as subject to global only', () => {
    expect(canLaunchInPool(NO_PROVIDER_KEY, new Map([[NO_PROVIDER_KEY, 100]]), limits, 5)).toBe(true);
    expect(canLaunchInPool(NO_PROVIDER_KEY, new Map(), limits, 0)).toBe(false);
  });

  it('treats an unknown provider key (row deleted) as unlimited within global', () => {
    // After ON DELETE SET NULL, tools lose their provider_id — but between
    // the migration dropping the row and the tool row cache refreshing, a
    // task might still reference the old provider. Don't block it; the
    // global ceiling is the safety net.
    expect(canLaunchInPool('gone', new Map(), limits, 5)).toBe(true);
  });
});
