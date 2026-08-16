# Quick Start

From `git clone` to a running orchestrator with a first agent task in ~15
minutes. The compose file is a near-out-of-the-box single-machine package:
it bundles Forgejo, ships zero-touch defaults (all URLs default to `localhost`
+ compose service names — no IP/URL editing), auto-generates the cookie secret
on first boot, and auto-registers webhooks. The only one-time manual step is
creating a Forgejo OAuth app + two tokens. For the full architecture, see
[00 - Architecture Overview](./00-architecture-overview.md).

## Prerequisites

- **Docker** + **Docker Compose** on the host
- **One LLM key** — an **Anthropic API key** for the bootstrap profile (Claude SDK + Sonnet). Other providers (OpenAI, Gemini, Ollama, …) can be added afterwards via Settings without editing files.

No separate Forgejo install — it's bundled in the compose.

## 1. Bring up the bundled Forgejo

```bash
cp .env.example .env
docker compose up -d --build forgejo
```

This starts the bundled Forgejo at **`http://localhost:3000`** (data persists
in the `forgejo-data` volume). Open it, complete the initial install screen
(the defaults are fine), and create your admin account.

> The full `docker compose up -d --build` also works here, but the orchestrator
> will restart-loop until you've added the OAuth credentials from the next step
> — in production it refuses to start without them. Bringing up just `forgejo`
> first keeps the logs clean.

## 2. Create the OAuth app + service-account tokens (one-time)

In the bundled Forgejo at `http://localhost:3000`:

1. Create two service accounts: `orchestrator` and `agent`.
2. For `orchestrator`, generate an API token (scopes `read:user`, `write:repository`, `write:issue`) — used for PR creation, merge, label management, and comments.
3. For `agent`, generate an API token (scope `write:repository`) — used only for `git fetch`/`push` inside agent containers.
4. Create an OAuth2 application (Site Administration > Applications) with redirect URI **`http://localhost:8081/auth/callback`** (exactly — it must match `ORCHESTRATOR_URL` + `/auth/callback`). Record the client ID and secret.
5. Create the scoped labels the orchestrator uses: `status/queued`, `status/in-progress`, `status/in-review`, `status/changes-needed`, `status/failed`, `status/cancelled`, `human-merge`, `human-review`. See [01 - Forgejo Setup](./01-forgejo-setup.md) for the exact label configuration and branch protection.

## 3. Drop the secrets into `.env`

Edit `.env` and fill in **just these** — every URL, `COOKIE_SECRET`, and
`MCP_ENABLED` already have working defaults (see the checklist at the top of
`.env.example`):

- `FORGEJO_ORCHESTRATOR_TOKEN` — from step 2.2
- `FORGEJO_AGENT_TOKEN` — from step 2.3
- `FORGEJO_OAUTH_CLIENT_ID` / `FORGEJO_OAUTH_CLIENT_SECRET` — from step 2.4
- `FORGEJO_WEBHOOK_SECRET` — any random string (`openssl rand -hex 16`)
- `ANTHROPIC_API_KEY` — required for the bootstrap profile. If you'll only use a different provider (e.g. Ollama), leave it blank and switch the default profile after first boot.

You do **not** need to touch `FORGEJO_URL`, `FORGEJO_PUBLIC_URL`,
`ORCHESTRATOR_URL`, `ORCHESTRATOR_INTERNAL_URL`, or `COOKIE_SECRET`:

- The URLs default to `http://localhost:8081`/`http://localhost:3000` (browser-facing) and `http://orchestrator:8080`/`http://forgejo:3000` (container-facing) — correct on any machine, no IP needed.
- `COOKIE_SECRET` auto-generates and persists to `/data/cookie-secret` on first boot in production. Set it explicitly only to control/rotate it yourself.

> **External Forgejo escape hatch:** to use a Forgejo you run elsewhere instead of the bundled one, set `FORGEJO_URL` / `FORGEJO_PUBLIC_URL` in `.env` (`http://host.docker.internal:3000` for a host-run Forgejo on Docker Desktop) and start the orchestrator without the bundled service: `docker compose up -d --no-deps --build orchestrator`.

## 4. Start everything

```bash
docker compose up -d --build
```

