import { isIP } from 'node:net';
import type {
  AgentProfile,
  HarnessId,
  Model,
  Provider,
} from '@orchestrator/shared';

// ---------------------------------------------------------------------------
// Harness smoke test: case building, cost rule, coverage rule.
//
// Pure functions only — the DB and Docker live behind the interfaces the
// runner is handed, so everything here is unit-testable without either.
// ---------------------------------------------------------------------------

/** One `(harness, provider, model)` combination to smoke-test. Built from
 *  every agent profile in the DB plus the checked-in built-in cases, then
 *  deduplicated on the triple. */
export interface SmokeCase {
  /** `harness|provider|model` — the dedup key. */
  key: string;
  harness_id: HarnessId;
  provider_id: string;
  model_id: string;
  /** Agent profiles that resolved to this triple (empty for a case that
   *  only comes from the built-in config). */
  profile_ids: string[];
  sources: Array<'profile' | 'builtin'>;
  /** Resolved rows. Absent when `resolution_error` is set. */
  profile?: AgentProfile;
  model?: Model;
  provider?: Provider;
  /** Why the (profile →) model → provider chain could not be resolved. */
  resolution_error?: string;
}

/** An entry of `scripts/harness-smoke.config.json`. */
export interface BuiltinCaseConfig {
  harness_id: string;
  provider_id: string;
  model_id: string;
}

/** Read-only view of the orchestrator's configuration. The CLI backs this
 *  with the live DB opened read-only; tests back it with fixtures. */
export interface SmokeConfigSource {
  listProfiles(): AgentProfile[];
  getModel(pk: number): Model | undefined;
  getProvider(id: string): Provider | undefined;
  getModelByProviderAndId(providerId: string, modelId: string): Model | undefined;
}

export function caseKey(harnessId: string, providerId: string, modelId: string): string {
  return `${harnessId}|${providerId}|${modelId}`;
}

/** Placeholder profile for a built-in case, handed to `buildInvocation`
 *  exactly like a real profile. No knobs, no effort level: the harness's
 *  own defaults. */
function builtinProfile(harnessId: HarnessId, model: Model): AgentProfile {
  return {
    id: `smoke-builtin-${harnessId}`,
    display_name: `Smoke built-in (${harnessId})`,
    harness_id: harnessId,
    model_pk: model.id,
    config_json: {},
    timeout_minutes: 10,
    effort_level: null,
  };
}

/** Build the deduplicated case list: every DB profile first (so a
 *  profile's own config — effort level, max_turns — is what gets tested),
 *  then each built-in case whose triple no profile already covers. A
 *  built-in duplicate of a profile case only adds `builtin` to that case's
 *  sources. Throws on a built-in entry naming an unknown harness — that is
 *  a broken config file, i.e. a runner error. */
export function buildCases(
  source: SmokeConfigSource,
  builtins: BuiltinCaseConfig[],
  knownHarnesses: readonly HarnessId[]
): SmokeCase[] {
  const byKey = new Map<string, SmokeCase>();

  for (const profile of source.listProfiles()) {
    const model = source.getModel(profile.model_pk);
    const provider = model ? source.getProvider(model.provider_id) : undefined;
    const providerId = model?.provider_id ?? '?';
    const modelId = model?.model_id ?? `model#${profile.model_pk}`;
    const key = caseKey(profile.harness_id, providerId, modelId);
    const existing = byKey.get(key);
    if (existing) {
      existing.profile_ids.push(profile.id);
      continue;
    }
    const c: SmokeCase = {
      key,
      harness_id: profile.harness_id,
      provider_id: providerId,
      model_id: modelId,
      profile_ids: [profile.id],
      sources: ['profile'],
    };
    if (!model) {
      c.resolution_error = `profile '${profile.id}' references missing model id ${profile.model_pk}`;
    } else if (!provider) {
      c.resolution_error = `model '${model.model_id}' references missing provider '${model.provider_id}'`;
    } else {
      c.profile = profile;
      c.model = model;
      c.provider = provider;
    }
    byKey.set(key, c);
  }

  for (const b of builtins) {
    if (!knownHarnesses.includes(b.harness_id as HarnessId)) {
      throw new Error(
        `Built-in smoke case names unknown harness '${b.harness_id}' ` +
        `(known: ${knownHarnesses.join(', ')}).`
      );
    }
    const harnessId = b.harness_id as HarnessId;
    const key = caseKey(harnessId, b.provider_id, b.model_id);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.sources.includes('builtin')) existing.sources.push('builtin');
      continue;
    }
    const c: SmokeCase = {
      key,
      harness_id: harnessId,
      provider_id: b.provider_id,
      model_id: b.model_id,
      profile_ids: [],
      sources: ['builtin'],
    };
    const provider = source.getProvider(b.provider_id);
    const model = provider
      ? source.getModelByProviderAndId(b.provider_id, b.model_id)
      : undefined;
    if (!provider) {
      c.resolution_error = `provider '${b.provider_id}' is not configured`;
    } else if (!model) {
      c.resolution_error = `model '${b.model_id}' is not configured on provider '${b.provider_id}'`;
    } else {
      c.profile = builtinProfile(harnessId, model);
      c.model = model;
      c.provider = provider;
    }
    byKey.set(key, c);
  }

  return [...byKey.values()];
}

