import { describe, it, expect } from 'vitest';
import {
  validateRepoAgentProfile,
  validateRepoMergeStrategy,
  validateRepoContainerResource,
} from '../../routes/repos.js';

/** Unit-level coverage for the repos-route validators (R3).
 *
 *  The routes themselves aren't covered by the Fastify-inject suite
 *  (routes.test.ts) because they require a ForgejoClient stub for the
 *  webhook-register / issue-listing paths. The three exported helpers
 *  contain all the operator-input validation logic, so testing them
 *  directly closes the equivalent coverage gap.
 *
 *  Each helper takes raw `unknown` input (route body) and returns
 *  either `{ ok: true, value }` or `{ ok: false, error }`. Tests
 *  assert both the success normalisation and the rejection cases.
 */

describe('validateRepoAgentProfile', () => {
  // Stub lookup function — accepts only 'existing-id' as a valid profile.
  // Default-arg uses the real `getAgentProfile`; passing this stub lets
  // us avoid spinning up an in-memory DB for these tests.
  const lookup = (id: string) => (id === 'existing-id' ? { id } : undefined);

  it('treats undefined as null (inherit)', () => {
    expect(validateRepoAgentProfile(undefined, lookup)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('treats null as null (inherit)', () => {
    expect(validateRepoAgentProfile(null, lookup)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('treats empty string and whitespace as null (inherit)', () => {
    expect(validateRepoAgentProfile('', lookup)).toEqual({
      ok: true,
      value: null,
    });
    expect(validateRepoAgentProfile('   ', lookup)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('accepts a known profile id and trims surrounding whitespace', () => {
    expect(validateRepoAgentProfile('existing-id', lookup)).toEqual({
      ok: true,
      value: 'existing-id',
    });
    expect(validateRepoAgentProfile('  existing-id  ', lookup)).toEqual({
      ok: true,
      value: 'existing-id',
    });
  });

  it('rejects a non-string with a clear message', () => {
    const result = validateRepoAgentProfile(42, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/string or null/);
  });

  it('rejects a string that does not reference an existing profile', () => {
    const result = validateRepoAgentProfile('does-not-exist', lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/does-not-exist/);
      expect(result.error).toMatch(/does not reference/);
    }
  });

  it('names the supplied field in error messages (review default)', () => {
    const wrongType = validateRepoAgentProfile(
      42,
      lookup,
      'review_agent_profile_id'
    );
    expect(wrongType).toEqual({
      ok: false,
      error: 'review_agent_profile_id must be a string or null',
    });
    const dangling = validateRepoAgentProfile(
      'does-not-exist',
      lookup,
      'review_agent_profile_id'
    );
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) {
      expect(dangling.error).toMatch(/^review_agent_profile_id 'does-not-exist'/);
    }
  });
});

describe('validateRepoMergeStrategy', () => {
  it('defaults absent/null/empty to "squash" (R1)', () => {
    expect(validateRepoMergeStrategy(undefined)).toEqual({
      ok: true,
      value: 'squash',
    });
    expect(validateRepoMergeStrategy(null)).toEqual({
      ok: true,
      value: 'squash',
    });
    expect(validateRepoMergeStrategy('')).toEqual({
      ok: true,
      value: 'squash',
    });
  });

  it('accepts each of the three allowed values', () => {
    expect(validateRepoMergeStrategy('squash')).toEqual({
      ok: true,
      value: 'squash',
    });
    expect(validateRepoMergeStrategy('merge')).toEqual({
      ok: true,
      value: 'merge',
    });
    expect(validateRepoMergeStrategy('rebase')).toEqual({
      ok: true,
      value: 'rebase',
    });
  });

  it('rejects an unknown string with the allowlist in the error', () => {
    const result = validateRepoMergeStrategy('squash-everything');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/squash/);
      expect(result.error).toMatch(/merge/);
      expect(result.error).toMatch(/rebase/);
    }
  });

  it('rejects non-string values', () => {
    expect(validateRepoMergeStrategy(1).ok).toBe(false);
    expect(validateRepoMergeStrategy({ kind: 'squash' }).ok).toBe(false);
    expect(validateRepoMergeStrategy([]).ok).toBe(false);
  });

  it('rejects forgejo-internal strategy names that are not operator-selectable', () => {
    // The runtime resolver in merge-strategy.ts can produce
    // 'rebase-merge' and 'fast-forward-only' as fallback values when
    // none of the three preferred strategies is allowed by Forgejo,
    // but operators never store those directly on the repo row. R1
    // closes the loop by rejecting them at save time too.
    const rebaseMerge = validateRepoMergeStrategy('rebase-merge');
    const ffOnly = validateRepoMergeStrategy('fast-forward-only');
    expect(rebaseMerge.ok).toBe(false);
    expect(ffOnly.ok).toBe(false);
  });
});

describe('validateRepoContainerResource', () => {
  it('treats absent/null/empty as null (use orchestrator default) (R2)', () => {
    expect(
      validateRepoContainerResource(undefined, 'container_memory_mb')
    ).toEqual({ ok: true, value: null });
    expect(
      validateRepoContainerResource(null, 'container_memory_mb')
    ).toEqual({ ok: true, value: null });
    expect(
      validateRepoContainerResource('', 'container_memory_mb')
    ).toEqual({ ok: true, value: null });
  });

  it('accepts positive integers and JSON-stringified positive integers', () => {
    expect(
      validateRepoContainerResource(4096, 'container_memory_mb')
    ).toEqual({ ok: true, value: 4096 });
    expect(
      validateRepoContainerResource('4096', 'container_memory_mb')
    ).toEqual({ ok: true, value: 4096 });
  });

  it('rejects zero (would either pause the repo or trip Docker)', () => {
    const result = validateRepoContainerResource(0, 'container_memory_mb');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/positive integer/);
  });

  it('rejects negative values', () => {
    const result = validateRepoContainerResource(-1, 'container_cpu_cores');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/container_cpu_cores/);
  });

  it('rejects non-integer numbers', () => {
    const result = validateRepoContainerResource(1.5, 'container_memory_mb');
    expect(result.ok).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    const result = validateRepoContainerResource(
      'lots',
      'container_memory_mb'
    );
    expect(result.ok).toBe(false);
  });

  it('interpolates the label into the error so a 400 surfaces which field tripped', () => {
    const memoryErr = validateRepoContainerResource(
      -1,
      'container_memory_mb'
    );
    const cpuErr = validateRepoContainerResource(-1, 'container_cpu_cores');
    expect(memoryErr.ok).toBe(false);
    expect(cpuErr.ok).toBe(false);
    if (!memoryErr.ok) expect(memoryErr.error).toMatch(/container_memory_mb/);
    if (!cpuErr.ok) expect(cpuErr.error).toMatch(/container_cpu_cores/);
  });
});
