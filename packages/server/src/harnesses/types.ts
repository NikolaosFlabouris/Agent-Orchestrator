import type {
  HarnessId,
  Provider,
  ProviderKind,
  Model,
  AgentProfile,
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
}

/** A harness module. One per supported (binary, invocation-shape) pair.
 *  Add a harness by:
 *    1. Adding the id to `HarnessId` and `HARNESS_IDS` in @orchestrator/shared
 *    2. Creating `packages/server/src/harnesses/<id>.ts` exporting a HarnessSpec
 *    3. Importing+registering it in `harnesses/index.ts`
 *    4. Adding a matching React form component for the UI's "Agent profile"
 *       creation flow, keyed off the harness id. */
export interface HarnessSpec {
  id: HarnessId;
  display_name: string;
  /** Whether this harness's runtime is the SDK script or the CLI script. */
  runtime: 'sdk' | 'cli';
  /** Provider kinds this harness can target. The orchestrator does NOT
   *  enforce this at config-save time (operators have agreed E3: no
   *  save-time validation). At launch time, if a profile points at a
   *  provider kind not in this list, `buildInvocation` throws with a
   *  clear "harness X doesn't support kind Y" message — produces a loud
   *  failure rather than the binary crashing with whatever it spits out
   *  for an unsupported provider. */
  supported_provider_kinds: readonly ProviderKind[];
  /** Build the launch invocation. The runtime context (provider creds,
   *  model id, profile config) is bundled in `inputs`. Throw on
   *  unsupported provider.kind, missing required config, or any other
   *  invariant break. Errors should include profile.id / model.model_id
   *  / provider.id so on-call operators can find the offending profile
   *  without DB lookups. */
  buildInvocation(inputs: HarnessInputs): HarnessInvocation;
  /** Validate operator-submitted `config_json` for this harness. Called
   *  by the agent_profile API route on save. Throw with a human-readable
   *  message if a knob is malformed (e.g. `max_turns` not a positive
   *  integer). This is well-formedness validation, NOT harness↔provider
   *  compatibility validation (which is intentionally absent — see
   *  E3). Default implementation accepts any object and returns. */
  validateConfig?(config_json: Record<string, unknown>): void;
}
