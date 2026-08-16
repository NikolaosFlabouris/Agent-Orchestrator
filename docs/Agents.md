# Agent Profiles, Harnesses, Providers & Models

The orchestrator launches LLM-powered programs inside ephemeral Docker
containers. The configuration that drives a launch is composed from three
first-class concepts the operator manages, plus a fourth that's
code-defined.

## Concepts

- **Provider** — the connection identity for an LLM endpoint. A row in
  the `providers` table carries a `kind` (`anthropic`, `openai`,
  `gemini`, `mistral`, `deepseek`, `openrouter`, `claude-subscription`,
  `openai-compatible`), an optional `base_url` (required for
  `openai-compatible`), a
  `concurrency_limit`, and exactly one of `api_key_env_var` (env-var
  pointer the orchestrator dereferences from its own `.env`) or
  `auth_token` (inline plaintext, useful for self-hosted servers and for
  multi-instancing a cloud kind). Cloud kinds are typically singletons;
  Ollama is multi-instance (one row per server).
- **Model** — a `(provider_id, model_id, display_name)` triple under a
  surrogate primary key. Models are scoped to providers, so the same
  `model_id` (e.g. `claude-sonnet-4-6`) can exist under multiple
  providers as separate rows.
- **Agent profile** — the operator-composed pairing tasks reference. A
  profile names a `harness_id`, a `model_pk`, a `config_json` blob the
  harness understands, and a wall-clock `timeout_minutes`.
- **Harness** — the in-container program that runs the agent. Harnesses
  are **code-defined** (`packages/server/src/harnesses/*.ts`); operators
  pick from the four shipped harnesses but can't author their own
  through the UI. Each harness declares which provider kinds it supports
  and how to build its launch invocation from `(profile, model,
  provider)`.

## Resolution chain

Each workflow stage resolves its own profile. The implementation
(develop) stage walks:

```
tasks.agent_profile_id
  ↳ repos.agent_profile_id
      ↳ settings.default_agent_profile_id
```

The review stage walks its own chain first and falls back to the
implementation chain when no review profile is configured at any tier
— so installs that never set a review profile review with the same
profile that implemented:

```
tasks.review_agent_profile_id
  ↳ repos.review_agent_profile_id
      ↳ settings.default_review_agent_profile_id
          ↳ <the implementation chain above>
```

The chains are stage-independent: a task-level implementation override
does NOT pin the review stage — a global review default still wins for
review. This is what makes the "cheap local model implements, strong
cloud model reviews" split a set-and-forget policy.

The scheduler then walks `profile → models[model_pk] → providers[provider_id]`,
calls `harness.buildInvocation` to produce
`{ agent_command, config_files, extra_env, resolved_model }`, and writes
that into the container's `meta.json` along with snapshots of
`harness_id` and `agent_profile_id` for audit.

Provider concurrency accounting is stage-aware: a task in `in-review`
counts against its review profile's provider pool. When a dev run
finishes and the review profile's provider is at its concurrency
limit, the review is parked (status `in-review`, no container) and
launched by the scheduler once a slot frees, instead of oversubscribing
the provider.

## Shipped harnesses

| Harness id | Runtime | Supported provider kinds |
|---|---|---|
| `claude-sdk` | sdk | `anthropic` |
| `claude-code` | cli | `anthropic`, `claude-subscription` |
| `opencode` | cli | `anthropic`, `openai`, `gemini`, `mistral`, `deepseek`, `openrouter`, `openai-compatible` |
| `pi` | cli | `anthropic`, `openai`, `gemini`, `mistral`, `deepseek`, `openrouter`, `openai-compatible` |