**One-shot install:** alternatively `./scripts/install.sh --up` validates the
environment, builds the images, and starts the system in one go.

This single command:

1. Builds the orchestrator image.
2. Builds the agent container image and tags it as `orchestrator-agent:latest` (the image the orchestrator spawns task containers from). This happens via the `agent-image` build-only service in `docker-compose.yml`.
3. Creates the `agent-network` bridge and attaches the bundled `forgejo` to it (so agent containers can `git` against `http://forgejo:3000`).
4. Waits for the agent image build to complete (`depends_on: condition: service_completed_successfully`).
5. Starts Forgejo (if not already up) and the orchestrator.

The agent image isn't a running service — it's just built and tagged. A short-lived `agent-image` container appears in `docker ps -a` after `up`, exited 0; `docker compose down` cleans it up.

Verify after start:

```bash
docker images --filter "reference=orchestrator-agent"
# orchestrator-agent  latest

docker network inspect agent-network --format '{{.Name}}: {{.Driver}}'
# agent-network: bridge
```

To rebuild just the agent image after editing `harness/` or `images/agent/Dockerfile` without restarting the orchestrator:

```bash
docker compose build agent-image
# or the equivalent convenience wrapper:
./scripts/build-agent-images.sh
```

Follow the logs until you see `server_started`:

```bash
docker compose logs -f orchestrator
```

Expected log events:

- `db_ready` — SQLite schema initialized
- `forgejo_connected` — orchestrator talked to Forgejo successfully (needs `FORGEJO_ORCHESTRATOR_TOKEN`)
- `docker_connected` — orchestrator attached to the Docker socket and the `agent-network` bridge is ready
- `server_started`

Open the UI at `http://localhost:8081` and log in via Forgejo OAuth.

## 5. Verify the bootstrap profile

The schema v21 migration auto-seeds the standard cloud providers (Anthropic, OpenAI, Gemini, Mistral, DeepSeek, OpenRouter) with a representative model each, plus a default `Claude SDK + Sonnet` agent profile pointed at Anthropic. `settings.default_agent_profile_id` is set to this profile, so a fresh install with `ANTHROPIC_API_KEY` in `.env` boots into a usable state — no seed script.

Open the UI and confirm:

- **Settings > Providers & Models** — Anthropic should show `models_count: 3` and a green "credential configured" indicator if `ANTHROPIC_API_KEY` is set in `.env`. Other cloud providers are seeded but flagged "missing credential" until you point each one at an env var or paste an inline `auth_token`.
- **Settings > Agent Profiles** — `default-claude-sdk` (harness `claude-sdk`, Anthropic / Claude Sonnet 4.6, timeout 120m) is the only profile.

To add Ollama, llama.cpp/llama-swap, vLLM or another local LLM server, create a new provider with `kind: openai-compatible` and the server's `base_url`, add the loaded models to it, then create a new agent profile pairing the OpenCode or pi harness with one of those models. See [Agents.md](./Agents.md) for the full configuration reference.

## 6. Register a repository

In the UI:

1. **Settings > Repositories > Add Repository**.
2. Select a repo from the dropdown (populated from Forgejo via `/api/repos/available`).
3. Leave `agent_profile_id` blank to inherit the global default, or pick a different profile for this repo. Optionally add one or more install steps from the dropdown (e.g. `npm-ci`, `pnpm-install`, `pip-requirements`). Each step takes an optional `cwd` relative to `/repo`, so monorepos can install in multiple sub-folders. The agent image already ships Node, Python, and Go — no language selection. If your repo needs a custom bootstrap, flip "Allow custom setup scripts" and add a `script` step pointing at a path inside the repo (`bash <path>`); the script inherits the agent container env, so only enable for repos whose committers you trust.
4. Save. The orchestrator will clone the repo into `/workspaces/` on its first task.

