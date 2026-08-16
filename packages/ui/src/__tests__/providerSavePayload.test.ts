import { describe, it, expect } from 'vitest';
import { buildProviderSavePayload } from '../views/Settings/providerSavePayload.js';
import type { ProviderKindSpec } from '../api.js';

// ---------------------------------------------------------------------------
// Spec fixtures mirroring packages/server/src/providers/kinds.ts
// ---------------------------------------------------------------------------
const SELF_HOSTED_SPEC: ProviderKindSpec = {
  kind: 'openai-compatible',
  display_name: 'OpenAI-compatible (self-hosted)',
  description: '',
  requires_base_url: true,
  container_env_name: 'OPENAI_COMPAT_AUTH_TOKEN',
  auth_optional: true,
};

const OPENAI_SPEC: ProviderKindSpec = {
  kind: 'openai',
  display_name: 'OpenAI',
  description: '',
  requires_base_url: false,
  container_env_name: 'OPENAI_API_KEY',
  auth_optional: false,
};

describe('buildProviderSavePayload — auth-optional (self-hosted)', () => {
  // The reported bug: a new self-hosted provider's auth-token control starts in
  // 'set' mode with an empty draft, and the old guard rejected that before
  // honouring auth_optional, so the row could never be saved.
  it('saves a new auth-optional provider with an empty inline token', () => {
    const result = buildProviderSavePayload({
      editing: {
        id: 'ollama-local',
        display_name: 'Ollama (Local)',
        kind: 'openai-compatible',
        concurrency_limit: 1,
        base_url: 'http://host.docker.internal:11434',
        has_auth_token: false,
        api_key_env_var: 'OPENAI_COMPAT_AUTH_TOKEN',
        notes: null,
      },
      spec: SELF_HOSTED_SPEC,
      authTokenMode: 'set',
      authTokenDraft: '',
    });

    expect('payload' in result).toBe(true);
    if ('payload' in result) {
      // No inline token is sent — the field is omitted, not blanked.
      expect('auth_token' in result.payload).toBe(false);
      expect(result.payload.base_url).toBe('http://host.docker.internal:11434');
      expect(result.payload.api_key_env_var).toBe('OPENAI_COMPAT_AUTH_TOKEN');
    }
  });

  it('still requires base_url for a self-hosted kind', () => {
    const result = buildProviderSavePayload({
      editing: { kind: 'openai-compatible', has_auth_token: false, api_key_env_var: null, base_url: '' },
      spec: SELF_HOSTED_SPEC,
      authTokenMode: 'set',
      authTokenDraft: '',
    });
    expect(result).toEqual({ error: expect.stringContaining('base_url is required') });
  });

  it('sends the trimmed inline token when one is entered', () => {
    const result = buildProviderSavePayload({
      editing: { kind: 'openai-compatible', has_auth_token: false, api_key_env_var: null, base_url: 'http://x:11434' },
      spec: SELF_HOSTED_SPEC,
      authTokenMode: 'set',
      authTokenDraft: '  bearer-secret  ',
    });
    expect('payload' in result && result.payload.auth_token).toBe('bearer-secret');
  });
});

describe('buildProviderSavePayload — the Replace-then-blank guard', () => {
  // The guard's legitimate purpose: catch an operator who clicked Replace
  // on a stored token and then left the box empty. It must still fire —
  // even for an auth-optional kind — because there IS a value to remove.
  it('rejects blanking an existing stored token in set mode', () => {
    const result = buildProviderSavePayload({
      editing: { kind: 'openai-compatible', has_auth_token: true, api_key_env_var: null, base_url: 'http://x:11434' },
      spec: SELF_HOSTED_SPEC,
      authTokenMode: 'set',
      authTokenDraft: '',
    });
    expect(result).toEqual({ error: expect.stringContaining('Auth token cannot be empty') });
  });
});

describe('buildProviderSavePayload — required-auth (cloud) kinds', () => {
  // A sibling of the reported bug: a new cloud provider relying solely on
  // its env-var pointer also started in 'set' mode with an empty draft.
  it('allows a new required-auth provider to rely solely on the env-var pointer', () => {
    const result = buildProviderSavePayload({
      editing: { kind: 'openai', has_auth_token: false, api_key_env_var: 'OPENAI_API_KEY' },
      spec: OPENAI_SPEC,
      authTokenMode: 'set',
      authTokenDraft: '',
    });
    expect('payload' in result).toBe(true);
    if ('payload' in result) expect('auth_token' in result.payload).toBe(false);
  });

  it('rejects a new required-auth provider with neither token nor env var', () => {
    const result = buildProviderSavePayload({
      editing: { kind: 'openai', has_auth_token: false, api_key_env_var: '' },
      spec: OPENAI_SPEC,
      authTokenMode: 'set',
      authTokenDraft: '',
    });
    expect(result).toEqual({ error: expect.stringContaining('require a credential') });
  });
});

describe('buildProviderSavePayload — tri-state payload shaping', () => {
  it('omits auth_token in keep mode so the stored value is preserved', () => {
    const result = buildProviderSavePayload({
      editing: { kind: 'openai-compatible', has_auth_token: true, api_key_env_var: null, base_url: 'http://x:11434' },
      spec: SELF_HOSTED_SPEC,
      authTokenMode: 'keep',
      authTokenDraft: '',
    });
    expect('payload' in result && !('auth_token' in result.payload)).toBe(true);
  });

  it('sends null in clear mode to remove the stored token', () => {
    const result = buildProviderSavePayload({
      editing: { kind: 'openai-compatible', has_auth_token: true, api_key_env_var: null, base_url: 'http://x:11434' },
      spec: SELF_HOSTED_SPEC,
      authTokenMode: 'clear',
      authTokenDraft: '',
    });
    expect('payload' in result && result.payload.auth_token).toBe(null);
  });
});
