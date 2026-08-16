import { describe, it, expect } from 'vitest';
import {
  checkHarnessProviderCompatibility,
  getHarness,
  listHarnesses,
} from '../../harnesses/index.js';
import {
  HARNESS_IDS,
  PROVIDER_KINDS,
  type HarnessId,
  type ProviderKind,
} from '@orchestrator/shared';

describe('checkHarnessProviderCompatibility', () => {
  it('accepts an exact match from supported_provider_kinds', () => {
    const sdk = getHarness('claude-sdk');
    expect(checkHarnessProviderCompatibility(sdk, 'anthropic')).toEqual({
      ok: true,
    });
  });

  it('rejects a kind not in the harness allowlist with an actionable message', () => {
    const sdk = getHarness('claude-sdk');
    const result = checkHarnessProviderCompatibility(sdk, 'openai');
    expect(result.ok).toBe(false);
    if (result.ok) return; // type narrowing for the next assertions
    expect(result.error).toContain("Harness 'claude-sdk'");
    expect(result.error).toContain("'openai'");
    // Lists the supported kinds so the operator can fix it directly.
    expect(result.error).toContain('anthropic');
    // Hints at the resolution path.
    expect(result.error).toMatch(/different model|different harness/);
  });
});

// ---------------------------------------------------------------------------
// Per-harness verification — protects against silent drift if anyone edits
// a `supported_provider_kinds` tuple without auditing the buildInvocation
// implementation. These are the canonical compatibility expectations.
// ---------------------------------------------------------------------------

const EXPECTED_COMPAT: Record<HarnessId, ProviderKind[]> = {
  // SDK speaks the Anthropic API directly; no OAuth path; no
  // non-Anthropic providers.
  'claude-sdk': ['anthropic'],

  // CLI supports API key (--bare path) and OAuth subscription
  // (CLAUDE_CODE_OAUTH_TOKEN). No non-Anthropic providers.
  'claude-code': ['anthropic', 'claude-subscription'],

  // OpenCode auto-detects standard env vars for each cloud kind
  // (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) and writes a custom
  // opencode.json for self-hosted endpoints. No native Anthropic-OAuth path so
  // claude-subscription is excluded.
  'opencode': [
    'anthropic',
    'openai',
    'gemini',
    'mistral',
    'deepseek',
    'openrouter',
    'openai-compatible',
  ],

  // Pi has built-in support for every standard cloud kind we
  // expose via PROVIDER_KINDS (anthropic, openai, gemini, mistral,
  // deepseek, openrouter) plus a custom-provider stanza for
  // openai-compatible endpoints.
  // The pi-side provider name differs from the orchestrator kind in
  // one case (gemini → "google") — see PI_PROVIDER_NAMES in pi.ts.
  // claude-subscription is excluded because pi's subscription auth
  // uses an interactive /login OAuth flow incompatible with sealed
  // agent containers.
  'pi': [
    'anthropic',
    'openai',
    'gemini',
    'mistral',
    'deepseek',
    'openrouter',
    'openai-compatible',
  ],
};

describe('harness compatibility lists', () => {
  it('every registered harness has an entry in EXPECTED_COMPAT', () => {
    // Belt-and-braces: if a harness is added to the registry without
    // updating this test, the test fails first.
    for (const id of HARNESS_IDS) {
      expect(EXPECTED_COMPAT[id], `missing EXPECTED_COMPAT for ${id}`).toBeDefined();
    }
    expect(listHarnesses()).toHaveLength(HARNESS_IDS.length);
  });

  for (const id of HARNESS_IDS) {
    describe(id, () => {
      it('declares the expected supported_provider_kinds tuple', () => {
        const spec = getHarness(id);
        // Sort both sides — set semantics, not list order.
        const declared = [...spec.supported_provider_kinds].sort();
        const expected = [...EXPECTED_COMPAT[id]].sort();
        expect(declared).toEqual(expected);
      });

      it('accepts each expected kind', () => {
        const spec = getHarness(id);
        for (const kind of EXPECTED_COMPAT[id]) {
          expect(
            checkHarnessProviderCompatibility(spec, kind),
            `${id} should accept ${kind}`
          ).toEqual({ ok: true });
        }
      });

      it('rejects every other ProviderKind', () => {
        const spec = getHarness(id);
        const supported = new Set(EXPECTED_COMPAT[id]);
        for (const kind of PROVIDER_KINDS) {
          if (supported.has(kind)) continue;
          const result = checkHarnessProviderCompatibility(spec, kind);
          expect(result.ok, `${id} should reject ${kind}`).toBe(false);
        }
      });
    });
  }
});