The webhook **auto-registers** — on repo add (and on every startup via
`verifyWebhooks`) the orchestrator creates the `${ORCHESTRATOR_INTERNAL_URL}/webhooks/forgejo`
hook with your `FORGEJO_WEBHOOK_SECRET` and the `Issues`, `Issue Comment`, and
`Pull Request` events. No manual webhook step. (You can confirm it under the
repo's **Settings > Webhooks** in Forgejo.)

## 7. Run your first task

Easiest path: open an issue in your Forgejo repo whose body says something trivial like "Add a line `Hello from Agent!` to the end of README.md", then label it `status/queued`. The orchestrator picks it up within one poll cycle (60s) or immediately via webhook.

Track progress in the UI:

- **Dashboard** shows the task move `queued → preparing → in-progress → in-review → merged`.
- **Task Detail** streams the agent's live output and lists each attempt with the snapshotted harness id and model id.
- Forgejo shows the new branch `agent/issue-N-*`, a PR, and an audit-trail comment stream on the issue.

## 8. (Optional) Connect Claude Code via MCP

The orchestrator can expose its task-creation surface as a Model Context Protocol server so developers can create and queue tasks from any project without Forgejo credentials, Docker access, or repo checkouts on their machines. Configuration is OAuth-delegated through the same Forgejo OAuth app the UI uses — no new IdP.

**Operator side:** `MCP_ENABLED` defaults to `1` in the bundled compose, so the
endpoint is already live — nothing to do. To disable it, set `MCP_ENABLED=0` in
`.env`. The HS256 signing key derives from `COOKIE_SECRET` via HKDF when
`MCP_OAUTH_SIGNING_SECRET` is blank (zero-config, equivalent strength); set it
explicitly only to rotate the MCP key independently.

For LAN-exposed deployments, terminate TLS at a reverse proxy and set `ORCHESTRATOR_URL=https://...` — OAuth Authorization Server endpoints require HTTPS off-loopback. Same-host `http://localhost:8081` development works without TLS.

**Developer side (per machine, one-time):**

```bash
# 1. Add this repo as a Claude Code marketplace.
claude plugin marketplace add <git-host>/<owner>/agent-orchestration

# 2. Install the plugin into user scope.
claude plugin install agent-orchestrator@agent-orchestrator

# 3. Configure the orchestrator URL (default http://localhost:8081).
#    /plugin in any Claude Code session → select agent-orchestrator → Configure.
#    It must EXACTLY match the orchestrator's ORCHESTRATOR_URL (scheme, host,
#    port; no trailing slash). After changing it, reconnect a running client
#    (/mcp, or restart the session) for the new value to take effect.
```

First invocation of `/agent-orchestrator:create-task` triggers a browser-delegated OAuth login (Dynamic Client Registration + PKCE, routed through the orchestrator's existing Forgejo login). Claude Code stores and refreshes the resulting bearer token transparently; the developer never sees a credential.

See [13 - MCP Endpoint](./13-mcp-endpoint.md) for the full operator runbook (rotation, revocation, troubleshooting, security model).

## Troubleshooting

- **"Agent profile 'X' not found"** — the repo or task references a profile id that no longer exists. Reassign via Settings > Repositories or Settings > Agent Profiles.
- **"Provider credential missing"** — the active profile's provider has `api_key_env_var` pointing at an env var that isn't set on the orchestrator host. Set it in `.env` and restart, or paste an `auth_token` directly onto the provider row.
- **"Harness X doesn't support kind Y"** at task launch — the profile pairs a harness with a provider kind it can't target. Compatibility is checked at launch (not save) by design; reassign the profile's model to a provider whose kind is in the harness's `supported_provider_kinds`.
- **Container never starts** — check `docker images` for the `orchestrator-agent:latest` image. Check `docker network ls` for `agent-network`. Check orchestrator logs for `docker_connection_failed`.
- **Container runs but agent errors immediately** — exec into the image and run the underlying CLI: `docker run --rm -it orchestrator-agent:latest bash`, then `claude --help`, `opencode --help`, or `pi --help`. If the CLI flags have shifted in a new release, update the matching harness module under `packages/server/src/harnesses/` and rebuild the image.
- **Agent pushes branch but no PR appears** — the orchestrator's Forgejo token may be missing `write:repository`. Check logs for `forgejo_api_error`.
- **Webhook events not arriving** — the hook targets `ORCHESTRATOR_INTERNAL_URL` (default `http://orchestrator:8080`), which must be reachable from the Forgejo container; with the bundled compose both run on the same network, so this works out of the box. Verify the webhook secret matches.

Full operational playbook: [07 - Deployment & Operations](./07-deployment-operations.md).
