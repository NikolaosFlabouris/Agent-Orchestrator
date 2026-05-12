# Quick Start

From zero to a running orchestrator with a first agent task in ~15 minutes.
For the full architecture, see [00 - Architecture Overview](./00-architecture-overview.md).

## Prerequisites

- **Docker** + **Docker Compose** on the orchestrator host
- **Forgejo** reachable from the orchestrator (self-hosted, Gitea-compatible)
- **Anthropic API key** for the bootstrap profile (Claude SDK + Sonnet). Other providers (OpenAI, Gemini, Ollama, …) can be added afterwards via Settings without editing files.

## 1. Forgejo setup

On your Forgejo instance:

1. Create two service accounts: `orchestrator` and `agent`.
2. For `orchestrator`, generate an API token with scopes: `read:user`, `write:repository`, `write:issue`. This token is used for PR creation, merge, label management, and comments.
3. For `agent`, generate an API token with scope: `write:repository`. This token is used only for `git fetch`/`push` inside agent containers.
4. Create an OAuth2 application (Site Administration > Applications) with redirect URI `http://<orchestrator-host>:8081/auth/callback`. Record the client ID and secret.
5. Create the scoped labels the orchestrator uses: `status/queued`, `status/in-progress`, `status/in-review`, `status/changes-needed`, `status/failed`, `status/cancelled`, `human-merge`, `human-review`. See [01 - Forgejo Setup](./01-forgejo-setup.md) for the exact label configuration and branch protection.

## 2. Configure `.env`
 
```bash
cp .env.example .env
```
 
Fill in at minimum:
 
- `FORGEJO_URL` — e.g. `http://192.168.1.10:3000` (must be reachable from inside agent containers, so prefer a LAN IP or hostname that resolves, not `localhost`)
- `FORGEJO_ORCHESTRATOR_TOKEN`
- `FORGEJO_AGENT_TOKEN`
- `FORGEJO_WEBHOOK_SECRET` — any random string; use the same value when registering webhooks in Forgejo
- `FORGEJO_OAUTH_CLIENT_ID` / `FORGEJO_OAUTH_CLIENT_SECRET`
- `ORCHESTRATOR_URL` — e.g. `http://<host>:8081`
- `ANTHROPIC_API_KEY` — required for the bootstrap profile (Claude SDK + Sonnet) the orchestrator seeds on first run. If you'll only use a different provider (e.g. Ollama), you can leave this blank and switch the default profile after first boot.
- `COOKIE_SECRET` — random 32+ byte hex string for production

**One-shot install:** Alternatively, after creating your `.env` file, you can run the following command to validate the environment, build the images, and start the system in one go:

```bash
./scripts/install.sh --up
```

For transparency, the detailed step-by-step sequence follows:

## 3. Start the orchestrator

```bash
docker compose up -d --build
```

This single command:

1. Builds the orchestrator image.
2. Builds the agent container image and tags it as `orchestrator-agent:latest` (the image the orchestrator spawns task containers from). This happens via the `agent-image` build-only service in `docker-compose.yml`.
3. Creates the `agent-network` bridge.
4. Waits for the agent image build to complete (`depends_on: condition: service_completed_successfully`).
5. Starts the orchestrator.

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

Open the UI at `http://<orchestrator-host>:8081`.

## 4. Verify the bootstrap profile

The schema v21 migration auto-seeds the standard cloud providers (Anthropic, OpenAI, Gemini, Mistral, DeepSeek, OpenRouter) with a representative model each, plus a default `Claude SDK + Sonnet` agent profile pointed at Anthropic. `settings.default_agent_profile_id` is set to this profile, so a fresh install with `ANTHROPIC_API_KEY` in `.env` boots into a usable state — no seed script.

Open the UI and confirm:

- **Settings > Providers & Models** — Anthropic should show `models_count: 3` and a green "credential configured" indicator if `ANTHROPIC_API_KEY` is set in `.env`. Other cloud providers are seeded but flagged "missing credential" until you point each one at an env var or paste an inline `auth_token`.
- **Settings > Agent Profiles** — `default-claude-sdk` (harness `claude-sdk`, Anthropic / Claude Sonnet 4.6, timeout 120m) is the only profile.

To add Ollama or another local LLM server, create a new provider with `kind: ollama` and the server's `base_url`, add the loaded models to it, then create a new agent profile pairing the OpenCode or pi harness with one of those models. See [Agents.md](./Agents.md) for the full configuration reference.

## 5. Register a repository

In the UI:

1. **Settings > Repositories > Add Repository**.
2. Select a repo from the dropdown (populated from Forgejo via `/api/repos/available`).
3. Leave `agent_profile_id` blank to inherit the global default, or pick a different profile for this repo. Optionally add one or more install steps from the dropdown (e.g. `npm-ci`, `pnpm-install`, `pip-requirements`). Each step takes an optional `cwd` relative to `/repo`, so monorepos can install in multiple sub-folders. The agent image already ships Node, Python, and Go — no language selection. If your repo needs a custom bootstrap, flip "Allow custom setup scripts" and add a `script` step pointing at a path inside the repo (`bash <path>`); the script inherits the agent container env, so only enable for repos whose committers you trust.
4. Save. The orchestrator will clone the repo into `/workspaces/` on its first task.

Then register a webhook in Forgejo for this repo:

- URL: `<ORCHESTRATOR_URL>/webhooks/forgejo`
- Secret: `<FORGEJO_WEBHOOK_SECRET>` from `.env`
- Events: `Issues`, `Issue Comment`, `Pull Request`

## 6. Run your first task

Easiest path: open an issue in your Forgejo repo whose body says something trivial like "Add a line `Hello from Agent!` to the end of README.md", then label it `status/queued`. The orchestrator picks it up within one poll cycle (60s) or immediately via webhook.

Track progress in the UI:

- **Dashboard** shows the task move `queued → preparing → in-progress → in-review → merged`.
- **Task Detail** streams the agent's live output and lists each attempt with the snapshotted harness id and model id.
- Forgejo shows the new branch `agent/issue-N-*`, a PR, and an audit-trail comment stream on the issue.

## Troubleshooting

- **"Agent profile 'X' not found"** — the repo or task references a profile id that no longer exists. Reassign via Settings > Repositories or Settings > Agent Profiles.
- **"Provider credential missing"** — the active profile's provider has `api_key_env_var` pointing at an env var that isn't set on the orchestrator host. Set it in `.env` and restart, or paste an `auth_token` directly onto the provider row.
- **"Harness X doesn't support kind Y"** at task launch — the profile pairs a harness with a provider kind it can't target. Compatibility is checked at launch (not save) by design; reassign the profile's model to a provider whose kind is in the harness's `supported_provider_kinds`.
- **Container never starts** — check `docker images` for the `orchestrator-agent:latest` image. Check `docker network ls` for `agent-network`. Check orchestrator logs for `docker_connection_failed`.
- **Container runs but agent errors immediately** — exec into the image and run the underlying CLI: `docker run --rm -it orchestrator-agent:latest bash`, then `claude --help`, `opencode --help`, or `pi --help`. If the CLI flags have shifted in a new release, update the matching harness module under `packages/server/src/harnesses/` and rebuild the image.
- **Agent pushes branch but no PR appears** — the orchestrator's Forgejo token may be missing `write:repository`. Check logs for `forgejo_api_error`.
- **Webhook events not arriving** — verify `ORCHESTRATOR_URL` is reachable from the Forgejo host, and that the webhook secret matches.

Full operational playbook: [07 - Deployment & Operations](./07-deployment-operations.md).