/** Validate the parsed built-in config file. Throws with a readable
 *  message on a malformed file (a runner error). */
export function parseBuiltinConfig(raw: unknown): BuiltinCaseConfig[] {
  const cases = (raw as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(cases)) {
    throw new Error('smoke config must be an object with a "cases" array');
  }
  return cases.map((c, i) => {
    const e = c as Record<string, unknown>;
    for (const k of ['harness_id', 'provider_id', 'model_id']) {
      if (typeof e?.[k] !== 'string' || (e[k] as string).length === 0) {
        throw new Error(`smoke config cases[${i}].${k} must be a non-empty string`);
      }
    }
    return {
      harness_id: e.harness_id as string,
      provider_id: e.provider_id as string,
      model_id: e.model_id as string,
    };
  });
}

/** Coverage rule: every registered harness needs at least one case, so a
 *  new harness cannot ship without a smoke case. Returns the uncovered
 *  harness ids (empty = rule satisfied). */
export function findUncoveredHarnesses(
  harnessIds: readonly HarnessId[],
  cases: SmokeCase[]
): HarnessId[] {
  const covered = new Set(cases.map((c) => c.harness_id));
  return harnessIds.filter((h) => !covered.has(h));
}

// ---------------------------------------------------------------------------
// Cost rule
// ---------------------------------------------------------------------------

export type CostDecision =
  | { live: true; route: 'subscription' | 'local' }
  | { live: false; reason: 'paid_provider' };

/** Whether a smoke case may make a live model call. Only a subscription
 *  (flat-rate) or a local (free) endpoint qualifies; every pay-per-use
 *  kind — and any openai-compatible endpoint that isn't provably local —
 *  gets static checks only. Deliberately fail-closed: an unparsable or
 *  missing base_url counts as paid. */
export function decideCost(provider: Pick<Provider, 'kind' | 'base_url'>): CostDecision {
  if (provider.kind === 'claude-subscription') {
    return { live: true, route: 'subscription' };
  }
  if (provider.kind === 'openai-compatible' && provider.base_url) {
    let host: string;
    try {
      host = new URL(provider.base_url).hostname;
    } catch {
      return { live: false, reason: 'paid_provider' };
    }
    if (isLocalHost(host)) return { live: true, route: 'local' };
  }
  return { live: false, reason: 'paid_provider' };
}

/** Loopback, RFC1918, link-local, `host.docker.internal`, or a single-label
 *  name (a Docker container / compose service such as `llama-swap`). */
export function isLocalHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '') return false;
  if (host === 'localhost' || host === 'host.docker.internal') return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (ipVersion === 6) {
    if (host === '::1') return true;
    // fe80::/10 link-local.
    return /^fe[89ab][0-9a-f]:/.test(host);
  }
  // A dotless name only resolves inside Docker's embedded DNS (or
  // /etc/hosts) — never a public endpoint.
  return !host.includes('.');
}