Harness↔provider compatibility is checked at **both** profile-save
time and task-launch time. The save-time check (in the
`/api/agent-profiles` POST/PATCH validator) is the friendly early
surface: pairing a harness with an unsupported provider kind in the
Settings UI rejects with a clear "harness X doesn't support kind Y"
message before the profile is persisted. The launch-time check (in
`buildInvocation`) stays as the authoritative gate, defending against
configurations that snuck past the save-time check (e.g. an operator
swapping a model row's provider out from under a live profile via a
direct DB edit). Save-time also runs the compatibility check **before**
per-harness `validateConfig`, since a categorical mismatch is the
higher-signal error.

Adding a new harness is a code change — see
[04 - Agent Harness, Profiles, Providers & Models](./04-agent-harness.md#adding-a-new-harness).

## How to configure

Everything below is on the **Settings** page in the web UI.

### Providers & Models tab

Add a provider row per LLM endpoint you'll use. Cloud providers (Anthropic,
OpenAI, …) typically need just an `api_key_env_var` (e.g.
`ANTHROPIC_API_KEY`) — drop the value into the orchestrator's `.env` and
restart. Ollama needs a `base_url` (e.g. `http://192.168.1.50:11434`).

Under each provider, add the models you want to expose (`model_id` +
`display_name`). The `model_id` must match what the inference endpoint
expects, without provider prefix — harnesses that need
`<provider>/<model>` form prefix at launch.

The v21 bootstrap seeds the standard cloud providers with reasonable
defaults plus a representative set of models. Operators add Ollama
themselves; they remove or extend the seeded list to match the team's
actual usage.

### Agent Profiles tab

Compose a profile by picking a harness, a model (the picker is scoped to
that harness's `supported_provider_kinds`), and any per-harness config.
The form's `config_json` editor changes per harness — harnesses with no
operator-tunable knobs render an empty form.

`timeout_minutes` defaults to 2880 (48h) for new profiles and 120 (2h)
for the bootstrap profile. Typical values: 120 for paid APIs to cap
token-burn on a runaway agent, 2880 for free local servers where a slow
generation is cheap.

### Repositories tab

Each repo points at a default implementation `agent_profile_id`. Leave
it blank to inherit the global default from Global Settings. A repo can
also set a `review_agent_profile_id` for the review stage — blank means
inherit the global review default, then the implementation profile.

### Global Settings tab

`default_agent_profile_id` is the fallback when neither the task nor the
repo specifies a profile. Set on first-run by the v21 bootstrap (to
`default-claude-sdk`); change it via this tab.

`default_review_agent_profile_id` is the review-stage counterpart.
Unset by default — reviews then run with the implementation profile.
Set it to route every automated review to a specific (typically
stronger) profile regardless of which profile implements.

## Provider credentials

Secrets live one of two places:

1. **`.env` on the orchestrator host** — pointed at by the provider's
   `api_key_env_var` field. The orchestrator reads from its own env at
   launch and exports the value into the agent container under the
   kind's standard name (e.g. `ANTHROPIC_API_KEY` for `kind=anthropic`,
   regardless of what the env var on the orchestrator side is called).
   This is the recommended path; `.env` is gitignored and Docker volumes
   mount it as a known sensitive file.
2. **Inline `auth_token` on the provider row** — stored as plaintext in
   the SQLite DB. Useful for multi-instancing a kind (e.g. two Ollama
   servers, each with their own basic-auth token) or for two
   accounts on the same cloud kind. Database backups contain these
   values; treat the SQLite file as sensitive.

Whichever path is used, only the credential for the *active* provider
gets exported into the container. There is no list of "all known LLM
keys forwarded everywhere" — adding a credential is a UI action against
a specific provider row.

The **Settings → Credentials** tab shows which orchestrator-only env
vars (`FORGEJO_*`, `ORCHESTRATOR_URL`, `COOKIE_SECRET`) are set. Provider
credentials are configured per-provider on the Providers & Models tab,
so they don't appear here.

## Network access from containers

Agent containers run on the `agent-network` Docker bridge with full
outbound access. To reach services on the host machine (e.g. Ollama
running on the Docker host), use `host.docker.internal` instead of
`localhost` in the provider's `base_url`.
