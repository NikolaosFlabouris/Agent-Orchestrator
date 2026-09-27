import type {
  HarnessId,
  Provider,
  ProviderKind,
  Model,
  AgentProfile,
  EffortLevel,
} from '@orchestrator/shared';

/** Inputs handed to a harness when building the launch invocation. The
 *  scheduler pre-resolves the (profile → model → provider) chain and
 *  passes only the de-referenced rows to the harness — harnesses don't
 *  touch the DB themselves. */
export interface HarnessInputs {
  profile: AgentProfile;
  model: Model;
  provider: Provider;
  /** Container-side absolute path of the prompt file (typically
   *  `/task/prompt.md`). CLI harnesses must reference this rather than
   *  hardcoding the path so it stays consistent across harnesses. */
  promptFilePath: string;
}

/** A single config file the harness wants written before container
 *  launch. Path is **absolute** inside the agent container, and MUST be
 *  rooted under `/repo/` — that's the only path reachable from the
 *  orchestrator side via the workspace bind mount. The scheduler
 *  creates parent directories as needed and chowns to the agent uid.
 *
 *  Files needed outside /repo (e.g. `~/.pi/agent/models.json`) are not
 *  expressible via this mechanism — there's no orchestrator-side path
 *  to /home/agent in the agent container. Such harnesses must bake the
 *  file creation into their `agent_command` (the in-container shell
 *  runs the printf/mkdir before invoking the binary). See pi.ts for the
 *  worked example. */
export interface HarnessConfigFile {
  path: string;
  content: string;
}

/** What a harness produces. The scheduler stitches this into the meta.json
 *  the in-container harness script reads at boot, plus side-effect files
 *  (config files written into /repo or /home) and env exports. */
export interface HarnessInvocation {
  /** Literal command string for CLI harnesses; the in-container CLI
   *  script bash-executes this. Null for SDK harnesses (the SDK script
   *  reads `meta.model` and runs the SDK call directly). */
  agent_command: string | null;
  /** Files to drop into the container before the agent starts. List form
   *  so harnesses that need multiple (auth + config) can return both.
   *  Empty list when none. Paths are absolute. */
  config_files: HarnessConfigFile[];
  /** Extra env vars beyond the provider credential (which the scheduler
   *  derives from the provider row). Use for harness-specific feature
   *  flags (e.g. `CLAUDE_CODE_USE_BEDROCK=0`). Empty object is fine. */
  extra_env: Record<string, string>;
  /** Container model identifier the harness will pass to its inference
   *  binary or SDK call — typically `model.model_id` for harnesses that
   *  expect a bare ID, or `<provider.kind>/<model.model_id>` for those
   *  that expect a prefix. The harness owns this convention.
   *
   *  Use:
   *    - SDK harnesses: scheduler stamps this into `meta.model` and the
   *      in-container SDK script reads it.
   *    - CLI harnesses: already baked into `agent_command`. The field is
   *      AUDIT-ONLY — it goes into the attempts row's snapshot and the
   *      meta.json for human inspection, but the runtime command doesn't
   *      reference `meta.model` for CLI. */
  resolved_model: string;
  /** Effort level the harness applied, as resolved by
   *  `resolveEffortLevel`. The key is ABSENT (not null) when the profile
   *  left it unset, so an unset invocation is identical to the one built
   *  before the field existed.
   *
   *  Use mirrors `resolved_model`:
   *    - SDK harnesses: scheduler stamps this into `meta.effort_level` and
   *      the in-container SDK script passes it to the SDK call.
   *    - CLI harnesses: already baked into `agent_command`; audit-only.
   *  Either way the scheduler snapshots it onto the attempts row. */
  effort_level?: EffortLevel;
}

/** Whether a harness can honour an orchestrator-managed effort level for
 *  a given provider kind. Unsupported pairs carry an operator-facing
 *  reason, surfaced verbatim by the save-time validator, the launch-time
 *  error, and the Settings UI. */
export type EffortLevelSupport =
  | { supported: true }
  | { supported: false; reason: string };

/** A harness module. One per supported (binary, invocation-shape) pair.
 *  Add a harness by:
 *    1. Adding the id to `HarnessId` and `HARNESS_IDS` in @orchestrator/shared
 *    2. Creating `packages/server/src/harnesses/<id>.ts` exporting a HarnessSpec
 *    3. Importing+registering it in `harnesses/index.ts`
 *    4. Adding a matching React form component for the UI's "Agent profile"
 *       creation flow, keyed off the harness id.
 *    5. Adding a smoke case: static checks in `smoke/static-checks.ts` and at
 *       least one profile or `scripts/harness-smoke.config.json` entry
 *       (see docs/04-agent-harness.md, "Harness smoke test"). */
export interface HarnessSpec {
  id: HarnessId;
  display_name: string;
  /** Whether this harness's runtime is the SDK script or the CLI script. */
  runtime: 'sdk' | 'cli';
  /** Provider kinds this harness can target. Enforced at BOTH
   *  config-save time and task-launch time:
   *    - Save time: `/api/agent-profiles` POST/PATCH calls
   *      `checkHarnessProviderCompatibility` against this list. The
   *      operator sees the error immediately in the Settings UI.
   *    - Launch time: `buildInvocation` re-checks and throws with a
   *      "harness X doesn't support kind Y" message that includes
   *      `profile.id`, `model.model_id`, `provider.id` so on-call
   *      operators can find the offending row without DB lookups.
   *  The launch-time check is the authoritative gate; the save-time
   *  check is the friendly early surface for the same condition. */
  supported_provider_kinds: readonly ProviderKind[];
  /** Build the launch invocation. The runtime context (provider creds,
   *  model id, profile config) is bundled in `inputs`. Throw on
   *  unsupported provider.kind, missing required config, or any other
   *  invariant break. Errors should include profile.id / model.model_id
   *  / provider.id so on-call operators can find the offending profile
   *  without DB lookups. */
  buildInvocation(inputs: HarnessInputs): HarnessInvocation;
  /** Whether `profile.effort_level` can be honoured when this harness
   *  targets `providerKind`. Enforced the same two ways as
   *  `supported_provider_kinds`:
   *    - Save time: `/api/agent-profiles` POST/PATCH rejects a non-null
   *      effort level on an unsupported pair, with `reason`.
   *    - Launch time: `buildInvocation` calls `resolveEffortLevel`, which
   *      re-checks this and throws with the profile/model/provider ids.
   *  Only meaningful for kinds in `supported_provider_kinds`. */
  effortLevelSupport(providerKind: ProviderKind): EffortLevelSupport;
  /** Validate operator-submitted `config_json` for this harness. Called
   *  by the agent_profile API route on save. Throw with a human-readable
   *  message if a knob is malformed (e.g. `max_turns` not a positive
   *  integer). This is well-formedness validation, NOT harness↔provider
   *  compatibility validation — that's `supported_provider_kinds`,
   *  checked separately by the same save-time validator. Default
   *  implementation accepts any object and returns. */
  validateConfig?(config_json: Record<string, unknown>): void;
}
