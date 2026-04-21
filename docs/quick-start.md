# Quick Start

From zero to a running orchestrator with a first agent task in ~15 minutes.
For the full architecture, see [00 - Architecture Overview](./00-architecture-overview.md).

## Prerequisites

- **Docker** + **Docker Compose** on the orchestrator host
- **Forgejo** reachable from the orchestrator (self-hosted, Gitea-compatible)
- **Anthropic API key** (if using Claude Agent SDK or Claude Code CLI)
- **Node.js 22** on the host if you plan to run the seed script outside the container

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
- `ANTHROPIC_API_KEY` — only if you'll use Claude-based tools
- `COOKIE_SECRET` — random 32+ byte hex string for production

## 3. Build the agent container images

These images are NOT built by docker-compose (they are pulled on demand by the orchestrator, keyed by each repo's `image_type`). The build script also creates the `agent-network` bridge that `docker compose up` attaches to (declared `external: true` in the compose file). Build them once:

```bash
./scripts/build-agent-images.sh
```

Verify:

```bash
docker images --filter "reference=orchestrator-agent-*"
# orchestrator-agent-base    latest
# orchestrator-agent-node    latest
# orchestrator-agent-python  latest
# orchestrator-agent-go      latest

docker network inspect agent-network --format '{{.Name}}: {{.Driver}}'
# agent-network: bridge
```

Rebuild whenever you change anything under `harness/` or `images/`.

## 4. Start the orchestrator

```bash
docker compose up -d --build
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

## 5. Seed the default agent tools

The `agent_tools` table is empty on a fresh install. Seed the four documented defaults:

```bash
docker compose exec orchestrator node /app/scripts/seed-agent-tools.js
# or, from the host:
npm run seed:tools
```

Tools inserted:

- `claude-agent-sdk` (SDK, Anthropic API)
- `claude-code-cli` (CLI, Anthropic API)
- `opencode-anthropic` (CLI, Anthropic API)
- `opencode-local` (CLI, no auth, local LLM)

Review and adjust in the UI under **Settings > Agent Tools**. Verify each tool's `command_template` matches the flags of the actually-installed version of the CLI inside the image (run `docker run --rm -it orchestrator-agent-base:latest opencode run --help`).

## 6. Register a repository

In the UI:

1. **Settings > Repositories > Add Repository**.
2. Select a repo from the dropdown (populated from Forgejo via `/api/repos/available`).
3. Set `image_type` (node / python / go), `agent_tool` (default for this repo), and optionally a `pre_agent_script` (e.g. `npm ci`).
4. Save. The orchestrator will clone the repo into `/workspaces/` on its first task.

Then register a webhook in Forgejo for this repo:

- URL: `<ORCHESTRATOR_URL>/webhooks/forgejo`
- Secret: `<FORGEJO_WEBHOOK_SECRET>` from `.env`
- Events: `Issues`, `Issue Comment`, `Pull Request`

## 7. Run your first task

Easiest path: open an issue in your Forgejo repo whose body says something trivial like "Add a line `Hello from Agent!` to the end of README.md", then label it `status/queued`. The orchestrator picks it up within one poll cycle (60s) or immediately via webhook.

Track progress in the UI:

- **Dashboard** shows the task move `queued → preparing → in-progress → in-review → merged`.
- **Task Detail** streams the agent's live output and lists each attempt with token/cost usage.
- Forgejo shows the new branch `agent/issue-N-*`, a PR, and an audit-trail comment stream on the issue.

## Troubleshooting

- **"Agent tool 'X' not found"** — you didn't run the seed script, or the repo's `agent_tool` field references an ID that doesn't exist. Seed or edit via the UI.
- **Container never starts** — check `docker images` for the four `orchestrator-agent-*:latest` images. Check `docker network ls` for `agent-network`. Check orchestrator logs for `docker_connection_failed`.
- **Container runs but agent errors immediately** — exec into the image and run the tool manually: `docker run --rm -it orchestrator-agent-base:latest bash` then `opencode --help` or `claude --help`. If the CLI flags differ, update the tool's `command_template` via the UI.
- **Agent pushes branch but no PR appears** — the orchestrator's Forgejo token may be missing `write:repository`. Check logs for `forgejo_api_error`.
- **Webhook events not arriving** — verify `ORCHESTRATOR_URL` is reachable from the Forgejo host, and that the webhook secret matches.

Full operational playbook: [07 - Deployment & Operations](./07-deployment-operations.md).
