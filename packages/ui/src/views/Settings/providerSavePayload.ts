import type {
  ProviderResponse,
  ProviderKindSpec,
  ProviderWriteRequest,
} from '../../api.js';

/** Tri-state for the inline auth_token form control (C1):
 *    - 'keep'  → omit auth_token from the request; the server preserves
 *                the stored value untouched.
 *    - 'set'   → operator is typing a replacement; send the string.
 *    - 'clear' → send null to remove the stored token.
 *  The literal stored value is never shipped to the client, so the form
 *  can't preselect "edit existing"; replacement is always a fresh entry. */
export type AuthTokenMode = 'keep' | 'set' | 'clear';

export interface ProviderSaveInput {
  /** The in-progress provider form state. */
  editing: Partial<ProviderResponse>;
  /** Spec for `editing.kind` — drives required-field and auth-optional
   *  rules. `undefined` only while the kind list is still loading, in
   *  which case the kind-specific checks are skipped. */
  spec: ProviderKindSpec | undefined;
  authTokenMode: AuthTokenMode;
  authTokenDraft: string;
}

export type ProviderSaveResult =
  | { error: string }
  | { payload: ProviderWriteRequest };

/** Pure validation + request-body builder for the Providers form Save.
 *  Extracted from `ProviderSettings` so the credential edge-cases are
 *  unit-testable; the component just maps `error` → setError and
 *  `payload` → the create/update call.
 *
 *  These are client-side mirrors of the server-side ProviderKindSpec
 *  checks in `routes/providers.ts`, so the operator gets immediate
 *  feedback instead of a round-trip 400. The server stays the source of
 *  truth. */
export function buildProviderSavePayload({
  editing,
  spec,
  authTokenMode,
  authTokenDraft,
}: ProviderSaveInput): ProviderSaveResult {
  if (spec?.requires_base_url) {
    const base = (editing.base_url ?? '').trim();
    if (!base) {
      return { error: `base_url is required for ${spec.display_name} providers` };
    }
  }

  const trimmedDraft = authTokenDraft.trim();

  // Empty-token-in-'set'-mode guard. This catches ONLY the "operator
  // clicked Replace on an EXISTING token, then left the box blank" case —
  // hence the `has_auth_token` condition. The error text ("use Clear …")
  // only makes sense when there's a stored value to remove.
  //
  // For a NEW provider row (no stored token) an empty 'set' draft is a
  // legitimate "I'm not entering an inline token" choice: the credential
  // may come from the env-var pointer (cloud kinds) or be unnecessary
  // entirely (Ollama, auth_optional). The form arms every new row in
  // 'set' mode with an empty draft and exposes no Clear/keep affordance
  // there, so without the `has_auth_token` carve-out a new Ollama
  // provider could never be saved despite the field being optional, and
  // a new cloud provider relying solely on `api_key_env_var` hit the same
  // wall. The required-credential check below is the real safety net for
  // "no credential at all".
  if (
    authTokenMode === 'set' &&
    trimmedDraft.length === 0 &&
    editing.has_auth_token
  ) {
    return {
      error:
        'Auth token cannot be empty — use Clear if you want to remove the stored value.',
    };
  }

  if (spec && !spec.auth_optional) {
    // "Will this provider have a credential after the save lands?"
    //   set   → yes iff the draft is non-empty (an empty 'set' draft can
    //           now reach here for a new/no-token row, so the emptiness
    //           check is load-bearing, not redundant)
    //   keep  → yes iff it already had a stored token
    //   clear → no
    const willHaveToken =
      (authTokenMode === 'set' && trimmedDraft.length > 0) ||
      (authTokenMode === 'keep' && !!editing.has_auth_token);
    const willHaveEnv = (editing.api_key_env_var ?? '').trim().length > 0;
    if (!willHaveToken && !willHaveEnv) {
      return {
        error:
          `${spec.display_name} providers require a credential. ` +
          `Set either an inline auth token or an api_key_env_var.`,
      };
    }
  }

  // Build the request payload. `auth_token` is write-only on the wire
  // (C1): include it only when the operator actively entered a value
  // ('set' + non-empty) or explicitly chose to remove it ('clear'). An
  // empty 'set' draft (reachable only for a new/no-token row, per the
  // guard above) and 'keep' both omit the field, so the server preserves
  // / leaves the stored value untouched.
  const payload: ProviderWriteRequest = {
    display_name: editing.display_name,
    kind: editing.kind,
    concurrency_limit: editing.concurrency_limit,
    base_url: editing.base_url,
    api_key_env_var: editing.api_key_env_var,
    notes: editing.notes,
  };
  if (authTokenMode === 'set' && trimmedDraft.length > 0) {
    payload.auth_token = trimmedDraft;
  } else if (authTokenMode === 'clear') {
    payload.auth_token = null;
  }

  return { payload };
}
