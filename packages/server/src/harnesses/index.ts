import type { HarnessId, ProviderKind } from '@orchestrator/shared';
import type { HarnessSpec } from './types.js';
import { claudeSdkHarness } from './claude-sdk.js';
import { claudeCodeHarness } from './claude-code.js';
import { opencodeHarness } from './opencode.js';
import { piHarness } from './pi.js';

/** Code-defined harness registry. Adding a harness is a code change —
 *  there's no DB-side registration. Each spec carries its supported
 *  provider kinds, runtime type (sdk vs cli), and the function that
 *  builds the launch invocation from a (profile, model, provider) tuple.
 *
 *  Order matters only for UI presentation (the order new operators see
 *  in the harness dropdown). */
const REGISTRY: Record<HarnessId, HarnessSpec> = {
  'claude-sdk': claudeSdkHarness,
  'claude-code': claudeCodeHarness,
  'opencode': opencodeHarness,
  'pi': piHarness,
};

export function getHarness(id: HarnessId): HarnessSpec {
  const spec = REGISTRY[id];
  if (!spec) {
    throw new Error(
      `Unknown harness id '${id}'. Adding a harness requires a code change ` +
      `(see packages/server/src/harnesses/types.ts).`
    );
  }
  return spec;
}

export function listHarnesses(): HarnessSpec[] {
  return Object.values(REGISTRY);
}

/** Save-time check for whether a (harness, provider kind) pair is
 *  supported. Returns `{ ok: true }` when the harness module declares
 *  the kind in its `supported_provider_kinds` tuple, or `{ ok: false,
 *  error }` otherwise with a human-readable explanation.
 *
 *  This is the same allowlist `buildInvocation` enforces at launch
 *  time — exposing it here lets the agent-profile create/update routes
 *  surface the error to the operator at save time (M2), instead of
 *  the failure only appearing when a task using the misconfigured
 *  profile is dispatched.
 *
 *  The source of truth remains each harness module's own tuple; this
 *  function is a thin re-check at a different point in the lifecycle. */
export function checkHarnessProviderCompatibility(
  harness: HarnessSpec,
  providerKind: ProviderKind
): { ok: true } | { ok: false; error: string } {
  if (harness.supported_provider_kinds.includes(providerKind)) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      `Harness '${harness.id}' does not support provider kind ` +
      `'${providerKind}'. Supported kinds for this harness: ` +
      `${harness.supported_provider_kinds.join(', ')}. Pick a different ` +
      `model (on a compatible provider) or a different harness.`,
  };
}

export type {
  HarnessSpec,
  HarnessInputs,
  HarnessInvocation,
  HarnessConfigFile,
} from './types.js';
