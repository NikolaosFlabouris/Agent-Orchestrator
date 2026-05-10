import type { HarnessId } from '@orchestrator/shared';
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

export type {
  HarnessSpec,
  HarnessInputs,
  HarnessInvocation,
  HarnessConfigFile,
} from './types.js';
